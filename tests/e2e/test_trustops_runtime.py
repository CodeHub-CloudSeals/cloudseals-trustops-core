from copy import deepcopy

from app.main import STORE


def request_body(receipt_id="R-1", amount=25000, invoices=None):
    return {"receipt": {"receipt_id": receipt_id, "amount_minor": amount, "currency": "USD", "reference": "INV-1"},
            "invoices": invoices or [{"invoice_id": "I-1", "amount_minor": amount, "currency": "USD", "reference": "INV-1"}],
            "remittance": {"reference": "INV-1"}}


def test_six_agents_low_value_policy_precommit_gateway_and_evidence(env):
    c, h = env
    started = c.post("/v1/workflows/ledgersight.ar_cash/runs", headers=h("admin@t-bank", **{"Idempotency-Key": "run-1"}),
                     json=request_body())
    assert started.status_code == 201, started.text
    run = started.json()
    assert len(run["agent_trace"]) == 6
    assert run["policy_decision"]["decision"] == "ALLOW"
    assert run["status"] == "ready_to_prepare"

    prepared = c.post("/v1/execution/prepare", headers=h("admin@t-bank", **{"Idempotency-Key": "prepare-1"}),
                      json={"run_id": run["run_id"]})
    assert prepared.status_code == 200, prepared.text
    token = prepared.json()["action_token"]
    assert token and prepared.json()["connector"] == "mock_sap"
    assert prepared.json()["prepared_action"]["pre_commit_evidence_hash"]
    assert all(token not in str(v) for v in STORE.idempotency.values())
    idem_retry = c.post("/v1/execution/prepare", headers=h("admin@t-bank", **{"Idempotency-Key": "prepare-1"}),
                        json={"run_id": run["run_id"]})
    assert idem_retry.status_code == 200 and idem_retry.json()["action_token"] is None
    altered = token[:-1] + ("0" if token[-1] != "0" else "1")
    rejected = c.post("/v1/execution/execute", headers=h("admin@t-bank", **{"Idempotency-Key": "bad-token"}),
                      json={"run_id": run["run_id"], "action_token": altered})
    assert rejected.status_code == 403 and len(STORE.mock_sap) == 0

    executed = c.post("/v1/execution/execute", headers=h("admin@t-bank", **{"Idempotency-Key": "execute-1"}),
                      json={"run_id": run["run_id"], "action_token": token})
    assert executed.status_code == 200, executed.text
    assert executed.json()["acknowledgement"]["connector"] == "mock_sap"
    assert len(STORE.mock_sap) == 1
    retry = c.post("/v1/execution/execute", headers=h("admin@t-bank", **{"Idempotency-Key": "execute-1"}),
                   json={"run_id": run["run_id"], "action_token": token})
    assert retry.status_code == 200 and len(STORE.mock_sap) == 1
    assert c.post(f"/v1/evidence/{run['run_id']}/verify", headers=h("admin@t-bank")).json()["valid"] is True
    assert c.get(f"/v1/runs/{run['run_id']}", headers=h("admin@t-health")).status_code == 404


def test_high_value_requires_distinct_human_approval_and_precommit(env):
    c, h = env
    started = c.post("/v1/workflows/ledgersight.ar_cash/runs", headers=h("controller@t-bank", **{"Idempotency-Key": "run-hi"}),
                     json=request_body(receipt_id="R-HIGH", amount=150000))
    run = started.json()
    assert run["status"] == "approval_required"
    self_approval = c.post(f"/v1/approvals/{run['run_id']}/decision", headers=h("controller@t-bank", **{"Idempotency-Key": "self"}),
                           json={"decision": "approve", "reason": "I approve"})
    assert self_approval.status_code == 403 and self_approval.json()["code"] == "maker_checker_violation"
    assert c.post("/v1/execution/prepare", headers=h("controller@t-bank", **{"Idempotency-Key": "blocked"}),
                  json={"run_id": run["run_id"]}).status_code == 409

    risk_decision = c.post(f"/v1/approvals/{run['run_id']}/decision", headers=h("risk@t-bank", **{"Idempotency-Key": "risk"}),
                           json={"decision": "approve", "reason": "Risk review approved"})
    assert risk_decision.status_code == 403
    approval = c.post(f"/v1/approvals/{run['run_id']}/decision", headers=h("controller2@t-bank", **{"Idempotency-Key": "approve"}),
                      json={"decision": "approve", "reason": "Controller review approved"})
    assert approval.status_code == 200 and approval.json()["status"] == "approved_to_prepare"
    prepared = c.post("/v1/execution/prepare", headers=h("controller@t-bank", **{"Idempotency-Key": "prepare-hi"}),
                      json={"run_id": run["run_id"]})
    assert prepared.status_code == 200
    executed = c.post("/v1/execution/execute", headers=h("controller@t-bank", **{"Idempotency-Key": "execute-hi"}),
                      json={"run_id": run["run_id"], "action_token": prepared.json()["action_token"]})
    assert executed.status_code == 200


def test_ambiguous_duplicate_and_tampered_evidence_fail_closed(env):
    c, h = env
    invoices = [{"invoice_id": "I-1", "amount_minor": 25000, "currency": "USD", "reference": "INV-1"},
                {"invoice_id": "I-2", "amount_minor": 25000, "currency": "USD", "reference": "INV-1"}]
    started = c.post("/v1/workflows/ledgersight.ar_cash/runs", headers=h("admin@t-bank", **{"Idempotency-Key": "run-amb"}),
                     json=request_body("R-AMB", invoices=invoices))
    assert started.status_code == 201 and started.json()["status"] == "escalated"
    assert started.json()["policy_decision"]["decision"] == "ESCALATE"
    blocked = c.post("/v1/execution/prepare", headers=h("admin@t-bank", **{"Idempotency-Key": "prepare-amb"}),
                     json={"run_id": started.json()["run_id"]})
    assert blocked.status_code == 409
    dupe = c.post("/v1/workflows/ledgersight.ar_cash/runs", headers=h("admin@t-bank", **{"Idempotency-Key": "run-amb-2"}),
                  json=request_body("R-AMB", invoices=invoices))
    assert dupe.status_code == 409 and dupe.json()["code"] == "duplicate_receipt"

    valid_run = c.post("/v1/workflows/ledgersight.ar_cash/runs", headers=h("admin@t-bank", **{"Idempotency-Key": "run-clean"}),
                       json=request_body("R-CLEAN" )).json()
    prepared = c.post("/v1/execution/prepare", headers=h("admin@t-bank", **{"Idempotency-Key": "prepare-clean"}),
                      json={"run_id": valid_run["run_id"]}).json()
    c.post("/v1/execution/execute", headers=h("admin@t-bank", **{"Idempotency-Key": "execute-clean"}),
           json={"run_id": valid_run["run_id"], "action_token": prepared["action_token"]})
    original = deepcopy(STORE.runtime_evidence[0]["payload"])
    STORE.runtime_evidence[0]["payload"]["tampered"] = True
    result = c.post(f"/v1/evidence/{valid_run['run_id']}/verify", headers=h("admin@t-bank")).json()
    assert result["valid"] is False
    STORE.runtime_evidence[0]["payload"] = original


def test_only_sandbox_runtime_can_run_agents(env, monkeypatch):
    c, h = env
    from app import main
    monkeypatch.setattr(main, "ENV", "prod")
    assert main.runtime_enabled() is False
    monkeypatch.setattr(main, "ENV", "local")
    monkeypatch.setenv("TRUSTOPS_RUNTIME_MODE", "disabled")
    r = c.post("/v1/workflows/ledgersight.ar_cash/runs", headers=h("admin@t-bank", **{"Idempotency-Key": "disabled"}),
               json=request_body())
    assert r.status_code == 503 and r.json()["code"] == "runtime_unavailable"
