import re

from playwright.sync_api import expect

from tests.browser.conftest import login

REQUIRED_DEFAULTS = None


def test_local_portal_opens_directly_without_seeded_user_picker(page, base_url):
    page.goto(base_url + "/portal/")
    page.evaluate("sessionStorage.clear()")
    page.reload()
    expect(page.get_by_role("heading", name="Command Center")).to_be_visible()
    assert page.get_by_role("button", name=re.compile(r"@t-bank|@t-health|@t-logistics|@cloudseals")).count() == 0
    expect(page.get_by_text("Local workspace")).to_be_visible()


def test_public_customer_registration_form_is_available(page, base_url):
    page.goto(base_url + "/portal/")
    page.evaluate("sessionStorage.clear()")
    page.goto(base_url + "/portal/#/register")
    expect(page.get_by_role("heading", name="Request workspace access")).to_be_visible()
    expect(page.get_by_label("Organisation name")).to_be_visible()
    expect(page.get_by_label("Work email")).to_be_visible()
    expect(page.get_by_label("Engagement reference")).to_be_visible()


def test_customer_workspace_handoff_modules(page, base_url):
    login(page, base_url, "admin@t-bank")
    for route, heading in (("dashboard", "Command Center"), ("reconciliation", "Reconciliation"),
                           ("exceptions", "Exceptions"), ("approvals", "Approvals"),
                           ("evidence", "Evidence"), ("readiness", "Readiness"), ("shadow-roi", "Shadow ROI")):
        page.goto(base_url + f"/portal/#/{route}")
        expect(page.get_by_role("heading", name=heading, exact=True)).to_be_visible()


def test_admin_registry_modules_are_discoverable(page, base_url):
    login(page, base_url, "reviewer@cloudseals")
    page.get_by_text("Administration", exact=True).click()
    for route, heading in (("integrations", "Integrations"), ("datasets", "Datasets"), ("workflows", "Workflows"),
                           ("agents", "Agents"), ("models", "Models"), ("policies", "Policies"),
                           ("authority", "Authority"), ("approval-matrix", "Approval matrix"), ("agentops", "AgentOps")):
        page.goto(base_url + f"/portal/#/{route}")
        expect(page.get_by_role("heading", name=heading, exact=True)).to_be_visible()


def fill_required_via_api(api, aid, overrides):
    """Answer every required org question quickly through the API (the UI path is covered separately)."""
    from app.main import REG
    for q in REG.questions.values():
        if q["scope"] != "org" or q["required"] != "yes":
            continue
        qid = q["question_id"]
        if qid in overrides:
            v = overrides[qid]
        elif q["response_type"] == "select_one":
            v = REG.option_sets[q["option_set"]][0]
        elif q["response_type"] == "select_multi":
            v = [REG.option_sets[q["option_set"]][0]]
        elif q["response_type"] == "number":
            v = 1
        else:
            v = "x"
        api("admin@t-bank", "PUT", f"/v1/assessments/{aid}/answers/{qid}", {"scope_id": "org", "value": v, "answer_status": "answered"},
            {"If-Match": "0"})
    for qid, v in overrides.items():   # overrides that are not required org questions (e.g. IAM, HIT, AIA)
        cur = api("admin@t-bank", "GET", f"/v1/assessments/{aid}/answers")["items"]
        etag = next((a["etag"] for a in cur if a["question_id"] == qid), "0")
        api("admin@t-bank", "PUT", f"/v1/assessments/{aid}/answers/{qid}", {"scope_id": "org", "value": v, "answer_status": "answered"},
            {"If-Match": etag})


def test_login_create_answer_and_resume(page, base_url):
    login(page, base_url, "admin@t-bank")
    page.get_by_label("AI system name").fill("Browser test system")
    page.get_by_role("button", name="Create assessment").click()
    expect(page.get_by_role("heading", name=re.compile("Browser test system"))).to_be_visible()
    # answer the first question of the first section through the UI
    first = page.locator(".q-card select").first
    first.select_option(index=1)
    expect(page.locator(".q-status", has_text="Saved").first).to_be_visible()
    value = first.input_value()
    page.reload()
    page.wait_for_selector("h2")
    expect(page.locator(".q-card select").first).to_have_value(value)   # resumed from server
    expect(page.get_by_text("Required answers: 1 of")).to_be_visible()


def test_trustops_six_agent_page_runs_and_displays_trace(page, base_url):
    login(page, base_url, "admin@t-bank")
    page.get_by_role("link", name="TrustOps").click()
    expect(page.get_by_role("heading", name="LedgerSight AR / Cash")).to_be_visible()
    expect(page.get_by_text(re.compile("Deterministic reference agents are active"))).to_be_visible()
    for agent in ("intake", "match", "reconciliation", "cash allocation", "exception", "audit"):
        expect(page.get_by_role("heading", name=agent)).to_be_visible()
    expect(page.get_by_text("LOCAL POLICY FLOW")).to_be_visible()
    expect(page.locator(".flow-step")).to_have_count(6)
    expect(page.get_by_label("Receipt ID")).to_be_visible()
    expect(page.get_by_label("Received amount")).to_have_value("250.00")
    expect(page.locator(".invoice-candidate")).to_have_count(1)
    page.get_by_role("button", name="Add invoice candidate").click()
    expect(page.locator(".invoice-candidate")).to_have_count(2)
    page.get_by_role("button", name="Remove candidate 2").click()
    expect(page.locator(".invoice-candidate")).to_have_count(1)
    page.get_by_role("button", name="Run workflow").click()
    expect(page.get_by_role("heading", name="Six agents, one governed workflow")).to_be_visible()
    for agent in ("ledgersight.intake", "ledgersight.match", "ledgersight.reconciliation", "ledgersight.cash_allocation", "ledgersight.exception", "ledgersight.audit"):
        expect(page.get_by_role("rowheader", name=agent)).to_be_visible()
    expect(page.get_by_text("EXACT_MATCH_WITHIN_LIMIT")).to_be_visible()


def test_stored_xss_is_rendered_as_text(page, base_url, api):
    aid = api("admin@t-bank", "POST", "/v1/assessments", {"ai_system_name": "<img src=x onerror=window.__xss=1>", "industry": "banking",
                                                          "questionnaire_version": "1.0.0"})["assessment_id"]
    api("admin@t-bank", "PUT", f"/v1/assessments/{aid}/answers/Q-BASE-001", {"scope_id": "org", "value": "<script>window.__xss=2</script>",
                                                                              "answer_status": "answered"}, {"If-Match": "0"})
    dialogs = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    login(page, base_url, "admin@t-bank")
    page.get_by_role("link", name="<img src=x onerror=window.__xss=1>").first.click()
    page.wait_for_selector("h2")
    expect(page.get_by_role("heading", name=re.compile("onerror"))).to_be_visible()
    page.get_by_role("button", name="Scope & registration").click()
    assert page.evaluate("window.__xss") is None
    assert page.locator("img[src='x']").count() == 0 and not dialogs
    expect(page.get_by_label(re.compile("Organisation legal name"))).to_have_value("<script>window.__xss=2</script>")


def test_csp_blocks_inline_script_and_no_console_errors(page, base_url):
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    login(page, base_url, "admin@t-bank")
    page.evaluate("""() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s); }""")
    assert page.evaluate("window.__inline") is None
    assert not [e for e in errors if "Content Security Policy" not in e], errors


def test_full_customer_to_reviewer_flow(page, base_url, api):
    aid = api("admin@t-bank", "POST", "/v1/assessments", {"ai_system_name": "Flow system", "industry": "banking",
                                                          "questionnaire_version": "1.0.0"})["assessment_id"]
    fill_required_via_api(api, aid, {"Q-BASE-002": "banking", "Q-BASE-005": "Agentic AI", "Q-BASE-006": "Yes", "Q-BASE-007": "No",
                                     "Q-IAM-002": "Yes", "Q-HIT-015": "No", "Q-AIA-017": "No"})
    # customer submits in the UI
    login(page, base_url, "admin@t-bank")
    page.get_by_role("link", name="Flow system").click()
    page.once("dialog", lambda d: d.accept())
    page.get_by_role("button", name="Submit", exact=True).click()
    expect(page.get_by_text("Your report is under CloudSeals review")).to_be_visible()
    # customer must not see findings or reports yet
    assert page.get_by_text("Findings (candidates").count() == 0
    # reviewer adjusts a finding and approves
    login(page, base_url, "reviewer@cloudseals")
    page.get_by_role("link", name="Review queue").click()
    page.get_by_role("link", name="Open").first.click()
    page.wait_for_selector("table caption")
    page.get_by_label("Reviewer reason").fill("Reviewed credentials evidence")
    page.get_by_label("Status for R-001").select_option("Confirmed gap")
    expect(page.locator("#toast", has_text="Finding updated")).to_be_visible()
    page.get_by_label("Reviewer reason").fill("Approved after review")   # panel re-renders after each action
    page.get_by_role("button", name="Approve & publish").click()
    expect(page.locator("#toast", has_text="Decision recorded: approve")).to_be_visible()
    # customer now sees findings and can download both formats
    login(page, base_url, "admin@t-bank")
    page.get_by_role("link", name="Flow system").click()
    expect(page.get_by_text("Findings (candidates for review, not legal determinations)")).to_be_visible()
    expect(page.get_by_role("cell", name="Confirmed gap")).to_be_visible()
    with page.expect_download() as d:
        page.get_by_role("button", name="PDF").click()
    path = d.value.path()
    assert open(path, "rb").read(5) == b"%PDF-"
    with page.expect_download() as d:
        page.get_by_role("button", name="DOCX").click()
    assert open(d.value.path(), "rb").read(2) == b"PK"


def test_customer_cannot_reach_admin_views(page, base_url):
    login(page, base_url, "admin@t-bank")
    page.goto(base_url + "/portal/#/registrations")
    expect(page.get_by_text("Something went wrong")).to_be_visible()      # 403 from API, no data shown
    assert page.get_by_role("link", name="Registrations").count() == 0     # not even in the navigation


def test_contributor_blocked_outside_assigned_sections(page, base_url, api):
    api("admin@t-bank", "POST", "/v1/assessments", {"ai_system_name": "Assign system", "industry": "banking",
                                                          "questionnaire_version": "1.0.0"})
    login(page, base_url, "contrib@t-bank")
    page.get_by_role("link", name="Assign system").click()
    page.locator(".q-card select").first.select_option(index=1)
    expect(page.locator("#toast", has_text="Section not assigned")).to_be_visible()


def test_evidence_upload_clean_and_infected(page, base_url, api, tmp_path):
    api("admin@t-bank", "POST", "/v1/assessments", {"ai_system_name": "Evidence system", "industry": "banking", "questionnaire_version": "1.0.0"})
    ok = tmp_path / "arch.txt"
    ok.write_text("Per-workload IAM roles are used.")
    bad = tmp_path / "eicar.txt"
    bad.write_bytes(b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")
    login(page, base_url, "admin@t-bank")
    page.get_by_role("link", name="Evidence system").click()
    page.set_input_files("#ef", str(ok))
    page.get_by_role("button", name="Upload", exact=True).click()
    expect(page.locator("#toast", has_text="Uploaded and scanned: clean")).to_be_visible()
    page.set_input_files("#ef", str(bad))
    page.get_by_role("button", name="Upload", exact=True).click()
    expect(page.locator("#toast", has_text="Upload infected")).to_be_visible()
    expect(page.locator("li", has_text="eicar.txt").get_by_text("infected")).to_be_visible()


def test_mobile_layout_has_no_horizontal_scroll_and_accessible_names(page, base_url, api):
    api("admin@t-bank", "POST", "/v1/assessments", {"ai_system_name": "Mobile system", "industry": "banking", "questionnaire_version": "1.0.0"})
    page.set_viewport_size({"width": 375, "height": 800})
    login(page, base_url, "admin@t-bank")
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")   # list view (long names from other tests)
    page.get_by_role("link", name="Mobile system").click()
    page.wait_for_selector(".q-card select")
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    unnamed = page.evaluate("""() => [...document.querySelectorAll('input:not([type=hidden]),select,textarea,button')]
        .filter(e => !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.textContent.trim() && !e.getAttribute('aria-labelledby')).length""")
    assert unnamed == 0
    assert page.evaluate("document.documentElement.lang") == "en-GB"
