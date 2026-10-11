"""Run all 11 agents end to end against the real app code: python scripts/run_agents.py (or `make agents`).

Deterministic by default; set TAAD_SWASKA_MODEL=bedrock / TRUSTOPS_AGENT_MODEL_ID to route through Bedrock.
"""
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "packages/question-engine"), str(ROOT / "packages/reporting"), str(ROOT / "apps/assessment-api"), str(ROOT)]

from app.main import app  # noqa: E402
from app.seed import seed  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from tests.conftest import BANK, fill_required, new_assessment  # noqa: E402

tokens = seed()
c = TestClient(app)
results: list[tuple[str, str, str]] = []


def h(sub, **x):
    return {"Authorization": f"Bearer {tokens[sub]}", **x}


def record(agent, ok, detail):
    results.append((agent, "OK" if ok else "FAIL", detail))
    print(f"[{'OK' if ok else 'FAIL'}] {agent}: {detail}")


aid = new_assessment(c, h, "admin@t-bank")
fill_required(c, h, "admin@t-bank", aid, BANK)

# 1. Swaska diagnostic interviewer
t = c.post(f"/v1/assessments/{aid}/swaska/turns", headers=h("admin@t-bank"),
           json={"scope_id": "org", "user_message": "What evidence helps?", "parent_question_id": "Q-BASE-006"})
record("cloudseals.swaska.diagnostic_interviewer", t.status_code == 200, t.json().get("clarification_text", t.text)[:90])

# 2. Evidence extractor
data = b"Q-BASE-006: Yes\nQ-IAM-002: Yes\n"
g = c.post(f"/v1/assessments/{aid}/evidence/upload-url", headers=h("admin@t-bank"),
           json={"filename": "arch.txt", "content_type": "text/plain", "file_size_bytes": len(data),
                 "claimed_sha256": hashlib.sha256(data).hexdigest()}).json()
c.put(g["upload_url"], headers=h("admin@t-bank"), content=data)
x = c.post(f"/v1/assessments/{aid}/agents/extraction", headers=h("admin@t-bank"), json={"evidence_id": g["evidence_id"]})
record("cloudseals.swaska.evidence_extractor", x.status_code == 200 and len(x.json()["items"]) == 2,
       f"{len(x.json().get('items', []))} unverified candidates, mode={x.json().get('mode')}")

# 3. Diagnosis -> findings summarizer
assert c.post(f"/v1/assessments/{aid}/submit", headers=h("admin@t-bank", **{"Idempotency-Key": "s"})).status_code == 202
f = c.post(f"/v1/assessments/{aid}/agents/findings-summary", headers=h("reviewer@cloudseals"))
record("cloudseals.swaska.findings_summarizer", f.status_code == 200, f"{len(f.json().get('items', []))} findings summarised")

# 4. Review -> blueprint -> POC drafter
rid = c.get(f"/v1/assessments/{aid}/reports", headers=h("reviewer@cloudseals")).json()["items"][0]["report_id"]
c.post(f"/v1/assessments/{aid}/reviews/{rid}/decision", headers=h("reviewer@cloudseals", **{"Idempotency-Key": "d"}),
       json={"decision": "approve", "reviewer_reason": "demo review"})
bp = c.post(f"/v1/assessments/{aid}/poc-blueprints", headers=h("architect@cloudseals", **{"Idempotency-Key": "b"}),
            json={"report_id": rid, "workflow_pack_id": "ledgersight.ar_cash", "customer_security_signoff_ref": "SEC-1",
                  "cloudseals_architect_signoff_ref": "ARCH-1", "success_criteria": ["90% exact-match auto-prepared"]}).json()
n = c.post(f"/v1/assessments/{aid}/poc-blueprints/{bp['blueprint_id']}/draft-notes", headers=h("architect@cloudseals"))
record("cloudseals.swaska.poc_drafter", n.status_code == 200, n.json().get("scope_summary", n.text)[:90])

# 5-10. Six LedgerSight workers (high value -> approval required) + 11. approval summarizer
body = {"receipt": {"receipt_id": "R-DEMO", "amount_minor": 999999999, "currency": "USD", "reference": "INV-1"},
        "invoices": [{"invoice_id": "I-1", "amount_minor": 999999999, "currency": "USD", "reference": "INV-1"}],
        "remittance": {"reference": "INV-1"}}
run = c.post("/v1/workflows/ledgersight.ar_cash/runs", headers=h("admin@t-bank", **{"Idempotency-Key": "r"}), json=body)
trace = run.json().get("agent_trace", [])
for step in trace:
    record(step["agent_id"], step["status"] not in ("failed",), step["status"])
record("ledgersight (6 workers)", len(trace) == 6, f"policy={run.json()['policy_decision']['decision']} status={run.json()['status']}")
s = c.get(f"/v1/runs/{run.json()['run_id']}/approval-summary", headers=h("admin@t-bank"))
record("trustops.approval_summarizer", s.status_code == 200, s.json().get("decision_reason", s.text))

bad = [r for r in results if r[1] != "OK"]
print(f"\n{len(results) - len(bad)}/{len(results)} checks passed")
sys.exit(1 if bad else 0)
