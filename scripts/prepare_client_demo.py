"""Prepare a repeatable synthetic client demo through the real LOCAL API.

No model stubs, database edits, deleted data, live ERP writes or cloud changes.
Run: python scripts/prepare_client_demo.py --output ../outputs/trustops-demo
"""
from __future__ import annotations

import argparse
import hashlib
import json
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

NAME = "DEMO | Example Bank — AI payment operations"
REGISTER = b"SYNTHETIC CLIENT DEMO ONLY. Example Bank is fictional.\nAI register: an AI-assisted payments workflow reads receipts, matches invoices and proposes allocations. Operations owns the workflow. Finance controllers approve high-value actions.\nThe workflow uses payment reference, amount and currency. The demo connector is mock_sap; no real ERP or customer account is changed.\nMissing documents: a signed model evaluation report and a retention schedule have not been supplied. Missing evidence is not proof of a missing control.\n"
POLICY = b"SYNTHETIC CLIENT DEMO ONLY. Example Bank policy example.\nHigh-value payment allocations need controller approval. The initiator cannot approve their own action. Ambiguous matches must be escalated. Actions require an evidence pre-commit and a scoped one-use token.\nThis sample is not an approved customer policy or a compliance certificate.\n"


def prepare(base: str, output: Path) -> dict:
    parsed = urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.username or parsed.password:
        raise SystemExit("Demo preparation only accepts an HTTP localhost service.")

    def request(method, path, body=None, who=None, raw=None, extra=None, allow=()):
        headers = dict(extra or {})
        if who:
            headers["Authorization"] = "Bearer " + tokens[who]
        if method in ("POST", "PUT"):
            headers["Idempotency-Key"] = str(uuid.uuid4())
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        try:
            with urlopen(Request(base + path, method=method, headers=headers, data=data), timeout=30) as response:
                payload = response.read()
                return json.loads(payload) if "application/json" in response.headers.get("Content-Type", "") else payload
        except HTTPError as exc:
            if exc.code in allow:
                return {"http_status": exc.code, "body": json.loads(exc.read())}
            raise RuntimeError(f"{method} {path}: {exc.code} {exc.read().decode()[:400]}") from exc

    cfg = request("GET", "/portal/config.json")
    if cfg["mode"] != "dev":
        raise SystemExit("Seeded local demo authentication is required. Refusing deployed or OIDC environments.")
    tokens = {user["sub"]: user["token"] for user in request("GET", "/v1/dev/users")["items"]}
    customer, reviewer = "admin@t-bank", "reviewer@cloudseals"
    assessments = request("GET", "/v1/assessments", who=customer)["items"]
    assessment = next((a for a in assessments if a["ai_system_name"] == NAME), None)
    if assessment is None:
        assessment = request("POST", "/v1/assessments", {"ai_system_name": NAME, "industry": "banking", "questionnaire_version": "1.0.0"}, customer)
    aid = assessment["assessment_id"]
    root = f"/v1/assessments/{aid}"
    existing = request("GET", root + "/evidence", who=customer)["items"]
    for filename, content in (("DEMO-ai-register.txt", REGISTER), ("DEMO-approval-policy.txt", POLICY)):
        if any(e["filename"] == filename and e["state"] == "clean" for e in existing):
            continue
        grant = request("POST", root + "/evidence/upload-url", {"filename": filename, "content_type": "text/plain", "file_size_bytes": len(content), "claimed_sha256": hashlib.sha256(content).hexdigest()}, customer)
        uploaded = request("PUT", grant["upload_url"], who=customer, raw=content, extra={"Content-Type": "application/octet-stream"})
        assert uploaded["state"] == "clean", uploaded
    if assessment["status"] == "In progress":
        values = {"Q-BASE-001": "Example Bank (synthetic demo)", "Q-BASE-002": "banking", "Q-BASE-003": ["United Kingdom"], "Q-BASE-005": "Agentic AI", "Q-BASE-006": "Yes", "Q-BASE-007": "Unknown", "Q-IAM-002": "Yes", "Q-HIT-015": "No", "Q-AIA-017": "No"}
        old = {a["question_id"]: a for a in request("GET", root + "/answers", who=customer)["items"]}
        for qid, value in values.items():
            request("PUT", root + "/answers/" + qid, {"scope_id": "org", "value": value, "answer_status": "answered", "evidence_refs": []}, customer, extra={"If-Match": old.get(qid, {}).get("etag", "0")})
        request("POST", root + "/submit", who=customer)
    report = request("GET", root + "/reports", who=reviewer)["items"][0]
    if report["status"] != "published":
        request("POST", root + f"/reviews/{report['report_id']}/decision", {"decision": "approve", "reviewer_reason": "Synthetic demonstration review only. Checks questionnaire answers against demo fixtures; not a real customer sign-off or AI document assessment."}, reviewer)
    output.mkdir(parents=True, exist_ok=True)
    for fmt in ("pdf", "docx"):
        payload = request("GET", root + f"/reports/{report['report_id']}/download?format={fmt}", who=customer)
        assert len(payload) > 1000
        (output / ("synthetic-assessment-report." + fmt)).write_bytes(payload)
    (output / "DEMO-ai-register.txt").write_bytes(REGISTER)
    (output / "DEMO-approval-policy.txt").write_bytes(POLICY)
    runs = request("GET", "/v1/runs?limit=100", who=customer)["items"]
    prepared_runs = {}
    for scenario, amount in (("MATCH", 25000), ("APPROVAL", 150000), ("AMBIGUOUS", 25000), ("NO-MATCH", 25000), ("APPROVED", 150000)):
        receipt_id = "DEMO-" + scenario
        run = next((r for r in runs if r["receipt_id"] == receipt_id), None)
        if scenario == "APPROVAL" and run and run["status"] != "approval_required":
            # A previous presentation may have approved it. Create a new sample,
            # preserving the old decision and its evidence rather than resetting it.
            run = None
        if run is None:
            invoice = {"invoice_id": "DEMO-INV-" + scenario, "amount_minor": amount, "currency": "USD", "reference": receipt_id}
            invoices = [invoice, {**invoice, "invoice_id": "DEMO-INV-OTHER"}] if scenario == "AMBIGUOUS" else [{**invoice, "reference": "OTHER-REFERENCE", "amount_minor": amount + 100}] if scenario == "NO-MATCH" else [invoice]
            run = request("POST", "/v1/workflows/ledgersight.ar_cash/runs", {"receipt": {"receipt_id": receipt_id, "amount_minor": amount, "currency": "USD", "reference": receipt_id}, "invoices": invoices, "remittance": {"reference": receipt_id}}, customer)
        if scenario == "APPROVED" and run["status"] == "approval_required":
            request("POST", f"/v1/approvals/{run['run_id']}/decision", {"decision": "approve", "reason": "Synthetic rehearsal approval only; not a customer sign-off."}, "controller@t-bank")
        if scenario in ("MATCH", "APPROVED") and run["status"] != "completed":
            prepared = request("POST", "/v1/execution/prepare", {"run_id": run["run_id"]}, customer)
            assert prepared["action_token"], "A previous partial setup consumed the token. Start a fresh demo scenario from the UI."
            executed = request("POST", "/v1/execution/execute", {"run_id": run["run_id"], "action_token": prepared["action_token"]}, customer)
            assert executed["connector"] == "mock_sap" and executed["status"] == "completed"
        evidence = request("POST", f"/v1/evidence/{run['run_id']}/verify", who=customer)
        assert evidence["valid"], evidence
        prepared_runs[scenario.lower()] = {"run_id": run["run_id"], "evidence_valid": evidence["valid"], "integrity": evidence["integrity"]}
    # Negative checks demonstrate existing role and tenant boundaries; they do not alter approvals.
    approval_id = prepared_runs["approval"]["run_id"]
    denied = request("POST", f"/v1/approvals/{approval_id}/decision", {"decision": "approve", "reason": "Synthetic negative permission check"}, customer, allow=(403,))
    assert denied["http_status"] == 403
    isolated = request("GET", root, who="admin@t-health", allow=(404,))
    assert isolated["http_status"] == 404
    manifest = {"synthetic": True, "base_url": base, "assessment_id": aid, "report_id": report["report_id"], "report_type": "questionnaire_rules", "assessment_model": cfg.get("assessment_model"), "runs": prepared_runs, "customer_cannot_approve": True, "tenant_isolation": True}
    (output / "demo-readiness.json").write_text(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8017")
    parser.add_argument("--output", type=Path, default=Path("../outputs/trustops-demo"))
    args = parser.parse_args()
    print(json.dumps(prepare(args.base_url.rstrip("/"), args.output), indent=2))
