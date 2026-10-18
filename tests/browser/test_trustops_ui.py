import re
import uuid

from playwright.sync_api import expect


def test_hub_strip_lists_the_packs_and_tools(as_user, assessment):
    page = as_user("admin@t-bank", "trustops")
    strip = page.locator(".pack-strip")
    expect(strip).to_be_visible()
    for name in ("LedgerSight AR / Cash", "AI governance diagnostic", "Framework library", "Agent Flow", "More workflow packs"):
        expect(strip.get_by_text(name)).to_be_visible()
    expect(strip.get_by_text("PLANNED")).to_be_visible()
    strip.get_by_role("link", name=re.compile("AI governance diagnostic")).click()
    expect(page.get_by_role("heading", name="Diagnostic studio")).to_be_visible()


def test_low_value_run_shows_six_agent_trace_and_prepare_step(as_user):
    page = as_user("admin@t-bank", "trustops")
    page.wait_for_selector("#workflow-amount")
    page.get_by_label("Receipt ID").fill(f"R-{uuid.uuid4().hex[:10]}")          # receipt IDs must be unique per tenant
    page.get_by_role("button", name=re.compile("Run workflow")).click()
    expect(page.get_by_text("Within policy", exact=True)).to_be_visible()
    expect(page.locator(".trace-step")).to_have_count(6)
    expect(page.locator(".trace-step", has_text="Cash Allocation")).to_contain_text("proposal was prepared")
    expect(page.locator(".trace-step", has_text="Exception")).to_contain_text("within policy")          # no contradictory text
    expect(page.get_by_role("button", name="Prepare action")).to_be_visible()


def test_high_value_run_needs_a_different_person_to_approve(as_user, api):
    page = as_user("admin@t-bank", "trustops")
    page.wait_for_selector("#workflow-amount")
    page.wait_for_timeout(500)                       # the form is rebuilt once the page data has loaded
    page.get_by_label("Receipt ID").fill(f"R-{uuid.uuid4().hex[:10]}")
    page.get_by_label("Received amount").fill("9999999")
    page.get_by_label("Invoice amount").first.fill("9999999")
    expect(page.get_by_label("Received amount")).to_have_value("9999999")
    expect(page.get_by_label("Invoice amount").first).to_have_value("9999999")
    page.get_by_role("button", name=re.compile("Run workflow")).click()
    expect(page.locator("#trustops-detail")).to_contain_text("High value controller approval required")      # the run has finished
    # the starter cannot approve their own run
    own = as_user("admin@t-bank", "approvals")
    expect(own.get_by_text("Controller role required").first).to_be_visible()
    expect(own.get_by_role("button", name="Approve", exact=True)).to_have_count(0)
    # a controller can: reason is mandatory
    ctl = as_user("controller@t-bank", "approvals")
    ctl.get_by_role("button", name="Approve", exact=True).first.click()
    expect(ctl.locator("#toast")).to_have_text("Enter a decision reason")
    pending = ctl.locator(".approval-card").count()
    ctl.get_by_placeholder(re.compile("Decision reason")).first.fill("Verified against the remittance advice")
    ctl.get_by_role("button", name="Approve", exact=True).first.click()
    expect(ctl.locator("#toast")).to_contain_text("Approval approve recorded")
    expect(ctl.locator(".approval-card")).to_have_count(pending - 1)


def test_payment_agent_flow_animates_all_seven_agents_in_order(as_user):
    page = as_user("admin@t-bank", "agent-flow")
    with page.expect_response(lambda r: r.url.endswith("/runs/stream") and r.request.method == "POST") as stream:
        page.get_by_role("button", name="▶ Run agents").click()
    assert stream.value.status == 200
    assert "text/event-stream" in stream.value.headers["content-type"]
    # Fast workers can finish before the first paint: do not require invented busy time.
    expect(page.locator("main")).not_to_contain_text("NO AGENTS EXECUTED")
    expect(page.locator(".af-result")).to_be_visible(timeout=60_000)
    expect(page.locator(".af-node.is-done")).to_have_count(7)
    expect(page.locator(".af-agent.is-done")).to_have_count(7)
    expect(page.locator(".office-seat.is-done")).to_have_count(7)
    assert page.evaluate("document.querySelector('.af-progress-bar').style.width") == "100%"
    assert page.errors == []


def test_diagnosis_flow_skips_what_a_customer_may_not_do_and_says_why(as_user, assessment):
    page = as_user("admin@t-bank", "agent-flow")
    page.get_by_role("button", name=re.compile("Diagnosis agents")).click()
    page.get_by_role("button", name="▶ Run agents").click()
    expect(page.locator(".af-result, .af-node.is-skipped").first).to_be_visible(timeout=60_000)
    expect(page.locator(".af-node", has_text="Findings Summary")).to_contain_text("Needs a CloudSeals reviewer", timeout=60_000)
    expect(page.locator(".af-node", has_text="Interviewer")).to_have_class(re.compile("is-done"))
    expect(page.locator(".af-node", has_text="Inventory Agent")).to_have_class(re.compile("is-done"))
    expect(page.locator(".af-node", has_text="POC Drafter")).to_contain_text("CloudSeals assessor", timeout=60_000)
