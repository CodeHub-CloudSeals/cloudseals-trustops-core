"""Bounded LedgerSight agent pack and fail-closed execution primitives.

The six agents are deterministic reference agents. They have no network access,
credentials, or connector tools. Material writes are available only through the
mock SAP gateway after policy, maker-checker approval (when required), evidence
pre-commit, and a short-lived one-time action token.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
PACK = json.loads((ROOT / "packs/workflows/ledgersight.ar_cash/0.1.0.json").read_text())
AGENT_MANIFESTS = PACK["agents"]
PACK_ID = PACK["workflow_id"]
PACK_VERSION = PACK["version"]
POLICY_ID = PACK["policy"]["id"]
POLICY_VERSION = PACK["policy"]["version"]
HIGH_VALUE_THRESHOLD_MINOR = PACK["policy"]["high_value_threshold_minor"]
TOKEN_TTL_SECONDS = 60


class RuntimeErrorCode(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def canonical_digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def run_agents(tenant_id: str, actor: str, receipt: dict[str, Any], invoices: list[dict[str, Any]],
              remittance: dict[str, Any]) -> dict[str, Any]:
    """Run the six bounded agents; all model-like conclusions are deterministic and source-grounded."""
    if not tenant_id or not actor:
        raise RuntimeErrorCode("context_required", "Tenant and actor context are required")
    if not isinstance(receipt.get("receipt_id"), str) or not receipt["receipt_id"].strip():
        raise RuntimeErrorCode("invalid_receipt", "receipt_id is required")
    amount = receipt.get("amount_minor")
    if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
        raise RuntimeErrorCode("invalid_amount", "amount_minor must be a positive integer")
    currency = receipt.get("currency")
    reference = receipt.get("reference")
    if not isinstance(currency, str) or len(currency) != 3 or not currency.isalpha():
        raise RuntimeErrorCode("invalid_currency", "currency must be a 3-letter code")
    if not isinstance(reference, str) or not reference.strip() or len(reference) > 200:
        raise RuntimeErrorCode("invalid_reference", "reference is required and must be at most 200 characters")
    if len(invoices) > 500:
        raise RuntimeErrorCode("input_limit", "At most 500 invoices may be evaluated per run")
    seen: set[str] = set()
    valid: list[dict[str, Any]] = []
    for invoice in invoices:
        iid = invoice.get("invoice_id")
        iamount = invoice.get("amount_minor")
        icurrency = invoice.get("currency")
        iref = invoice.get("reference")
        if not isinstance(iid, str) or not iid or iid in seen:
            raise RuntimeErrorCode("invalid_invoice", "Invoice identifiers must be non-empty and unique")
        if isinstance(iamount, bool) or not isinstance(iamount, int) or iamount <= 0:
            raise RuntimeErrorCode("invalid_invoice", "Invoice amount_minor must be a positive integer")
        if not isinstance(icurrency, str) or len(icurrency) != 3 or not icurrency.isalpha():
            raise RuntimeErrorCode("invalid_invoice", "Invoice currency must be a 3-letter code")
        if not isinstance(iref, str) or not iref or len(iref) > 200:
            raise RuntimeErrorCode("invalid_invoice", "Invoice reference is required")
        seen.add(iid)
        valid.append(invoice)

    # Intake fingerprints the allowlisted source records. Free-text fields never become instructions.
    input_manifest = {"receipt": receipt, "invoices": valid, "remittance": remittance}
    input_digest = canonical_digest(input_manifest)
    remit_ref = remittance.get("reference") if isinstance(remittance, dict) else None
    match_ref = remit_ref if isinstance(remit_ref, str) and remit_ref.strip() else reference
    candidates = [i for i in valid if i["reference"].casefold() == match_ref.casefold()
                  and i["currency"].upper() == currency.upper() and i["amount_minor"] == amount]
    if len(candidates) == 1:
        classification, decision, reason, invoice = "exact_match", "ALLOW", "EXACT_MATCH_WITHIN_LIMIT", candidates[0]
    elif len(candidates) > 1:
        classification, decision, reason, invoice = "ambiguous_match", "ESCALATE", "MULTIPLE_EXACT_CANDIDATES", None
    else:
        classification, decision, reason, invoice = "unmatched", "ESCALATE", "NO_EXACT_MATCH", None

    approval_required = bool(invoice and amount >= HIGH_VALUE_THRESHOLD_MINOR)
    if approval_required:
        decision, reason = "ESCALATE", "HIGH_VALUE_CONTROLLER_APPROVAL_REQUIRED"
    proposal = None
    if invoice:
        proposal = {"action": "allocate_cash", "receipt_id": receipt["receipt_id"], "invoice_id": invoice["invoice_id"],
                    "amount_minor": amount, "currency": currency.upper(), "reference": match_ref}
    exception = None if decision == "ALLOW" else {"queue": "controller_review", "reason_code": reason,
                                                   "candidate_invoice_ids": [x["invoice_id"] for x in candidates]}
    return {
        "tenant_id": tenant_id, "actor": actor, "workflow_id": PACK_ID, "workflow_version": PACK_VERSION,
        "policy_id": POLICY_ID, "policy_version": POLICY_VERSION, "input_digest": input_digest,
        "receipt_id": receipt["receipt_id"], "amount_minor": amount, "currency": currency.upper(),
        "agent_trace": [
            {"agent_id": "ledgersight.intake", "status": "completed", "input_digest": input_digest},
            {"agent_id": "ledgersight.match", "status": "completed", "candidate_ids": [x["invoice_id"] for x in candidates]},
            {"agent_id": "ledgersight.reconciliation", "status": "completed", "classification": classification},
            {"agent_id": "ledgersight.cash_allocation", "status": "proposal_created" if proposal else "no_action", "proposal": proposal},
            {"agent_id": "ledgersight.exception", "status": "routed" if exception else "not_required", "exception": exception},
            {"agent_id": "ledgersight.audit", "status": "evidence_manifest_created", "input_digest": input_digest},
        ],
        "policy_decision": {"decision": decision, "reason_code": reason, "approval_required": approval_required,
                            "policy_id": POLICY_ID, "policy_version": POLICY_VERSION,
                            "evaluated_input_digest": input_digest},
        "proposal": proposal, "exception": exception, "status": "approval_required" if approval_required else
            ("ready_to_prepare" if decision == "ALLOW" else "escalated"),
        "created_by": actor, "created_at": time.time(), "approval": None,
        "prepared_action": None, "execution": None,
    }


def token_secret(env: str) -> bytes:
    configured = os.environ.get("TRUSTOPS_ACTION_TOKEN_SECRET")
    if configured:
        return configured.encode()
    if env != "local":
        raise RuntimeErrorCode("action_token_signer_unavailable", "A managed signing key is required outside local development")
    # Process-local dev key: restart invalidates any outstanding token; production must use KMS/HSM signing.
    global _DEV_TOKEN_SECRET
    if _DEV_TOKEN_SECRET is None:
        _DEV_TOKEN_SECRET = secrets.token_bytes(32)
    return _DEV_TOKEN_SECRET


_DEV_TOKEN_SECRET: bytes | None = None


def issue_action_token(secret: bytes, claims: dict[str, Any]) -> str:
    body = json.dumps(claims, sort_keys=True, separators=(",", ":")).encode()
    encoded = __import__("base64").urlsafe_b64encode(body).decode().rstrip("=")
    signature = hmac.new(secret, encoded.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def verify_action_token(secret: bytes, token: str) -> dict[str, Any]:
    try:
        encoded, signature = token.split(".", 1)
        expected = hmac.new(secret, encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise ValueError("bad signature")
        body = __import__("base64").urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        claims = json.loads(body)
        if claims.get("exp", 0) <= time.time():
            raise ValueError("expired")
        return claims
    except Exception as exc:
        raise RuntimeErrorCode("invalid_action_token", "Action token is invalid or expired") from exc


def append_evidence(chain: list[dict[str, Any]], tenant_id: str, run_id: str, event_type: str,
                    payload: dict[str, Any]) -> dict[str, Any]:
    prev = next((e["record_hash"] for e in reversed(chain) if e["tenant_id"] == tenant_id), "0" * 64)
    record = {"sequence": 1 + sum(e["tenant_id"] == tenant_id for e in chain), "tenant_id": tenant_id,
              "run_id": run_id, "event_type": event_type, "occurred_at": time.time(), "previous_hash": prev,
              "payload": payload, "payload_digest": canonical_digest(payload)}
    record["record_hash"] = canonical_digest(record)
    chain.append(record)
    return record


def verify_evidence(chain: list[dict[str, Any]], tenant_id: str) -> bool:
    previous = "0" * 64
    expected_seq = 1
    for original in (e for e in chain if e["tenant_id"] == tenant_id):
        record = dict(original)
        recorded_hash = record.pop("record_hash", None)
        if record["sequence"] != expected_seq or record["previous_hash"] != previous:
            return False
        if record["payload_digest"] != canonical_digest(record["payload"]) or recorded_hash != canonical_digest(record):
            return False
        previous = recorded_hash
        expected_seq += 1
    return expected_seq > 1
