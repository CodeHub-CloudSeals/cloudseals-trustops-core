"""TAAD assessment API (modular monolith). Implements taad_assessment_api_v1.yaml locally."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal, Optional
from urllib.parse import urlparse

import reporting
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from question_engine import candidate_findings, eligible_questions, load_registry
from question_engine.branching import is_eligible

from . import persist, swaska, trustops_runtime
from .evidence import inspect, make_store
from .security import AUTH_MODE, CLOUDSEALS_ROLES, ENV, issue_token, verify_token
from .store import Store

ROOT = Path(__file__).resolve().parents[3]
REG = load_registry(ROOT / "taad_question_control_registry_v1.0.0.json", ROOT / "taad_catalog_sha256.txt")
STORE = Store()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if ENV == "local" and AUTH_MODE == "dev" and os.environ.get("TAAD_SEED") == "1" and not STORE.users:
        from .seed import seed
        seed()
    yield


app = FastAPI(title="CloudSeals TAAD Diagnosis API", version="1.0.0", docs_url=None if ENV == "prod" else "/docs",
              redoc_url=None, openapi_url=None if ENV == "prod" else "/openapi.json", lifespan=lifespan)
DB_PATH = os.environ.get("TAAD_DB")
OBJECTS = make_store()
SWASKA_CLIENT = swaska.default_client()
INVITE_TTL = 7 * 24 * 3600
FINDING_STATUSES = ["Confirmed gap", "Potential gap", "No gap evidenced", "Not applicable"]
if persist.enabled():
    persist.load(STORE)
ALLOWED_MIME = {"application/pdf", "text/plain", "text/csv", "application/json",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
MAX_UPLOAD = 25 * 1024 * 1024


class Principal(BaseModel):
    sub: str
    tenant_id: Optional[str]
    roles: list[str]

    @property
    def is_staff(self) -> bool:
        return bool(set(self.roles) & CLOUDSEALS_ROLES)


def err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


@app.middleware("http")
async def hardening(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Cache-Control", "no-store")
    if request.url.path.startswith("/portal"):
        token_url = urlparse(os.environ.get("TAAD_PORTAL_TOKEN_URL", ""))
        cognito_origin = f" {token_url.scheme}://{token_url.netloc}" if AUTH_MODE == "oidc" and token_url.scheme == "https" and token_url.netloc else ""
        portal_csp = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                      f"connect-src 'self'{cognito_origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    else:
        portal_csp = "default-src 'none'; frame-ancestors 'none'"
    resp.headers.setdefault("Content-Security-Policy", portal_csp)
    if request.method not in ("GET", "HEAD", "OPTIONS") and persist.enabled():
        try:
            persist.save(STORE)
        except persist.PersistConflict as e:
            return JSONResponse(status_code=503, content={"code": "retry", "message": str(e)}, headers={"Retry-After": "1"})
    return resp


@app.exception_handler(HTTPException)
async def http_err(request: Request, exc: HTTPException):
    d = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={**d, "trace_id": uuid.uuid4().hex})


def authenticated_sub(authorization: Optional[str] = Header(default=None)) -> str:
    """Identity only (no membership required): used by invitation acceptance."""
    if not authorization or not authorization.startswith("Bearer "):
        raise err(401, "unauthenticated", "Bearer token required")
    sub = verify_token(authorization[7:])
    if not sub:
        raise err(401, "unauthenticated", "Invalid token")
    return sub


def principal(sub: str = Depends(authenticated_sub)) -> Principal:
    user = STORE.users.get(sub)
    if not user:
        raise err(401, "unauthenticated", "Invalid token")
    return Principal(sub=sub, tenant_id=user.get("tenant_id"), roles=user["roles"])


def audit(p: Principal, action: str, ref: str) -> None:
    STORE.audit.append({"at": time.time(), "sub": p.sub, "tenant_id": p.tenant_id, "action": action, "ref": ref})


def publish_event(ev: dict) -> None:
    """Publish to EventBridge when configured; the local list remains the audit copy. Failures never block the API."""
    bus = os.environ.get("TAAD_EVENT_BUS")
    if not bus:
        return
    try:
        import boto3
        boto3.client("events").put_events(Entries=[{"EventBusName": bus, "Source": "taad", "DetailType": ev["type"],
                                                    "Detail": json.dumps({k: v for k, v in ev.items() if k != "payload"} | {"payload_ref": ev["event_id"]})}])
    except Exception:
        ev["publish_failed"] = True


def emit(event_type: str, tenant_id: str, payload: dict) -> dict:
    ev = {"event_id": str(uuid.uuid4()), "type": event_type, "tenant_id": tenant_id,
          "trace_id": uuid.uuid4().hex, "schema_version": "1.0.0", "source": "taad",
          "occurred_at": time.time(), "payload": payload,
          "payload_digest": hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()}
    STORE.events.append(ev)
    publish_event(ev)
    return ev


def get_assessment(p: Principal, aid: str) -> dict[str, Any]:
    """Cross-tenant and unknown IDs are indistinguishable (404) so existence never leaks."""
    a = STORE.assessments.get(aid)
    if not a or (not p.is_staff and a["tenant_id"] != p.tenant_id):
        raise err(404, "not_found", "Assessment not found")
    return a


def require(p: Principal, *roles: str) -> None:
    if not set(p.roles) & set(roles):
        raise err(403, "forbidden", "Role not permitted for this operation")


def idempotent(p: Principal, key: Optional[str], op: str, fn):
    if not key or len(key) > 128:
        raise err(400, "idempotency_key_required", "Idempotency-Key header required (max 128 chars)")
    k = (p.sub, op, key)
    with STORE.lock:
        if k in STORE.idempotency:
            return STORE.idempotency[k]
        res = fn()
        STORE.idempotency[k] = res
        return res


# ---------- models ----------
class RegistrationRequest(BaseModel):
    organisation_name: str = Field(max_length=200)
    work_email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    industry: str
    jurisdiction: list[str]
    engagement_reference: str


class AssessmentCreate(BaseModel):
    ai_system_name: str = Field(min_length=1, max_length=200)
    industry: str
    questionnaire_version: str


class ScopedAnswer(BaseModel):
    scope_id: str
    value: Any
    answer_status: Literal["answered", "unknown", "not_applicable", "not_requested"]
    comment: str = Field(default="", max_length=5000)
    evidence_refs: list[str] = []


class SwaskaTurn(BaseModel):
    scope_id: str
    user_message: str = Field(max_length=10000)
    parent_question_id: Optional[str] = None


class EvidenceUploadRequest(BaseModel):
    filename: str
    content_type: str
    file_size_bytes: int = Field(ge=1)
    claimed_sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")


class ReviewDecision(BaseModel):
    decision: Literal["approve", "request_clarification", "reject"]
    reviewer_reason: str = Field(min_length=1)


class POCBlueprintRequest(BaseModel):
    report_id: str
    workflow_pack_id: str
    customer_security_signoff_ref: Optional[str] = None
    cloudseals_architect_signoff_ref: Optional[str] = None
    success_criteria: list[str] = Field(default_factory=list)


# ---------- helpers ----------
def merged_answers(aid: str, scope_id: str) -> dict[str, Any]:
    """Org-scope answers overlaid by the requested scope's answers (branch rules reference Q-BASE)."""
    out: dict[str, Any] = {}
    for sc in ("org", scope_id):
        for (a, s, qid), ans in STORE.answers.items():
            if a == aid and s == sc and ans["answer_status"] == "answered":
                out[qid] = ans["value"]
            elif a == aid and s == sc and ans["answer_status"] == "unknown":
                out[qid] = "Unknown"
    return out


def all_answers(aid: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for (a, _s, qid), ans in sorted(STORE.answers.items()):
        if a != aid:
            continue
        if ans["answer_status"] == "answered":
            out.setdefault(qid, ans["value"])
        elif ans["answer_status"] == "unknown":
            out.setdefault(qid, "Unknown")
    return out


def validate_value(q: dict, ans: ScopedAnswer) -> None:
    if ans.answer_status != "answered":
        return
    t, v = q["response_type"], ans.value
    if t == "select_one":
        if v not in REG.option_sets[q["option_set"]]:
            raise err(422, "invalid_option", f"{v!r} not valid for {q['question_id']}")
    elif t == "select_multi":
        if not isinstance(v, list) or not set(v) <= set(REG.option_sets[q["option_set"]]):
            raise err(422, "invalid_option", "invalid multi-select value")
    elif t == "number":
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise err(422, "invalid_number", "number expected")
    elif t in ("text", "long_text"):
        if not isinstance(v, str) or len(v) > 10000:
            raise err(422, "invalid_text", "text expected (max 10000 chars)")
        if reporting.clean(v) != v:
            raise err(422, "invalid_characters", "Control or bidirectional-override characters are not allowed")


# ---------- routes ----------
@app.get("/health")
def health():
    return {"status": "ok", "registry_version": REG.version, "registry_sha256": REG.sha256,
            "question_count": len(REG.questions)}


@app.post("/v1/registration-requests", status_code=202)
def register(req: RegistrationRequest, request: Request):
    now = time.time()
    keys = [f"ip:{request.client.host if request.client else '?'}", f"dom:{req.work_email.split('@')[1].lower()}"]
    for k in keys:
        STORE.rate[k] = [t for t in STORE.rate.get(k, []) if now - t < 3600]
        if len(STORE.rate[k]) >= 5:
            raise err(429, "rate_limited", "Too many registration requests; try again later")
        STORE.rate[k].append(now)
    eng = STORE.engagements.get(req.engagement_reference)
    STORE.registrations.append({**req.model_dump(), "registration_id": str(uuid.uuid4()), "at": now,
                                "status": "pending_approval",
                                "engagement_verified": bool(eng) and eng.get("status") == "approved"})
    return {"status": "pending_verification"}   # identical response whether or not the engagement exists


@app.post("/v1/assessments", status_code=201)
def create_assessment(body: AssessmentCreate, p: Principal = Depends(principal),
                      idempotency_key: Optional[str] = Header(default=None)):
    require(p, "customer_admin", "customer_architect")
    if body.questionnaire_version != REG.version:
        raise err(422, "unknown_questionnaire_version", f"Published version is {REG.version}")

    def create():
        aid = str(uuid.uuid4())
        a = {"assessment_id": aid, "tenant_id": p.tenant_id, "ai_system_name": body.ai_system_name,
             "industry": body.industry, "questionnaire_version": REG.version,
             "registry_sha256": REG.sha256, "status": "In progress", "created_by": p.sub,
             "created_at": time.time(), "snapshot": None}
        STORE.assessments[aid] = a
        audit(p, "assessment.create", aid)
        return a
    return idempotent(p, idempotency_key, "create_assessment", create)


@app.get("/v1/assessments")
def list_assessments(p: Principal = Depends(principal)):
    items = [a for a in STORE.assessments.values() if p.is_staff or a["tenant_id"] == p.tenant_id]
    return {"items": items}


@app.get("/v1/assessments/{aid}/questions")
def questions(aid: str, scope_id: str, scope_type: str = "org", p: Principal = Depends(principal)):
    a = get_assessment(p, aid)
    qs = eligible_questions(REG, scope_type, merged_answers(aid, scope_id))
    return {"questionnaire_version": a["questionnaire_version"], "scope_id": scope_id,
            "questions": [{k: q[k] for k in ("question_id", "question", "section", "response_type", "required",
                                              "option_set", "guidance", "evidence_request", "control_id")} |
                          {"options": REG.option_sets.get(q["option_set"], [])} for q in qs]}


@app.put("/v1/assessments/{aid}/answers/{qid}")
def put_answer(aid: str, qid: str, body: ScopedAnswer, if_match: Optional[str] = Header(default=None),
               p: Principal = Depends(principal)):
    a = get_assessment(p, aid)
    require(p, "customer_admin", "customer_architect", "customer_risk", "customer_contributor",
            "cloudseals_assessor", "cloudseals_admin")
    if a["status"] != "In progress":
        raise err(409, "frozen", "Assessment is submitted; answers are immutable")
    q = REG.questions.get(qid)
    if not q:
        raise err(422, "unknown_question", "Question ID not in pinned questionnaire")
    # eligibility is evaluated against the scope's merged answers
    if not is_eligible(REG, qid, merged_answers(aid, body.scope_id)):
        raise err(422, "question_not_eligible", "Question not applicable under current branching")
    validate_value(q, body)
    if set(p.roles) == {"customer_contributor"}:
        if q["section"] not in STORE.assignments.get(aid, {}).get(p.sub, []):
            raise err(403, "not_assigned", "Section not assigned to this contributor")
    for ref in body.evidence_refs:
        ev = STORE.evidence.get(ref)
        if not ev or ev["assessment_id"] != aid or ev["state"] != "clean":
            raise err(422, "invalid_evidence_ref", "Evidence must exist for this assessment and have passed quarantine scanning")
    key = (aid, body.scope_id, qid)
    with STORE.lock:
        cur = STORE.answers.get(key)
        cur_etag = cur["etag"] if cur else "0"
        if if_match is None or if_match.strip('"') != cur_etag:
            raise err(409, "etag_mismatch", f"Concurrent modification; current ETag is {cur_etag}")
        rev = (cur["revision"] if cur else 0) + 1
        rec = {**body.model_dump(), "question_id": qid, "revision": rev, "etag": str(rev),
               "updated_by": p.sub, "updated_at": time.time()}
        STORE.answers[key] = rec
        STORE.revisions.append({"assessment_id": aid, **rec})
        audit(p, "answer.put", f"{aid}/{qid}")
    return JSONResponse(rec, headers={"ETag": f'"{rec["etag"]}"'})


@app.post("/v1/assessments/{aid}/swaska/turns")
def swaska_turn(aid: str, body: SwaskaTurn, p: Principal = Depends(principal)):
    """Read-only interviewer: allowlisted tools, schema-validated output, deterministic fallback."""
    a = get_assessment(p, aid)
    qid = body.parent_question_id
    if not qid or qid not in REG.questions:
        raise err(422, "unknown_question", "Swaska may only reference existing question IDs")
    ans = merged_answers(aid, body.scope_id)
    tools = {
        "get_assessment_context": lambda: {"assessment_id": aid, "questionnaire_version": a["questionnaire_version"],
                                            "industry": a["industry"]},
        "get_next_eligible_questions": lambda: [q["question_id"] for q in eligible_questions(REG, "org", ans)][:5],
        "read_answer_for_current_scope": lambda question_id: ans.get(question_id),
        "get_evidence_metadata": lambda: [{"evidence_id": e["evidence_id"], "state": e["state"],
                                           "injection_flagged": e.get("injection_flagged", False)}
                                          for e in STORE.evidence.values() if e["assessment_id"] == aid],
        "suggest_clarification": lambda **kw: kw, "propose_evidence_request": lambda **kw: kw,
    }
    return swaska.run_turn(SWASKA_CLIENT, swaska.ToolBox(tools), REG.questions[qid], body.user_message, set(REG.questions))


@app.post("/v1/assessments/{aid}/evidence/upload-url", status_code=201)
def upload_url(aid: str, body: EvidenceUploadRequest, p: Principal = Depends(principal)):
    a = get_assessment(p, aid)
    if body.content_type not in ALLOWED_MIME:
        raise err(422, "mime_not_allowed", "Content type not permitted")
    if body.file_size_bytes > MAX_UPLOAD:
        raise err(422, "too_large", "File exceeds size limit")
    eid = str(uuid.uuid4())
    # Opaque key: the client filename is metadata only and never used in the object path.
    STORE.evidence[eid] = {"evidence_id": eid, "assessment_id": aid, "tenant_id": a["tenant_id"],
                           "filename": body.filename, "content_type": body.content_type, "size": body.file_size_bytes,
                           "sha256": body.claimed_sha256.lower(), "state": "awaiting_upload", "uploaded_by": p.sub}
    return {"evidence_id": eid, "state": "awaiting_upload",
            "upload_url": f"/v1/assessments/{aid}/evidence/{eid}/content", "expires_in_seconds": 300,
            "note": "Content is quarantined and scanned before it can be cited as evidence."}


@app.put("/v1/assessments/{aid}/evidence/{eid}/content")
async def upload_content(aid: str, eid: str, request: Request, p: Principal = Depends(principal)):
    """Dev stand-in for a presigned S3 PUT into the quarantine bucket + malware scan."""
    get_assessment(p, aid)
    ev = STORE.evidence.get(eid)
    if not ev or ev["assessment_id"] != aid:
        raise err(404, "not_found", "Evidence not found")
    if ev["state"] != "awaiting_upload":
        raise err(409, "conflict", "Content already uploaded")
    declared = ev["size"]
    data = b""
    async for chunk in request.stream():
        data += chunk
        if len(data) > min(declared, MAX_UPLOAD):
            break
    verdict = inspect(ev["content_type"], data, ev["sha256"], declared)
    ev.update(state=verdict["state"], reason=verdict["reason"], injection_flagged=verdict["injection_flagged"])
    if verdict["state"] == "clean":
        if hasattr(OBJECTS, "promote"):
            OBJECTS.put(ev["tenant_id"], "quarantine", eid, data)
            # Local byte checks are a prefilter. In AWS, only GuardDuty's explicit clean
            # result can promote an object into the citable evidence bucket.
            ev.update(state="scanning", reason="guardduty_scan_pending", scan_status=None)
            refresh_guardduty_scan(ev)
        else:
            OBJECTS.put(ev["tenant_id"], "evidence", eid, data)
    audit(p, f"evidence.{verdict['state']}", eid)
    return {"evidence_id": eid, "state": ev["state"], "reason": ev["reason"], "injection_flagged": ev["injection_flagged"]}


def refresh_guardduty_scan(ev: dict) -> None:
    """Fail closed: only the documented GuardDuty clean tag makes AWS evidence citable."""
    if ev.get("state") != "scanning" or not hasattr(OBJECTS, "scan_status"):
        return
    status = OBJECTS.scan_status(ev["tenant_id"], ev["evidence_id"])
    ev["scan_status"] = status
    if status is None:
        ev["reason"] = "guardduty_scan_pending"
    elif status == "NO_THREATS_FOUND":
        OBJECTS.promote(ev["tenant_id"], ev["evidence_id"])
        ev.update(state="clean", reason="", scanned_by="guardduty")
    elif status == "THREATS_FOUND":
        ev.update(state="infected", reason="guardduty_threat_detected", scanned_by="guardduty")
    elif status in {"UNSUPPORTED", "ACCESS_DENIED", "FAILED"}:
        ev.update(state="rejected", reason=f"guardduty_{status.lower()}", scanned_by="guardduty")


@app.get("/v1/assessments/{aid}/evidence")
def list_evidence(aid: str, p: Principal = Depends(principal)):
    get_assessment(p, aid)
    if hasattr(OBJECTS, "scan_status"):
        for ev in STORE.evidence.values():
            if ev["assessment_id"] == aid:
                refresh_guardduty_scan(ev)
    return {"items": [{k: e.get(k) for k in ("evidence_id", "filename", "state", "reason", "injection_flagged", "size")}
                      for e in STORE.evidence.values() if e["assessment_id"] == aid]}


@app.post("/v1/assessments/{aid}/submit", status_code=202)
def submit(aid: str, p: Principal = Depends(principal), idempotency_key: Optional[str] = Header(default=None)):
    a = get_assessment(p, aid)
    require(p, "customer_admin", "customer_architect")

    def do():
        if a["status"] != "In progress":
            raise err(409, "conflict", "Already submitted")
        ans = all_answers(aid)
        missing = [q["question_id"] for q in REG.questions.values()
                   if q["required"] == "yes" and q["enabled"] and q["scope"] == "org" and q["question_id"] not in ans]
        if missing:
            raise err(409, "missing_mandatory_answers", f"Missing: {', '.join(missing[:20])}")
        manifest = {"assessment_id": aid, "questionnaire_version": a["questionnaire_version"],
                    "answers": {f"{s}/{q}": v["value"] for (x, s, q), v in sorted(STORE.answers.items()) if x == aid}}
        digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, default=str).encode()).hexdigest()
        a["status"] = "Submitted"
        a["snapshot"] = {"snapshot_id": str(uuid.uuid4()), "answer_manifest_digest": digest}
        emit("taad.assessment.submitted.v1", a["tenant_id"], {"assessment_id": aid, **a["snapshot"],
                                                              "questionnaire_version": a["questionnaire_version"]})
        run_diagnosis(a)
        audit(p, "assessment.submit", aid)
        return {"status": "Submitted", **a["snapshot"]}
    return idempotent(p, idempotency_key, f"submit:{aid}", do)


def run_diagnosis(a: dict) -> None:
    aid = a["assessment_id"]
    ev: dict[str, list[str]] = {}
    for (x, _s, qid), ans in STORE.answers.items():
        if x == aid and ans["evidence_refs"]:
            ev.setdefault(qid, []).extend(ans["evidence_refs"])
    res = candidate_findings(REG, all_answers(aid), ev)
    STORE.findings[aid] = res["findings"]
    STORE.not_assessed[aid] = res["not_assessed"]
    rid = str(uuid.uuid4())
    STORE.reports[rid] = {
        "report_id": rid, "assessment_id": aid, "tenant_id": a["tenant_id"], "status": "draft",
        "visibility": "staff_only", "version": 1, "provenance": {
            "questionnaire_version": a["questionnaire_version"], "registry_sha256": a["registry_sha256"],
            "rule_versions": {r["rule_id"]: r["rule_version"] for r in REG.risk_rules},
            "answer_manifest_digest": a["snapshot"]["answer_manifest_digest"],
            "regulatory_content_status": REG.raw["status"]},
        "sections": [{"id": x["id"], "title": x["title"]} for x in REG.report_sections], "finding_count": len(res["findings"]),
        "not_assessed": res["not_assessed"],
        "disclaimer": "Candidate findings for human review. Not a legal determination of regulatory applicability."}
    emit("taad.diagnosis.draft_ready.v1", a["tenant_id"], {"assessment_id": aid, "report_id": rid})


@app.get("/v1/assessments/{aid}/findings")
def findings(aid: str, p: Principal = Depends(principal)):
    get_assessment(p, aid)
    items = STORE.findings.get(aid, [])
    published = any(r["assessment_id"] == aid and r["status"] == "published" for r in STORE.reports.values())
    if not p.is_staff and not published:
        return {"items": [], "note": "Findings are visible after reviewer approval"}
    return {"items": items}


@app.get("/v1/assessments/{aid}/reports")
def reports(aid: str, p: Principal = Depends(principal)):
    get_assessment(p, aid)
    items = [r for r in STORE.reports.values() if r["assessment_id"] == aid and (p.is_staff or r["status"] == "published")]
    return {"items": items}


@app.post("/v1/assessments/{aid}/reviews/{rid}/decision")
def review(aid: str, rid: str, body: ReviewDecision, p: Principal = Depends(principal),
           idempotency_key: Optional[str] = Header(default=None)):
    get_assessment(p, aid)
    require(p, "cloudseals_reviewer")
    r = STORE.reports.get(rid)
    if not r or r["assessment_id"] != aid:
        raise err(404, "not_found", "Report not found")

    def do():
        if r["status"] == "published":
            raise err(409, "conflict", "Already published")
        outcomes = {"approve": "published", "request_clarification": "clarification_requested", "reject": "rejected"}
        r["status"] = outcomes[body.decision]
        r["review"] = {"by": p.sub, "decision": body.decision, "reason": body.reviewer_reason}
        if body.decision == "approve":
            r["visibility"] = "customer"
            r["findings_snapshot"] = json.loads(json.dumps(STORE.findings.get(aid, [])))
            r["published_digest"] = render_model(STORE.assessments[aid], r)["content_digest"]
            emit("taad.diagnosis.report_published.v1", r["tenant_id"], {"assessment_id": aid, "report_id": rid})
        audit(p, f"review.{body.decision}", rid)
        return {"report_id": rid, "status": r["status"]}
    return idempotent(p, idempotency_key, f"review:{rid}", do)


REQUIRED_BLUEPRINT_FIELDS = json.loads((ROOT / "taad_integration_contracts_v1.json").read_text())["poc_blueprint_required_fields"]


def build_blueprint(a: dict, r: dict, body: "POCBlueprintRequest", bid: str) -> dict:
    """Deterministic DRAFT objects derived from approved findings and answers. Nothing here can execute or hold credentials."""
    aid = a["assessment_id"]
    ans = all_answers(aid)
    findings = r["findings_snapshot"]
    by_dom = lambda *ds: sorted(q for q in ans if q in REG.questions and q.split("-")[1] in ds)  # noqa: E731
    scopes = sorted({s for (x, s, q), v in STORE.answers.items() if x == aid and s != "org"})
    bp = {
        "blueprint_id": bid, "tenant_id": a["tenant_id"], "assessment_id": aid, "report_id": body.report_id,
        "finding_refs": [f["rule_id"] for f in findings],
        "system_inventory_refs": by_dom("AIA", "ENT", "AGT"),
        "connector_drafts": [{"scope": s, "mode": "READ_ONLY", "state": "DRAFT", "credentials": None} for s in scopes],
        "agent_manifests_draft": [{"scope": s, "state": "DRAFT", "approved_capabilities": ["READ", "CLASSIFY", "RECOMMEND"],
                                   "prohibited_capabilities": ["PREPARE_WRITE", "APPROVE", "EXECUTE"]} for s in scopes],
        "policy_candidates_draft": [{"from_rule": f["rule_id"], "control_ids": f["control_ids"], "proposal": f["recommendation"],
                                     "state": "CANDIDATE_REQUIRES_REVIEW"} for f in findings],
        "authority_matrix_draft": [{"action": act, "default": "DENY", "requires_human_approval": act in ("PREPARE_WRITE", "APPROVE", "EXECUTE")}
                                   for act in REG.option_sets["ACTION"]],
        "approval_matrix_draft": [{"from_rule": f["rule_id"], "approval": "HUMAN_REQUIRED"} for f in findings
                                  if {c.split("-")[1] for c in f["control_ids"]} & {"HIT", "POL", "IAM"}],
        "evidence_profile_draft": sorted({REG.questions[q]["evidence_request"] for q in ans if q in REG.questions
                                          and REG.questions[q]["evidence_request"]}),
        "shadow_roi_baseline_ref": {"answers": by_dom("BUS", "ECO"), "state": "BASELINE_TO_BE_MEASURED_IN_SHADOW"},
        "success_criteria": body.success_criteria,
        "customer_security_signoff": body.customer_security_signoff_ref,
        "cloudseals_architect_signoff": body.cloudseals_architect_signoff_ref,
        "workflow_pack_id": body.workflow_pack_id, "state": "DRAFT",
        "runtime_activation": "BLOCKED_PENDING_SEPARATE_APPROVAL", "credentials_provisioned": False, "external_writes_enabled": False,
        "provenance": {"questionnaire_version": a["questionnaire_version"], "registry_sha256": a["registry_sha256"],
                       "report_digest": r["published_digest"]}}
    bp["customer_security_signoff"] = body.customer_security_signoff_ref
    bp["cloudseals_architect_signoff"] = body.cloudseals_architect_signoff_ref
    missing = [f for f in REQUIRED_BLUEPRINT_FIELDS if f not in bp and f.replace("_ref", "") not in bp
               and not any(k.startswith(f.replace("_ref", "")) for k in bp)]
    if missing:
        raise err(500, "blueprint_contract_violation", f"Missing contract fields: {missing}")
    bp["blueprint_digest"] = hashlib.sha256(json.dumps(bp, sort_keys=True, default=str).encode()).hexdigest()
    return bp


@app.post("/v1/assessments/{aid}/poc-blueprints", status_code=201)
def poc_blueprint(aid: str, body: POCBlueprintRequest, p: Principal = Depends(principal),
                  idempotency_key: Optional[str] = Header(default=None)):
    a = get_assessment(p, aid)
    require(p, "cloudseals_admin", "cloudseals_assessor")
    r = STORE.reports.get(body.report_id)
    if not r or r["assessment_id"] != aid or r["status"] != "published":
        raise err(409, "report_not_approved", "Blueprint requires a published (reviewer-approved) report")
    if not (body.customer_security_signoff_ref and body.cloudseals_architect_signoff_ref):
        raise err(409, "signoffs_required", "Customer security and CloudSeals architect sign-offs are both required")

    if not body.success_criteria:
        raise err(422, "success_criteria_required", "At least one measurable success criterion is required")

    def do():
        bid = str(uuid.uuid4())
        bp = build_blueprint(a, r, body, bid)
        STORE.blueprints[bid] = bp
        emit("taad.poc.blueprint_approved.v1", a["tenant_id"], {"blueprint_id": bid, "assessment_id": aid,
                                                                "blueprint_digest": bp["blueprint_digest"]})
        audit(p, "poc.blueprint", bid)
        return bp
    return idempotent(p, idempotency_key, f"poc:{aid}:{body.report_id}", do)


@app.get("/v1/admin/metrics")
def metrics(p: Principal = Depends(principal)):
    require(p, "cloudseals_admin", "cloudseals_platform_ops", "cloudseals_reviewer", "cloudseals_assessor")
    return {"registrations": len(STORE.registrations), "assessments": len(STORE.assessments),
            "submitted": sum(a["status"] == "Submitted" for a in STORE.assessments.values()),
            "review_queue": sum(r["status"] == "draft" for r in STORE.reports.values()),
            "published_reports": sum(r["status"] == "published" for r in STORE.reports.values()),
            "poc_blueprints": len(STORE.blueprints)}


# ---------- identity, onboarding, invitations ----------
class InvitationAccept(BaseModel):
    token: str


class TenantInvitation(BaseModel):
    role: Literal["customer_architect", "customer_risk", "customer_controller", "customer_contributor"]


class RegistrationDecision(BaseModel):
    decision: Literal["approve", "reject"]
    reason: str = Field(min_length=1)


class Assignment(BaseModel):
    sub: str
    sections: list[str]


class FindingReview(BaseModel):
    status: Literal["Confirmed gap", "Potential gap", "No gap evidenced", "Not applicable"]
    reason: str = Field(min_length=1, max_length=2000)


class TenantSettings(BaseModel):
    allow_preliminary_report: bool


class WorkflowRunRequest(BaseModel):
    receipt: dict[str, Any]
    invoices: list[dict[str, Any]] = Field(max_length=500)
    remittance: dict[str, Any] = Field(default_factory=dict)


class RuntimeApprovalDecision(BaseModel):
    decision: Literal["approve", "reject"]
    reason: str = Field(min_length=1, max_length=2000)


class PrepareActionRequest(BaseModel):
    run_id: str


class ExecuteActionRequest(BaseModel):
    run_id: str
    action_token: str = Field(min_length=20, max_length=4096)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _invite(tenant_id: str, role: str, by: str) -> str:
    token = secrets.token_urlsafe(32)
    STORE.invitations[_hash(token)] = {"tenant_id": tenant_id, "role": role, "by": by,
                                       "expires_at": time.time() + INVITE_TTL, "used": False}
    return token


@app.get("/v1/me")
def me(p: Principal = Depends(principal)):
    return {"sub": p.sub, "tenant_id": p.tenant_id, "roles": p.roles, "is_staff": p.is_staff,
            "tenant": STORE.tenants.get(p.tenant_id or "")}


@app.post("/v1/invitations/accept")
def accept_invitation(body: InvitationAccept, sub: str = Depends(authenticated_sub)):
    inv = STORE.invitations.get(_hash(body.token))
    if not inv or inv["used"] or inv["expires_at"] < time.time():
        raise err(400, "invalid_invitation", "Invitation is invalid or expired")
    with STORE.lock:
        if sub in STORE.users:
            raise err(409, "already_member", "Identity already has a membership")
        roles = ["customer_admin", "customer_architect"] if inv["role"] == "customer_admin" else [inv["role"]]
        STORE.users[sub] = {"tenant_id": inv["tenant_id"], "roles": roles}
        inv["used"] = True
    STORE.audit.append({"at": time.time(), "sub": sub, "tenant_id": inv["tenant_id"], "action": "invitation.accept", "ref": inv["role"]})
    return {"tenant_id": inv["tenant_id"], "roles": roles}


@app.post("/v1/tenant/invitations", status_code=201)
def tenant_invite(body: TenantInvitation, p: Principal = Depends(principal)):
    require(p, "customer_admin")
    token = _invite(p.tenant_id, body.role, p.sub)
    audit(p, "tenant.invite", body.role)
    STORE.outbox.append({"to": "invitee", "kind": "tenant_invitation", "tenant_id": p.tenant_id})
    return {"role": body.role, "expires_in_seconds": INVITE_TTL, **({"invitation_token": token} if ENV == "local" else {})}


@app.get("/v1/admin/registrations")
def list_registrations(p: Principal = Depends(principal)):
    require(p, "cloudseals_admin")
    return {"items": [r for r in STORE.registrations]}


@app.post("/v1/admin/registrations/{rid}/decision")
def decide_registration(rid: str, body: RegistrationDecision, p: Principal = Depends(principal)):
    require(p, "cloudseals_admin")
    reg = next((r for r in STORE.registrations if r.get("registration_id") == rid), None)
    if not reg:
        raise err(404, "not_found", "Registration not found")
    if reg["status"] != "pending_approval":
        raise err(409, "conflict", "Already decided")
    if body.decision == "reject":
        reg["status"] = "rejected"
        return {"status": "rejected"}
    if not reg["engagement_verified"]:
        raise err(409, "engagement_not_verified", "No approved engagement matches this registration")
    tid = f"t-{uuid.uuid4().hex[:12]}"
    STORE.tenants[tid] = {"tenant_id": tid, "name": reg["organisation_name"], "industry": reg["industry"],
                          "residency_profile": (reg["jurisdiction"] or ["UK"])[0], "allow_preliminary_report": False}
    token = _invite(tid, "customer_admin", p.sub)
    reg.update(status="approved", tenant_id=tid)
    STORE.outbox.append({"to": reg["work_email"], "kind": "tenant_activation", "tenant_id": tid})
    emit("taad.tenant.activated.v1", tid, {"tenant_id": tid, "organisation_ref": tid, "residency_profile": STORE.tenants[tid]["residency_profile"],
                                           "engagement_approval_ref": reg["engagement_reference"]})
    audit(p, "registration.approve", rid)
    return {"status": "approved", "tenant_id": tid, **({"invitation_token": token} if ENV == "local" else {})}


@app.put("/v1/admin/tenants/{tid}/settings")
def tenant_settings(tid: str, body: TenantSettings, p: Principal = Depends(principal)):
    require(p, "cloudseals_admin")
    if tid not in STORE.tenants:
        raise err(404, "not_found", "Tenant not found")
    STORE.tenants[tid]["allow_preliminary_report"] = body.allow_preliminary_report
    audit(p, "tenant.settings", tid)
    return STORE.tenants[tid]


# ---------- TrustOps Core bounded execution runtime ----------
def runtime_enabled() -> bool:
    # This implementation only ships a synthetic Mock SAP connector. It must never
    # masquerade as a production ERP connector when this TAAD service is deployed.
    return ENV in ("local", "dev") and os.environ.get("TRUSTOPS_RUNTIME_MODE", "sandbox") == "sandbox"


def runtime_run(p: Principal, run_id: str) -> dict[str, Any]:
    run = STORE.workflow_runs.get(run_id)
    if not run or (not p.is_staff and run["tenant_id"] != p.tenant_id):
        raise err(404, "not_found", "Workflow run not found")
    return run


@app.get("/v1/agentops")
def agentops(p: Principal = Depends(principal)):
    require(p, "cloudseals_admin", "cloudseals_platform_ops", "cloudseals_reviewer", "cloudseals_assessor",
            "customer_admin", "customer_architect", "customer_risk", "auditor_readonly")
    runs = [r for r in STORE.workflow_runs.values() if p.is_staff or r["tenant_id"] == p.tenant_id]
    return {"mode": "sandbox" if runtime_enabled() else "unavailable", "agents": trustops_runtime.AGENT_MANIFESTS,
            "workflow_pack": trustops_runtime.PACK_ID, "workflow_version": trustops_runtime.PACK_VERSION,
            "global_prohibitions": trustops_runtime.PACK["global_prohibitions"],
            "connector": trustops_runtime.PACK["connector"],
            "runs": len(runs), "completed": sum(r["status"] == "completed" for r in runs),
            "approval_required": sum(r["status"] == "approval_required" for r in runs),
            "escalated": sum(r["status"] == "escalated" for r in runs)}


@app.post("/v1/workflows/{pack_id}/runs", status_code=201)
def start_workflow(pack_id: str, body: WorkflowRunRequest, p: Principal = Depends(principal),
                   idempotency_key: Optional[str] = Header(default=None)):
    if not runtime_enabled():
        raise err(503, "runtime_unavailable", "Governed execution runtime is not enabled in this environment")
    require(p, "customer_admin", "customer_architect", "customer_risk", "customer_controller", "cloudseals_assessor", "cloudseals_admin")
    if pack_id != trustops_runtime.PACK_ID:
        raise err(404, "workflow_pack_not_found", "Workflow pack not found")

    def do():
        try:
            receipt_id = body.receipt.get("receipt_id")
            if any(x["tenant_id"] == p.tenant_id and x["receipt_id"] == receipt_id
                   for x in STORE.workflow_runs.values()):
                raise err(409, "duplicate_receipt", "Receipt has already been submitted for this tenant")
            run = trustops_runtime.run_agents(p.tenant_id or "", p.sub, body.receipt, body.invoices, body.remittance)
        except trustops_runtime.RuntimeErrorCode as e:
            raise err(422, e.code, str(e)) from e
        run_id = str(uuid.uuid4())
        run["run_id"] = run_id
        run["approval_id"] = run_id if run["policy_decision"]["approval_required"] else None
        STORE.workflow_runs[run_id] = run
        emit("trustops.workflow.run_started.v1", run["tenant_id"], {"run_id": run_id, "workflow_id": pack_id,
             "workflow_version": run["workflow_version"], "input_digest": run["input_digest"],
             "policy_decision": run["policy_decision"]["decision"]})
        audit(p, "trustops.workflow.start", run_id)
        return run
    return idempotent(p, idempotency_key, f"workflow:{pack_id}", do)


@app.get("/v1/runs/{run_id}")
def get_workflow_run(run_id: str, p: Principal = Depends(principal)):
    run = runtime_run(p, run_id)
    return {k: v for k, v in run.items() if k != "created_by"}


@app.post("/v1/approvals/{approval_id}/decision")
def runtime_approval(approval_id: str, body: RuntimeApprovalDecision, p: Principal = Depends(principal),
                     idempotency_key: Optional[str] = Header(default=None)):
    run = runtime_run(p, approval_id)
    require(p, "customer_controller")
    if run.get("approval_id") != approval_id:
        raise err(409, "approval_not_pending", "No pending approval exists for this run")
    if p.sub == run["created_by"]:
        raise err(403, "maker_checker_violation", "The workflow initiator cannot approve their own action")

    def do():
        if run["status"] != "approval_required":
            raise err(409, "approval_not_pending", "No pending approval exists for this run")
        run["approval"] = {"decision": body.decision, "by": p.sub, "reason": body.reason, "at": time.time()}
        if body.decision == "approve":
            run["status"] = "approved_to_prepare"
        else:
            run["status"] = "rejected"
        append = trustops_runtime.append_evidence(STORE.runtime_evidence, run["tenant_id"], approval_id,
                                                 "approval.decision", run["approval"])
        audit(p, f"trustops.approval.{body.decision}", approval_id)
        emit("trustops.approval.decision.v1", run["tenant_id"], {"run_id": approval_id,
             "decision": body.decision, "evidence_hash": append["record_hash"]})
        return {"run_id": approval_id, "status": run["status"], "approval": run["approval"]}
    return idempotent(p, idempotency_key, f"runtime-approval:{approval_id}", do)


@app.post("/v1/execution/prepare")
def prepare_execution(body: PrepareActionRequest, p: Principal = Depends(principal),
                      idempotency_key: Optional[str] = Header(default=None)):
    run = runtime_run(p, body.run_id)
    require(p, "customer_admin", "customer_architect", "customer_risk", "customer_controller", "cloudseals_assessor", "cloudseals_admin")
    if not runtime_enabled():
        raise err(503, "runtime_unavailable", "Governed execution runtime is not enabled in this environment")
    if not idempotency_key or len(idempotency_key) > 128:
        raise err(400, "idempotency_key_required", "Idempotency-Key header required (max 128 chars)")
    key = (p.sub, f"runtime-prepare:{body.run_id}", idempotency_key)
    with STORE.lock:
        if key in STORE.idempotency:
            return {**STORE.idempotency[key], "action_token": None,
                    "note": "Token is returned only in the original response. Use a new idempotency key to rotate it."}
        if run["status"] not in ("ready_to_prepare", "approved_to_prepare", "prepared") or not run.get("proposal"):
            raise err(409, "policy_not_authorized", "Policy or approval state does not authorize preparation")

        def do():
            proposal = run["proposal"]
            digest = trustops_runtime.canonical_digest(proposal)
            now = int(time.time())
            nonce = secrets.token_urlsafe(18)
            claims = {"run_id": body.run_id, "tenant_id": run["tenant_id"], "sub": p.sub,
                      "proposal_digest": digest, "jti": nonce, "iat": now,
                      "exp": now + trustops_runtime.TOKEN_TTL_SECONDS}
            try:
                token = trustops_runtime.issue_action_token(trustops_runtime.token_secret(ENV), claims)
            except trustops_runtime.RuntimeErrorCode as e:
                raise err(503, e.code, str(e)) from e
            precommit = trustops_runtime.append_evidence(STORE.runtime_evidence, run["tenant_id"], body.run_id,
                "execution.pre_commit", {"proposal_digest": digest, "policy_id": run["policy_decision"]["policy_id"],
                "policy_version": run["policy_decision"]["policy_version"], "approval": run.get("approval"),
                "agent_trace": run["agent_trace"]})
            run["prepared_action"] = {"proposal_digest": digest, "prepared_by": p.sub, "prepared_at": time.time(),
                "pre_commit_evidence_hash": precommit["record_hash"], "expires_at": now + trustops_runtime.TOKEN_TTL_SECONDS}
            token_digest = hashlib.sha256(token.encode()).hexdigest()
            for old in STORE.action_tokens.values():
                if old["run_id"] == body.run_id:
                    old["used"] = True
            STORE.action_tokens[token_digest] = {"run_id": body.run_id, "tenant_id": run["tenant_id"],
                "sub": p.sub, "jti": nonce, "used": False, "expires_at": now + trustops_runtime.TOKEN_TTL_SECONDS}
            run["status"] = "prepared"
            audit(p, "trustops.execution.prepare", body.run_id)
            return {"run_id": body.run_id, "status": run["status"], "prepared_action": run["prepared_action"],
                    "action_token": token, "token_expires_in_seconds": trustops_runtime.TOKEN_TTL_SECONDS,
                    "connector": "mock_sap"}
        result = do()
        # Never persist bearer action tokens in the database/snapshot or idempotency record.
        STORE.idempotency[key] = {k: v for k, v in result.items() if k != "action_token"}
        return result


@app.post("/v1/execution/execute")
def execute_action(body: ExecuteActionRequest, p: Principal = Depends(principal),
                   idempotency_key: Optional[str] = Header(default=None)):
    run = runtime_run(p, body.run_id)
    require(p, "customer_admin", "customer_architect", "customer_risk", "customer_controller", "cloudseals_assessor", "cloudseals_admin")
    if not runtime_enabled():
        raise err(503, "runtime_unavailable", "Governed execution runtime is not enabled in this environment")
    if run["status"] == "completed" and run.get("execution"):
        return run["execution"]
    if run["status"] != "prepared" or not run.get("prepared_action"):
        raise err(409, "action_not_prepared", "Action must pass policy, approval, and evidence pre-commit")
    try:
        claims = trustops_runtime.verify_action_token(trustops_runtime.token_secret(ENV), body.action_token)
    except trustops_runtime.RuntimeErrorCode as e:
        raise err(403, e.code, str(e)) from e
    token_digest = hashlib.sha256(body.action_token.encode()).hexdigest()
    record = STORE.action_tokens.get(token_digest)
    proposal_digest = trustops_runtime.canonical_digest(run["proposal"])
    if (not record or record["used"] or claims.get("run_id") != body.run_id
            or claims.get("tenant_id") != run["tenant_id"] or claims.get("sub") != p.sub
            or claims.get("proposal_digest") != proposal_digest or claims.get("jti") != record["jti"]
            or record["run_id"] != body.run_id or record["tenant_id"] != run["tenant_id"]
            or record["sub"] != p.sub):
        raise err(403, "action_token_scope_mismatch", "Action token is invalid, used, or scoped to another action")
    if run["prepared_action"]["proposal_digest"] != proposal_digest:
        raise err(409, "prepared_action_changed", "Prepared payload changed after evidence pre-commit")

    def do():
        if run["status"] == "completed" and run.get("execution"):
            return run["execution"]
        if record["used"]:
            raise err(409, "action_token_used", "Action token was already consumed")
        record["used"] = True
        # This deterministic mock connector is the only executable adapter in this project.
        ack = STORE.mock_sap.get(body.run_id)
        if ack is None:
            ack = {"ack_id": "MOCK-SAP-" + body.run_id[:12], "status": "accepted",
                   "action_digest": proposal_digest, "connector": "mock_sap", "at": time.time()}
            STORE.mock_sap[body.run_id] = ack
        commit = trustops_runtime.append_evidence(STORE.runtime_evidence, run["tenant_id"], body.run_id,
            "execution.commit", {"acknowledgement": ack, "proposal_digest": proposal_digest,
                                  "pre_commit_hash": run["prepared_action"]["pre_commit_evidence_hash"]})
        result = {"run_id": body.run_id, "status": "completed", "connector": "mock_sap",
                  "acknowledgement": ack, "commit_evidence_hash": commit["record_hash"]}
        run["execution"] = result
        run["status"] = "completed"
        audit(p, "trustops.execution.complete", body.run_id)
        emit("trustops.execution.completed.v1", run["tenant_id"], result)
        return result
    return idempotent(p, idempotency_key, f"runtime-execute:{body.run_id}", do)


@app.post("/v1/evidence/{run_id}/verify")
def verify_runtime_evidence(run_id: str, p: Principal = Depends(principal)):
    run = runtime_run(p, run_id)
    records = [r for r in STORE.runtime_evidence if r["run_id"] == run_id and r["tenant_id"] == run["tenant_id"]]
    valid = trustops_runtime.verify_evidence(STORE.runtime_evidence, run["tenant_id"])
    return {"run_id": run_id, "valid": valid, "records": records,
            "integrity": "local_hash_chain_only", "production_signature": False}


# ---------- assessment detail, progress, assignments ----------
def progress(a: dict) -> dict:
    ans = all_answers(a["assessment_id"])
    required = [q["question_id"] for q in REG.questions.values() if q["required"] == "yes" and q["enabled"] and q["scope"] == "org"]
    done = sum(q in ans for q in required)
    return {"required_total": len(required), "required_answered": done, "answers_total": len(ans)}


@app.get("/v1/assessments/{aid}")
def assessment_detail(aid: str, p: Principal = Depends(principal)):
    a = get_assessment(p, aid)
    return {**a, "progress": progress(a), "assignments": STORE.assignments.get(aid, {})}


@app.get("/v1/assessments/{aid}/answers")
def list_answers(aid: str, p: Principal = Depends(principal)):
    get_assessment(p, aid)
    return {"items": [{k: v for k, v in rec.items()} for (x, _s, _q), rec in sorted(STORE.answers.items()) if x == aid]}


@app.post("/v1/assessments/{aid}/assignments")
def assign(aid: str, body: Assignment, p: Principal = Depends(principal)):
    get_assessment(p, aid)
    require(p, "customer_admin", "customer_architect")
    target = STORE.users.get(body.sub)
    if not target or target["tenant_id"] != p.tenant_id:
        raise err(404, "not_found", "Member not found")
    valid = {q["section"] for q in REG.questions.values()}
    if not set(body.sections) <= valid:
        raise err(422, "unknown_section", "Unknown section")
    STORE.assignments.setdefault(aid, {})[body.sub] = body.sections
    audit(p, "assignment.set", f"{aid}/{body.sub}")
    return {"sub": body.sub, "sections": body.sections}


# ---------- reviewer finding adjustment ----------
@app.post("/v1/assessments/{aid}/findings/{rule_id}/review")
def review_finding(aid: str, rule_id: str, body: FindingReview, p: Principal = Depends(principal)):
    get_assessment(p, aid)
    require(p, "cloudseals_reviewer", "cloudseals_assessor")
    if any(r["assessment_id"] == aid and r["status"] == "published" for r in STORE.reports.values()):
        raise err(409, "published", "Published report findings are frozen; issue a new report version")
    f = next((x for x in STORE.findings.get(aid, []) if x["rule_id"] == rule_id), None)
    if not f:
        raise err(404, "not_found", "Finding not found")
    f.setdefault("review_history", []).append({"from": f["status"], "to": body.status, "by": p.sub,
                                               "reason": body.reason, "at": time.time()})
    f["status"], f["reviewer_status"] = body.status, "reviewed"
    audit(p, "finding.review", f"{aid}/{rule_id}")
    return f


# ---------- report download ----------
def render_model(a: dict, r: dict) -> dict:
    aid = a["assessment_id"]
    published = r["status"] == "published"
    findings = r["findings_snapshot"] if published else STORE.findings.get(aid, [])
    ans = all_answers(aid)
    meta: dict[str, dict] = {}
    for (x, _s, qid), rec in STORE.answers.items():
        if x == aid:
            meta[qid] = {"evidence_refs": rec["evidence_refs"], "comment": rec["comment"]}
    return reporting.build_model(REG, a, ans, meta, findings, STORE.not_assessed.get(aid, []), r["status"], r.get("review"))


@app.get("/v1/assessments/{aid}/reports/{rid}/download")
def download_report(aid: str, rid: str, format: Literal["docx", "pdf", "json"] = "pdf", p: Principal = Depends(principal)):
    a = get_assessment(p, aid)
    r = STORE.reports.get(rid)
    if not r or r["assessment_id"] != aid:
        raise err(404, "not_found", "Report not found")
    if not p.is_staff and r["status"] != "published":
        prelim = STORE.tenants.get(a["tenant_id"], {}).get("allow_preliminary_report") and r["status"] == "draft"
        if not prelim:
            raise err(404, "not_found", "Report not found")
    model = render_model(a, r)
    audit(p, "report.download", f"{rid}:{format}")
    if format == "json":
        return JSONResponse(model)
    body = reporting.render_docx(model) if format == "docx" else reporting.render_pdf(model)
    mime = ("application/vnd.openxmlformats-officedocument.wordprocessingml.document" if format == "docx" else "application/pdf")
    name = f"taad-{model['status'].lower()}-{rid[:8]}.{format}"
    return Response(body, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}"',
                                                    "X-Report-Status": model["status"]})


# ---------- admin operations ----------
@app.get("/v1/admin/review-queue")
def review_queue(p: Principal = Depends(principal)):
    require(p, "cloudseals_admin", "cloudseals_reviewer", "cloudseals_assessor", "cloudseals_platform_ops")
    return {"items": [{"report_id": r["report_id"], "assessment_id": r["assessment_id"], "tenant_id": r["tenant_id"],
                       "finding_count": r["finding_count"], "status": r["status"]}
                      for r in STORE.reports.values() if r["status"] in ("draft", "clarification_requested")]}


@app.get("/v1/admin/activity")
def activity(limit: int = 100, p: Principal = Depends(principal)):
    require(p, "cloudseals_admin", "cloudseals_platform_ops", "auditor_readonly")
    return {"items": STORE.audit[-min(max(limit, 1), 500):][::-1]}


# ---------- portal (static, same origin) ----------
_portal = ROOT / "apps" / "portal-web"
@app.get("/portal/config.json")
def portal_config():
    """Use seeded users only for local development; deployed portals require real OIDC config."""
    if ENV == "local" and AUTH_MODE == "dev":
        return {"mode": "dev", "oidc": {}}
    if AUTH_MODE != "oidc":
        raise err(503, "portal_auth_misconfigured", "Portal requires OIDC authentication outside local development")
    oidc = {
        "authorize_url": os.environ.get("TAAD_PORTAL_AUTHORIZE_URL", ""),
        "token_url": os.environ.get("TAAD_PORTAL_TOKEN_URL", ""),
        "client_id": os.environ.get("TAAD_PORTAL_CLIENT_ID", ""),
        "redirect_uri": os.environ.get("TAAD_PORTAL_REDIRECT_URI", ""),
        "logout_url": os.environ.get("TAAD_PORTAL_LOGOUT_URL", ""),
        "scope": "openid email",
    }
    for key in ("authorize_url", "token_url", "logout_url", "redirect_uri"):
        parsed = urlparse(oidc[key])
        if parsed.scheme != "https" or not parsed.netloc:
            raise err(503, "portal_auth_misconfigured", "Cognito sign-in is not fully configured for this portal")
    if not oidc["client_id"]:
        raise err(503, "portal_auth_misconfigured", "Cognito sign-in is not fully configured for this portal")
    return {"mode": "oidc", "oidc": oidc}


if _portal.is_dir():
    app.mount("/portal", StaticFiles(directory=str(_portal), html=True), name="portal")


# ---------- local development helpers (never mounted outside ENV=local with dev auth) ----------
if ENV == "local" and AUTH_MODE == "dev":
    @app.get("/v1/dev/users")
    def dev_users():
        return {"items": [{"sub": s, "roles": u["roles"], "tenant_id": u["tenant_id"], "token": issue_token(s)}
                          for s, u in STORE.users.items()]}
