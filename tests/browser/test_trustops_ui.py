import os
from pathlib import Path

import pytest
from playwright.sync_api import expect


@pytest.mark.parametrize("route", ["trustops", "approvals", "reconciliation", "exceptions", "evidence", "shadow-roi", "readiness", "demo", "integrations", "datasets", "models", "workflows", "policies", "authority", "approval-matrix", "agentops"])
def test_retired_navigation_opens_assessment_overview(as_user, route):
    page = as_user("admin@t-bank", route)
    expect(page.get_by_role("heading", name="AI oversight. A clear next step.")).to_be_visible()
    expect(page).to_have_url(page.url.split("#")[0] + "#/dashboard")
    assert page.errors == []


@pytest.mark.parametrize("width", [1440, 390])
def test_customer_overview_is_assessment_focused(as_user, assessment, width):
    page = as_user("admin@t-bank", "dashboard", width=width, height=900)
    expect(page.get_by_role("heading", name="AI oversight. A clear next step.")).to_be_visible()
    for name in ("Overview", "Assessments", "Assessment process", "Reports"):
        expect(page.locator("#nav").get_by_role("link", name=name, exact=True)).to_be_visible()
    expect(page.locator("main")).not_to_contain_text("Payment")
    expect(page.locator("main")).not_to_contain_text("LedgerSight")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    assert page.errors == []
    if os.environ.get("TRUSTOPS_UI_OUTPUT"):
        output = Path(os.environ["TRUSTOPS_UI_OUTPUT"])
        output.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(output / f"assessment-overview-{width}.png"), full_page=True, animations="disabled")


def test_reports_do_not_fetch_or_offer_financial_workflows(as_user, assessment):
    page = as_user("admin@t-bank", "dashboard")
    expect(page.get_by_role("heading", name="AI oversight. A clear next step.")).to_be_visible()
    requests = []
    page.on("request", lambda r: requests.append(r.url))
    page.locator("#nav").get_by_role("link", name="Reports", exact=True).click()
    expect(page.get_by_role("heading", name="Reports", exact=True)).to_be_visible()
    page.get_by_role("searchbox", name="Search reports").fill("no-such-system")
    expect(page.get_by_role("tab", name="Workflow results")).to_have_count(0)
    assert not any("/v1/runs" in u or "/v1/workflows" in u or "/v1/approvals" in u for u in requests)
    assert page.errors == []
