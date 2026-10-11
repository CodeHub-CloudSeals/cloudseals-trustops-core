import json

import pytest
from app import main, studio, use_cases

from tests.conftest import new_assessment
from tests.e2e.test_use_cases import DOC, Fake, gap, uc, upload

UCS = [{"use_case_id": "uc_1", "name": "Credit scoring", "description": "Scores loan applicants.", "risk_tier": "high_risk",
        "business_owner": "Lending", "decision_authority": "autonomous", "source_quotes": ["credit scoring model assigns loan applicants a score"],
        "source_filename": "register.txt", "model_type": None, "foundation_models_used": [], "data_sources": [], "technical_owner": None}]
GAPS = [{"gap_id": "gap_1", "framework_id": "eu_ai_act", "framework_clause": "Article_5", "title": "No screening", "severity": "critical",
         "description": "No Article 5 screen.", "recommendation": "Run one.", "estimated_effort_days": 8}]


def maturity_json(**kw):
    base = {"scores": {p: 1.5 for p in studio.PRINCIPLES}, "rationale": {p: f"No evidence of {p} practice in the register." for p in studio.PRINCIPLES},
            "evidence_refs": {p: ["uc_1"] for p in studio.PRINCIPLES}, "improvement_priorities": ["P1 first"], "notes_for_architect": "Thin evidence."}
    return {**base, **kw}


def test_maturity_overall_is_computed_and_unevidenced_high_scores_are_capped():
    scores = {"model_agnostic": 4.0, "neuro_symbolic": 3.0, "digital_twin": 2.0, "evidence_fabric": 1.0, "model_welfare": 1.0}
    refs = {p: ["uc_1"] for p in scores} | {"model_agnostic": [], "neuro_symbolic": ["uc_999"]}   # one empty, one invented
    r = studio.run_maturity(Fake({**maturity_json(scores=scores, evidence_refs=refs), "overall_score": 4.9}), UCS, GAPS)["maturity"]
    assert r["scores"]["model_agnostic"] == 2.0 and r["scores"]["neuro_symbolic"] == 2.0       # capped: nothing real was cited
    assert r["overall_score"] == round((2 + 2 + 2 + 1 + 1) / 5, 2)                             # the model's own overall_score is ignored
    assert set(r["capped_for_missing_evidence"]) == {"P1 Model Agnostic", "P2 Neuro-Symbolic"} and r["status"] == "UNREVIEWED"
    assert r["evidence_refs"]["neuro_symbolic"] == []                                          # invented IDs are dropped


@pytest.mark.parametrize("bad", [
    maturity_json(scores={**maturity_json()["scores"], "digital_twin": 9}),
    maturity_json(scores={**maturity_json()["scores"], "digital_twin": True}),
    maturity_json(scores={"model_agnostic": 1}),
    maturity_json(rationale={**maturity_json()["rationale"], "model_welfare": "This organisation is fully compliant with everything"}),
    "not json", RuntimeError("down")])
def test_maturity_rejects_unusable_output(bad):
    r = studio.run_maturity(Fake(bad), UCS, GAPS)
    assert r["maturity"] is None and r["rejected"] == 1
    assert studio.run_maturity(None, UCS, GAPS)["mode"] == "unavailable"


def item(i, **kw):
    base = {"item_id": i, "title": f"Item {i}", "description": "Do the thing.", "frameworks_addressed": ["eu_ai_act", "made_up"],
            "gap_ids_addressed": ["gap_1"], "priority": 1, "effort_days": 5, "timeline_band": "0-90", "responsible_role": "Head of AI",
            "dependencies": [], "success_criteria": ["Signed off", "Register complete"], "estimated_cost_band": "low"}
    return {**base, **kw}


def run_road(*items, gaps=GAPS):
    return studio.run_roadmap(Fake({"roadmap_items": list(items), "executive_summary": "One critical gap needs action now."}), gaps, None)


def test_roadmap_forces_critical_gaps_into_90_days_and_computes_totals():
    r = run_road(item("a", timeline_band="365+"), item("b", title="Second", gap_ids_addressed=["gap_1"], effort_days=2.5, dependencies=["a", "ghost", "b"]))
    first = next(i for i in r["items"] if i["title"] == "Item a")
    assert first["timeline_band"] == "0-90" and first["timeline_adjusted"] is True
    assert r["summary"]["total_effort_days"] == 7.5 and r["summary"]["by_timeline"]["0-90"] == 2
    second = next(i for i in r["items"] if i["title"] == "Second")
    assert second["dependencies"] == [first["item_id"]]                  # ghost and self references are dropped, real ones are remapped
    assert first["frameworks_addressed"] == ["eu_ai_act"] and r["uncovered_gaps"] == []


def test_roadmap_validation_and_cycles():
    for bad in (item("a", gap_ids_addressed=["gap_999"]), item("a", timeline_band="soon"), item("a", effort_days=0),
                item("a", success_criteria=["only one"]), item("a", estimated_cost_band="free"), item("a", description="Fully compliant already")):
        r = run_road(bad)
        assert r["items"] == [] and r["rejected"] == 1, bad
    r = run_road(item("a", dependencies=["b"]), item("b", title="B", dependencies=["a"]))
    assert r["summary"]["dependency_cycle_removed"] is True and all(i["dependencies"] == [] for i in r["items"])
    dup = run_road(item("a"), item("b", title="Item a"))
    assert len(dup["items"]) == 1 and dup["rejected"] == 1               # duplicate titles are consolidated
    high = [{**GAPS[0], "gap_id": "gap_2", "severity": "high"}]
    assert run_road(item("a", gap_ids_addressed=["gap_2"]), gaps=GAPS + high)["uncovered_gaps"] == ["gap_1"]


def test_report_escapes_everything_and_marks_drafts():
    evil = [{**UCS[0], "name": "<script>alert(1)</script>", "description": "<img src=x onerror=alert(1)>"}]
    doc, digest = studio.build_report_html({"ai_system_name": "A&B <i>", "tenant_id": "t"}, "T<Bank>", evil, [], None, [], None, "me")
    assert "<script>alert" not in doc and "<img src=x" not in doc and "&lt;script&gt;" in doc and "A&amp;B" in doc
    assert "DRAFT" in doc and len(digest) == 64
    final_m = {"scores": {p: 2.0 for p in studio.PRINCIPLES}, "overall_score": 2.0, "rationale": {p: "r" for p in studio.PRINCIPLES}}
    road = [{"item_id": "rm_1", "title": "T", "description": "D", "responsible_role": "R", "effort_days": 3, "estimated_cost_band": "low",
             "success_criteria": ["a", "b"], "timeline_band": "0-90"}]
    ok, _ = studio.build_report_html({"ai_system_name": "X", "tenant_id": "t"}, "T", UCS, GAPS, final_m, road, {"executive_summary": "Para one.\n\nPara two.", "key_themes": ["t"]}, "me")
    assert "DRAFT" not in ok and "FINAL" in ok and "AI-drafted narrative" in ok


def test_pipeline_end_to_end_through_the_api(env, monkeypatch):
    c, h = env
    rev, cust = "reviewer@cloudseals", "admin@t-bank"
    aid = new_assessment(c, h, cust)
    upload(c, h, aid, DOC.encode())
    monkeypatch.setattr(main, "SWASKA_CLIENT", Fake({"use_cases": [uc()]}))
    uid = c.post(f"/v1/assessments/{aid}/inventory/run", headers=h(cust), json={}).json()["use_cases"][0]["use_case_id"]
    ok = {"status": "validated", "reason": "Checked against the source"}
    assert c.post(f"/v1/assessments/{aid}/maturity/run", headers=h(rev)).status_code == 409          # nothing validated yet
    c.patch(f"/v1/assessments/{aid}/inventory/use-cases/{uid}", headers=h(rev), json=ok)

    monkeypatch.setattr(main, "SWASKA_CLIENT", Fake({"findings": [gap(severity="critical", evidence_use_case_ids=[uid])]}))
    gid = c.post(f"/v1/assessments/{aid}/gap-analysis/run", headers=h(rev), json={"framework_id": "eu_ai_act"}).json()["gaps"][0]["gap_id"]
    c.patch(f"/v1/assessments/{aid}/gaps/{gid}", headers=h(rev), json=ok)

    monkeypatch.setattr(main, "SWASKA_CLIENT", Fake(maturity_json(evidence_refs={p: [uid] for p in studio.PRINCIPLES})))
    assert c.post(f"/v1/assessments/{aid}/maturity/run", headers=h(cust)).status_code == 403
    m = c.post(f"/v1/assessments/{aid}/maturity/run", headers=h(rev)).json()
    assert m["maturity"]["status"] == "UNREVIEWED" and m["maturity"]["overall_score"] == 1.5
    assert c.patch(f"/v1/assessments/{aid}/maturity", headers=h(cust), json=ok).status_code == 403
    assert c.patch(f"/v1/assessments/{aid}/maturity", headers=h(rev), json=ok).json()["status"] == "VALIDATED"
    again = c.post(f"/v1/assessments/{aid}/maturity/run", headers=h(rev)).json()                      # a validated score is not replaced
    assert again["maturity"]["status"] == "VALIDATED"

    monkeypatch.setattr(main, "SWASKA_CLIENT", Fake({"roadmap_items": [item("a", gap_ids_addressed=[gid])], "executive_summary": "Act now."}))
    r = c.post(f"/v1/assessments/{aid}/roadmap/run", headers=h(rev)).json()
    rid = r["roadmap"][0]["item_id"]
    rep = c.get(f"/v1/assessments/{aid}/diagnostic-report?format=json", headers=h(rev)).json()
    assert rep["status"] == "DRAFT" and "no validated roadmap items" in rep["missing"]
    c.patch(f"/v1/assessments/{aid}/roadmap/{rid}", headers=h(rev), json=ok)
    final = c.get(f"/v1/assessments/{aid}/diagnostic-report", headers=h(rev))
    assert final.status_code == 200 and final.headers["x-report-status"] == "FINAL" and "attachment" in final.headers["content-disposition"]
    assert "Credit scoring model" in final.text and "Item a" in final.text and "DRAFT" not in final.text

    # customers and other tenants see none of it
    inv = c.get(f"/v1/assessments/{aid}/inventory", headers=h(cust)).json()
    assert inv["maturity"] is None and inv["roadmap"] == [] and inv["gaps"] == [] and len(inv["use_cases"]) == 1
    assert c.get(f"/v1/assessments/{aid}/diagnostic-report", headers=h(cust)).status_code == 403
    assert c.get(f"/v1/assessments/{aid}/diagnostic-report", headers=h("admin@t-health")).status_code == 404
    assert json.dumps(use_cases.FRAMEWORKS["eu_ai_act"]["framework"])
