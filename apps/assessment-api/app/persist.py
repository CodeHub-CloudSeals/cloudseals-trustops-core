"""Write-through persistence of Store state via SQLAlchemy: SQLite (dev) or Aurora PostgreSQL (AWS).

This is a single-writer snapshot design (one `state` row, optimistic version check). It is durable and restart-safe,
but NOT horizontally scalable: run one API task until the normalised repository (db/migrations/002) replaces it.
"""
from __future__ import annotations

import json
import os
from typing import Any, Optional

from sqlalchemy import Column, Integer, MetaData, Table, Text, create_engine, select, update
from sqlalchemy.engine import URL, Engine

from .store import Store

TUPLE_KEYED = {"answers", "idempotency"}
FIELDS = ["users", "tenants", "assessments", "answers", "revisions", "evidence", "findings", "reports", "blueprints",
          "idempotency", "registrations", "events", "audit", "invitations", "assignments", "engagements", "rate", "outbox",
          "not_assessed", "admin_bootstrap", "workflow_runs", "action_tokens", "runtime_evidence", "mock_sap"]
META = MetaData()
STATE = Table("state", META, Column("id", Integer, primary_key=True), Column("version", Integer, nullable=False),
              Column("body", Text, nullable=False))


class PersistConflict(RuntimeError):
    """Another writer changed the state row; local state was reloaded and the request should be retried."""


_engines: dict[str, Engine] = {}
_versions: dict[str, int] = {}


def url_from_env(sqlite_path: Optional[str] = None) -> Optional[str | URL]:
    if os.environ.get("TAAD_DB_HOST"):
        return URL.create("postgresql+psycopg", username=os.environ["TAAD_DB_USER"], password=os.environ["TAAD_DB_PASSWORD"],
                          host=os.environ["TAAD_DB_HOST"], database=os.environ.get("TAAD_DB_NAME", "taad"),
                          query={"sslmode": "require"})
    if os.environ.get("TAAD_DATABASE_URL"):
        return os.environ["TAAD_DATABASE_URL"]
    if sqlite_path:
        return f"sqlite:///{sqlite_path}"
    return None


def enabled() -> bool:
    return url_from_env(os.environ.get("TAAD_DB")) is not None


def _engine(target: str | URL) -> Engine:
    key = str(target)
    if key not in _engines:
        _engines[key] = create_engine(target, pool_pre_ping=True)
        META.create_all(_engines[key])
    return _engines[key]


def _enc(name: str, v: Any) -> Any:
    return [[list(k), val] for k, val in v.items()] if name in TUPLE_KEYED else v


def _dec(name: str, v: Any) -> Any:
    return {tuple(k): val for k, val in v} if name in TUPLE_KEYED else v


def _apply(store: Store, body: str) -> None:
    data = json.loads(body)
    with store.lock:
        for f, v in data.items():
            cur = getattr(store, f)
            cur.clear()
            dec = _dec(f, v)
            cur.update(dec) if isinstance(cur, dict) else cur.extend(dec)


def load(store: Store, target: Optional[str | URL] = None) -> bool:
    target = target or url_from_env(os.environ.get("TAAD_DB"))
    if target is None:
        return False
    eng = _engine(target)
    with eng.connect() as c:
        row = c.execute(select(STATE.c.version, STATE.c.body).where(STATE.c.id == 1)).first()
    if not row:
        _versions[str(target)] = 0
        return False
    _versions[str(target)] = row.version
    _apply(store, row.body)
    return True


def save(store: Store, target: Optional[str | URL] = None) -> None:
    target = target or url_from_env(os.environ.get("TAAD_DB"))
    if target is None:
        return
    eng, key = _engine(target), str(target)
    with store.lock:
        blob = json.dumps({f: _enc(f, getattr(store, f)) for f in FIELDS}, default=str)
    expected = _versions.get(key, 0)
    with eng.begin() as c:
        if expected == 0:
            if c.execute(select(STATE.c.id).where(STATE.c.id == 1)).first():
                row = c.execute(select(STATE.c.version, STATE.c.body).where(STATE.c.id == 1)).first()
                _versions[key] = row.version
                _apply(store, row.body)
                raise PersistConflict("state row appeared concurrently; reloaded")
            c.execute(STATE.insert().values(id=1, version=1, body=blob))
            _versions[key] = 1
            return
        res = c.execute(update(STATE).where(STATE.c.id == 1, STATE.c.version == expected)
                        .values(version=expected + 1, body=blob))
        if res.rowcount != 1:
            row = c.execute(select(STATE.c.version, STATE.c.body).where(STATE.c.id == 1)).first()
            _versions[key] = row.version
            _apply(store, row.body)
            raise PersistConflict("concurrent writer detected; state reloaded, retry the request")
        _versions[key] = expected + 1
