// TAAD portal: dependency-free ES module. All dynamic text goes through textContent (no innerHTML).
import { createAgentOffice } from "./agent-office.js";
const $ = (s, r = document) => r.querySelector(s);
const main = $("#main"), nav = $("#nav"), who = $("#who"), contextBar = $("#contextBar");
const state = { token: sessionStorage.getItem("taad_token"), me: null, cfg: { mode: "oidc", oidc: {} } };
const trustopsTokens = new Map(); // one-time action tokens stay in memory only
const evidenceVerification = new Map();

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) n.append(c instanceof Node ? c : document.createTextNode(c ?? ""));
  return n;
}
const say = (m) => { $("#live").textContent = m; };
function tenantLabel(tenant) {
  if (state.cfg.mode === "dev") {
    const localNames = { "t-bank": "T-Bank", "t-health": "T-Health", "t-logistics": "T-Logistics" };
    if (localNames[tenant?.tenant_id]) return localNames[tenant.tenant_id];
  }
  return tenant?.name || tenant?.tenant_id || "Customer workspace";
}
function toast(msg, bad = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (bad ? " err" : ""); t.hidden = false;
  say(msg); clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 5000);
}

async function api(path, { method = "GET", body, headers = {}, raw = false, idem = false } = {}) {
  const h = { Authorization: `Bearer ${state.token}`, ...headers };
  if (body !== undefined && !(body instanceof ArrayBuffer)) h["Content-Type"] = "application/json";
  if (idem) h["Idempotency-Key"] = crypto.randomUUID();
  const r = await fetch(path, { method, headers: h, body: body === undefined ? undefined : body instanceof ArrayBuffer ? body : JSON.stringify(body) });
  if (raw) return r;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // An expired or revoked sign-in (Google ID tokens last one hour): return to the sign-in page instead of failing silently.
    if (r.status === 401 && state.token && !path.startsWith("/v1/auth/")) { sessionStorage.removeItem("taad_token"); state.token = null; state.me = null; setTimeout(render, 0); }
    const e = new Error(data.message || r.statusText); e.status = r.status; e.code = data.code; throw e;
  }
  return data;
}
// Advisory agent output: always labelled, always plain text, never saved automatically.
function advisoryBox(title, lines) {
  return el("div", { class: "card advisory", role: "status" }, el("span", { class: "tag medium" }, "ADVISORY · NOT SAVED"), el("strong", {}, ` ${title}`),
    el("ul", {}, lines.map((l) => el("li", {}, l))));
}
const agentButton = (label, out, run) => el("button", { class: "secondary", onclick: safe(async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try { out.replaceChildren(await run()); } catch (err) { out.replaceChildren(el("p", { class: "help" }, `Agent unavailable: ${err.message}`)); } finally { b.disabled = false; }
}) }, label);
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- auth ----------
async function sha256Hex(buf) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function oidcLogin() {
  const o = state.cfg.oidc;
  if (![o.authorize_url, o.token_url, o.client_id, o.redirect_uri].every(Boolean)) {
    throw new Error("Organisation sign-in is not configured. Contact your CloudSeals administrator.");
  }
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const st = b64u(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem("pkce", JSON.stringify({ verifier, st }));
  location.href = `${o.authorize_url}?response_type=code&client_id=${encodeURIComponent(o.client_id)}&redirect_uri=${encodeURIComponent(o.redirect_uri)}&scope=${encodeURIComponent(o.scope)}&code_challenge=${challenge}&code_challenge_method=S256&state=${st}${o.provider === "google" ? "&prompt=select_account" : ""}`;
}
async function oidcCallback(params) {
  if (params.has("error") || !params.get("code")) {
    sessionStorage.removeItem("pkce");
    throw new Error("Organisation sign-in was cancelled or could not be completed.");
  }
  const saved = JSON.parse(sessionStorage.getItem("pkce") || "{}");
  if (!saved.st || saved.st !== params.get("state")) throw new Error("Invalid login state");
  const o = state.cfg.oidc;
  const r = await fetch(o.token_url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: o.client_id, code: params.get("code"), redirect_uri: o.redirect_uri, code_verifier: saved.verifier }) });
  if (!r.ok) throw new Error("Sign-in failed");
  state.token = (await r.json()).access_token;
  sessionStorage.setItem("taad_token", state.token); sessionStorage.removeItem("pkce");
  history.replaceState({}, "", location.pathname);
}
function logout() {
  sessionStorage.removeItem("taad_token"); sessionStorage.removeItem("pkce"); state.token = null; state.me = null;
  const o = state.cfg.oidc;
  if (state.cfg.mode === "oidc" && o.logout_url && o.client_id && o.redirect_uri) {
    const url = new URL(o.logout_url); url.searchParams.set("client_id", o.client_id); url.searchParams.set("logout_uri", o.redirect_uri);
    location.assign(url.href); return;
  }
  render();
}

async function loginView() {
  nav.replaceChildren(); who.textContent = "";
  if (state.cfg.mode === "dev") {
    const users = await fetch("/v1/dev/users").then((r) => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] }));
    const localAdmin = users.items.find((u) => u.sub === "admin@t-bank");
    if (localAdmin?.token) {
      state.token = localAdmin.token;
      sessionStorage.setItem("taad_token", localAdmin.token);
      await render();
      return;
    }
  }
  const card = el("section", { class: "login-card" },
    el("div", { class: "login-mark", "aria-hidden": "true" }, "C"),
    el("span", { class: "login-eyebrow" }, "CLOUDSEALS · TRUSTOPS"),
    el("h2", {}, "Sign in to your workspace"),
    el("p", { class: "login-copy" }, "Use your organisation account to securely access your TrustOps workspace."));
  if (state.cfg.mode === "oidc") {
    const o = state.cfg.oidc;
    const ready = [o.authorize_url, o.token_url, o.client_id, o.redirect_uri].every(Boolean);
    card.append(el("button", { class: "login-action", disabled: !ready, onclick: safe(oidcLogin) },
      o.provider === "google" ? "Sign in with Google" : "Continue with organisation sign-in", el("span", { "aria-hidden": "true" }, "→")),
      ready ? "" : el("p", { class: "login-notice" }, "Secure sign-in is not configured yet. Contact your CloudSeals administrator."));
  } else {
    card.append(el("div", { class: "login-notice" },
      el("strong", {}, "Local workspace is unavailable"),
      el("span", {}, "The local development workspace could not be loaded. Check the API and seed data.")));
  }
  card.append(el("p", { class: "login-footnote" }, "Protected access · Your organisation manages users and permissions"));
  if (state.cfg.mode === "oidc") card.append(el("a", { class: "register-link", href: "#/register" }, "Request workspace access →"));
  main.replaceChildren(card);
}

// ---------- routing ----------
const routes = {};
function go(hash) { location.hash = hash; }
routes.register = async () => {
  const industries = ["Banking", "Investment", "Insurance", "Healthcare", "Logistics", "Industrial", "Government", "Other"];
  const jurisdictions = ["UK", "EU", "US", "Other"];
  const form = el("form", { class: "registration-form", onsubmit: safe(async (event) => {
    event.preventDefault(); const data = new FormData(form);
    await fetch("/v1/registration-requests", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organisation_name: data.get("organisation"), work_email: data.get("email"), industry: data.get("industry"),
        jurisdiction: data.getAll("jurisdiction"), engagement_reference: data.get("engagement") }) }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "Registration request could not be submitted.");
      main.replaceChildren(moduleFrame("ACCESS REQUEST", "Request received", "Your request is pending review. We will contact you through your organisation email when access is ready."));
    });
  }) },
  el("label", { for: "reg-organisation" }, "Organisation name"), el("input", { id: "reg-organisation", name: "organisation", required: true, maxlength: 200 }),
  el("label", { for: "reg-email" }, "Work email"), el("input", { id: "reg-email", name: "email", type: "email", required: true }),
  el("label", { for: "reg-industry" }, "Industry"), el("select", { id: "reg-industry", name: "industry" }, industries.map((industry) => el("option", { value: industry.toLowerCase() }, industry))),
  el("label", { for: "reg-jurisdiction" }, "Data jurisdictions"), el("select", { id: "reg-jurisdiction", name: "jurisdiction", multiple: true, required: true },
    jurisdictions.map((jurisdiction) => el("option", { value: jurisdiction, selected: jurisdiction === "UK" }, jurisdiction))),
  el("label", { for: "reg-engagement" }, "Engagement reference"), el("input", { id: "reg-engagement", name: "engagement", required: true, maxlength: 200 }),
  el("p", { class: "module-note" }, "Requests are reviewed before a tenant workspace is activated."),
  el("div", { class: "row" }, el("button", {}, "Submit access request"), el("a", { class: "secondary btn", href: "/portal/" }, "Back to sign in")));
  main.replaceChildren(moduleFrame("CLOUDSEALS · CUSTOMER ONBOARDING", "Request workspace access", "Tell us about your organisation and approved engagement.", form));
};
async function render() {
  if (!state.token) {
    if (location.hash === "#/register") return routes.register();
    return loginView();
  }
  if (!state.me) { try { state.me = await api("/v1/me"); } catch { return logout(); } }
  const staff = state.me.is_staff;
  const roles = state.me.roles;
  const hasAnyRole = (...allowed) => roles.some((role) => allowed.includes(role));
  const canUseAdminMetrics = hasAnyRole("cloudseals_admin", "cloudseals_platform_ops", "cloudseals_reviewer", "cloudseals_assessor");
  const [, name, arg] = (location.hash || (canUseAdminMetrics ? "#/admin" : "#/dashboard")).split("/");
  const link = ([route, label]) => el("a", { href: `#/${route}`, class: "module-menu-link", "aria-current": name === route ? "page" : null }, label);
  const group = (label, items) => el("details", { class: "module-menu-group" }, el("summary", {}, label, el("span", { "aria-hidden": "true" }, "⌄")),
    el("div", { class: "module-menu-popover" }, items.map(link)));
  const adminItems = [
    ...(canUseAdminMetrics ? [["admin", "Portfolio"]] : []),
    ["workspaces", "Customer workspaces"],
    ...(hasAnyRole("cloudseals_admin") ? [["users", "Users"], ["registrations", "Registrations"]] : []),
    ...(hasAnyRole("cloudseals_admin", "cloudseals_platform_ops", "auditor_readonly") ? [["activity", "Audit logs"], ["service-health", "Service health"]] : []),
    ["integrations", "Integrations"], ["datasets", "Datasets"], ["workflows", "Workflows"],
    ["agents", "Agents"], ["models", "Models"], ["policies", "Policies"], ["authority", "Authority"],
    ["approval-matrix", "Approval matrix"], ["agentops", "AgentOps"],
    ...(hasAnyRole("cloudseals_admin") ? [["tenant-settings", "Tenant settings"]] : []),
  ];
  nav.replaceChildren(
    ...(state.cfg.mode === "dev" ? [link(["demo", "Demo Studio"])] : []),
    link(["dashboard", "Command Center"]), link(["assessments", "Diagnosis"]), ...(canUseAdminMetrics ? [link(["cases", "Cases"])] : []), link(["use-cases", "Use cases"]), link(["trustops", "TrustOps"]), link(["agent-flow", "Agent Flow"]),
    canUseAdminMetrics ? link(["queue", "Review queue"]) : "",
    group("Operations", [["reconciliation", "Reconciliation"], ["exceptions", "Exceptions"], ["approvals", "Approvals"],
      ["frameworks", "Frameworks"], ["evidence", "Evidence"], ["readiness", "Readiness"], ["shadow-roi", "Shadow ROI"], ...(staff ? [] : [["team", "Team"]])]),
    staff ? group("Administration", adminItems) : "");
  who.replaceChildren(state.cfg.mode === "dev"
    ? el("span", { class: "tag" }, state.me.tenant ? `${tenantLabel(state.me.tenant)} workspace` : "CloudSeals staff")
    : `${state.me.sub} `, state.cfg.mode === "dev" ? "" : el("button", { class: "secondary", onclick: logout }, "Sign out"));
  contextBar.replaceChildren(
    el("span", {}, el("small", {}, "TENANT"), state.me.tenant ? tenantLabel(state.me.tenant) : staff ? "CloudSeals operations" : "Customer workspace"),
    state.cfg.mode === "dev" ? "" : el("span", {}, el("small", {}, "ENVIRONMENT"), "OIDC session"),
    el("span", {}, el("small", {}, "ROLE"), state.me.roles.join(" · ")),
    el("span", {}, el("small", {}, "QUESTION CATALOG"), "v1.0.0 · 318 questions"),
    el("span", {}, el("small", {}, "EVIDENCE INTEGRITY"), state.cfg.mode === "dev" ? "Local hash chain" : "Environment profile"));
  contextBar.scrollLeft = 0;
  // Pages that only CloudSeals staff (or specific staff roles) may use: show a clear message instead of an empty shell.
  const CASE_ROLES = ["cloudseals_admin", "cloudseals_assessor", "cloudseals_reviewer"], AUDIT = ["cloudseals_admin", "cloudseals_platform_ops", "auditor_readonly"];
  const ROUTE_ROLES = { cases: CASE_ROLES, case: CASE_ROLES, activity: AUDIT, "service-health": AUDIT, workspaces: [...CASE_ROLES, ...AUDIT], workspace: [...CASE_ROLES, ...AUDIT],
    queue: ["cloudseals_admin", "cloudseals_platform_ops", "cloudseals_reviewer", "cloudseals_assessor"], registrations: ["cloudseals_admin"], users: ["cloudseals_admin"], admin: ["cloudseals_admin", "cloudseals_platform_ops", "cloudseals_reviewer", "cloudseals_assessor"] };
  if (ROUTE_ROLES[name] && !roles.some((r) => ROUTE_ROLES[name].includes(r))) {
    main.replaceChildren(moduleFrame("ACCESS", "You do not have access to this page", "This page is for CloudSeals staff. If you need it, ask a CloudSeals administrator to change your role.", el("p", {}, el("a", { class: "btn", href: "#/dashboard" }, "Back to the Command Center"))));
    return;
  }
  const view = routes[name] || routes.assessments;
  main.replaceChildren(el("p", {}, "Loading…"));
  try { await view(arg); } catch (e) { main.replaceChildren(el("div", { class: "card" }, el("h2", {}, "Something went wrong"), el("p", {}, e.message))); }
  main.focus();
}
window.addEventListener("hashchange", render);

const dl = async (url, name) => {
  const r = await api(url, { raw: true });
  if (!r.ok) return toast((await r.json()).message, true);
  const a = el("a", { href: URL.createObjectURL(await r.blob()), download: name }); a.click(); URL.revokeObjectURL(a.href);
};

// ---------- assessments ----------
async function demoSignIn(sub, route) {
  if (state.cfg.mode !== "dev") throw new Error("Presentation roles are available only in the local demo.");
  const { items } = await fetch("/v1/dev/users").then(r => { if (!r.ok) throw new Error("Local demo accounts are unavailable"); return r.json(); });
  const user = items.find(u => u.sub === sub);
  if (!user) throw new Error("This demo role is unavailable");
  state.token = user.token; sessionStorage.setItem("taad_token", user.token); state.me = null;
  if (location.hash === route) await render(); else go(route);
}

routes.demo = async () => {
  if (state.cfg.mode !== "dev") return main.replaceChildren(moduleFrame("ACCESS", "Local demonstration only", "This presentation workspace is not enabled in deployed customer environments."));
  const [health, { items: assessments }, { items: runs }] = await Promise.all([fetch("/health").then(r => r.json()), api("/v1/assessments"), api("/v1/runs?limit=100")]);
  const sample = assessments.find(a => a.ai_system_name === "DEMO | Example Bank — AI payment operations");
  const demoRuns = runs.filter(r => r.receipt_id.startsWith("DEMO-"));
  const completed = demoRuns.find(r => r.receipt_id === "DEMO-MATCH");
  const approval = demoRuns.find(r => r.receipt_id === "DEMO-APPROVAL");
  const sampleReports = sample ? (await api(`/v1/assessments/${sample.assessment_id}/reports`)).items.filter(r => r.status === "published") : [];
  const report = sampleReports[0];
  const open = (label, role, route, secondary = false) => el("button", { type: "button", class: secondary ? "secondary" : "", onclick: safe(() => demoSignIn(role, route)) }, label);
  const reportButtons = report ? el("div", { class: "row" }, ["pdf", "docx"].map(format => el("button", { class: "secondary", type: "button", onclick: safe(() => dl(`/v1/assessments/${sample.assessment_id}/reports/${report.report_id}/download?format=${format}`, `SYNTHETIC-TrustOps-assessment.${format}`)) }, `Download ${format.toUpperCase()}`))) : el("p", { class: "help" }, "The prepared sample report is not available for this role yet.");
  const verification = el("div", { class: "demo-verify-result", role: "status" });
  const step = (number, title, text, status, ...actions) => el("article", { class: "demo-story-card" }, el("span", { class: "demo-step-number" }, number), el("span", { class: "eyebrow" }, status), el("h3", {}, title), el("p", {}, text), el("div", { class: "demo-card-actions" }, actions));
  main.replaceChildren(el("div", { class: "module-page demo-studio" },
    el("section", { class: "demo-hero" }, el("div", {}, el("span", { class: "eyebrow" }, "CLOUDSEALS TRUSTOPS · CLIENT DEMONSTRATION"), el("h2", {}, "AI you can operate with confidence."),
      el("p", {}, "Understand the risk. Control the action. Keep the proof."),
      el("div", { class: "row" }, open("Explore the agent office →", "admin@t-bank", "#/agent-flow"), sample ? open("Open sample assessment", "admin@t-bank", `#/assessment/${sample.assessment_id}`, true) : "")),
      el("div", { class: "demo-hero-seal" }, el("span", { "aria-hidden": "true" }, "◇"), el("strong", {}, "Governed by design"), el("small", {}, "Policy · Human oversight · Evidence"))),
    el("p", { class: "demo-disclosure" }, "SYNTHETIC CLIENT DEMO · Real application APIs and policy checks, fictional data, mock ERP connector. Prepared sample approvals are demonstration fixtures, not customer sign-offs."),
    el("section", { class: "demo-readiness", "aria-label": "Live demo readiness" },
      [["Application", health.status === "ok" ? "Online" : "Check service"], ["Question catalogue", `${health.question_count} questions · v${health.registry_version}`], ["Prepared workflows", `${demoRuns.length} scenarios`], ["Sample report", report ? "Published · PDF & Word" : "Not prepared"]].map(([label, value]) => el("div", {}, el("small", {}, label), el("strong", {}, value)))),
    el("div", { class: "demo-section-heading" }, el("h3", {}, "Four moments that explain TrustOps"), el("span", { class: "help" }, "Suggested walkthrough · 8–10 minutes")),
    el("div", { class: "demo-story-grid" },
      step("01", "Understand your AI", "Assess a fictional legacy AI payment process using its inventory, policies and questionnaire answers. Review gaps and download the prepared report; the governed payment workflow shows the target controls.", report ? "PREPARED QUESTIONNAIRE REPORT" : "ASSESSMENT", sample ? open("View assessment & findings", "admin@t-bank", `#/assessment/${sample.assessment_id}`) : el("p", { class: "help" }, "Demo dataset needs preparation."), reportButtons),
      step("02", "Meet the specialist team", "Start a workflow in the agent office and inspect each desk's task, returned output and live execution events.", "INTERACTIVE AGENT OFFICE", open("Run the agent office", "admin@t-bank", "#/agent-flow")),
      step("03", "Keep people in control", "An exact match can proceed within policy. High-value actions need a controller; ambiguous matches are escalated.", approval ? runStatusLabel(approval.status).toUpperCase() : "HUMAN OVERSIGHT", approval ? open("Review high-value scenario", "controller@t-bank", `#/trustops/${approval.run_id}`) : "", open("Open controller approval queue", "controller@t-bank", "#/approvals", true)),
      step("04", "Verify the proof", "Inspect the policy, proposal and mock execution receipt. Verify the stored hash chain against the current evidence records.", completed ? "EXECUTED IN MOCK ERP" : "EVIDENCE FABRIC", completed ? open("Inspect completed run", "admin@t-bank", `#/trustops/${completed.run_id}`) : "", completed ? el("button", { type: "button", class: "secondary", onclick: safe(async () => {
        const result = await api(`/v1/evidence/${completed.run_id}/verify`, { method: "POST" });
        verification.replaceChildren(el("strong", {}, result.valid ? "Integrity verified" : "Integrity check failed"), el("p", {}, `${result.records.length} evidence records · ${result.integrity === "local_hash_chain_only" ? "local hash chain; no production signature" : result.integrity}`));
      }) }, "Verify evidence now") : "", verification)),
    el("section", { class: "demo-boundaries" }, el("h3", {}, "What is running in this demonstration?"),
      el("div", { class: "demo-boundary-grid" },
        el("div", {}, el("strong", {}, "Working application"), el("p", {}, "Uploads, questionnaire rules, published report downloads, policy gates, role checks, approvals, mock execution and hash-chain verification.")),
        el("div", {}, el("strong", {}, "Document AI"), el("p", {}, state.cfg.assessment_model === "configured" ? "A model is configured. Confirm its live availability before presenting document-generated findings." : state.cfg.assessment_model === "demo" ? "Scripted test model: outputs are examples, not customer analysis." : "Not connected. The prepared report uses questionnaire rules, not an LLM reading the documents.")),
        el("div", {}, el("strong", {}, "Production integrations"), el("p", {}, "Mock SAP only; no live ERP writes. Evidence uses a local hash chain. Production signatures and deployment acceptance require separate verification.")))),
    el("section", { class: "demo-presenter" }, el("div", {}, el("strong", {}, "Presenter controls"), el("p", { class: "help" }, "Local seeded roles only. Role permissions are still enforced by the backend.")),
      el("div", { class: "row" }, open("Customer view", "admin@t-bank", "#/demo", true), open("Controller view", "controller@t-bank", "#/demo", true), open("Reviewer view", "reviewer@cloudseals", "#/demo", true), open("Architect view", "architect@cloudseals", "#/demo", true)))));
};

const SAMPLE_AI_REGISTER = "SYNTHETIC SAMPLE ONLY — Example Bank, not a real customer.\nAI Register. Our credit scoring model assigns loan applicants a score and decides approvals automatically. The chatbot answers customer questions about accounts.\nCredit scoring owner: Lending team. Inputs: application details and repayment history. Human review: appeals only.\nChatbot owner: Customer support. Inputs: approved account FAQs. It gives information and cannot change accounts.\nUnknown: model test results, retention periods and approval records have not been supplied.\n";
const SAMPLE_AI_POLICY = "SYNTHETIC SAMPLE ONLY — Example Bank.\nAI policy example: customer support staff review chatbot complaints. Loan applicants may request a human review. Access is limited to authorised teams.\nMissing evidence: no signed model validation report, retention schedule or approval log is supplied in this sample. Missing evidence does not prove a control is absent.\n";
function sampleDownload(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = el("a", { href: url, download: name }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function assessmentGuide(canCreate = false) {
  return el("section", { class: "card assessment-guide" }, el("span", { class: "eyebrow" }, "WHY CLOUDSEALS"),
    el("h3", {}, "Understand your AI. Find the gaps. Know what to improve."),
    el("p", {}, "We help you understand how your organisation uses AI, which controls are evidenced, and what needs further review. You receive a reviewed assessment report and an improvement roadmap."),
    el("div", { class: "document-examples" },
      el("div", {}, el("strong", {}, "You share"), el("p", { class: "help" }, "Your AI list, system overview, policies and test or audit records. Start with what you have.")),
      el("div", {}, el("strong", {}, "We assess & review"), el("p", { class: "help" }, "Identify documented AI uses, check evidence and review potential gaps with a CloudSeals reviewer.")),
      el("div", {}, el("strong", {}, "You receive"), el("p", { class: "help" }, "Reviewed findings, maturity results and prioritised next actions. Final reports appear after approval."))),
    el("details", { class: "sample-drawer" }, el("summary", {}, "See sample documents and a sample report"),
      el("p", { class: "help" }, "SYNTHETIC DEMO: these examples explain the process. They are not customer results or a compliance certificate."),
      el("div", { class: "row" },
        el("button", { class: "secondary", type: "button", onclick: () => sampleDownload("SAMPLE-ai-register.txt", SAMPLE_AI_REGISTER) }, "Download sample AI register"),
        el("button", { class: "secondary", type: "button", onclick: () => sampleDownload("SAMPLE-ai-policy.txt", SAMPLE_AI_POLICY) }, "Download sample policy"),
        el("a", { class: "btn secondary", href: "sample-assessment-report.html", target: "_blank", rel: "noopener" }, "View sample report")),
      canCreate ? el("button", { type: "button", onclick: safe(async (e) => {
        const button = e.currentTarget; button.disabled = true; button.textContent = "Preparing sample assessment…";
        try {
          const a = await api("/v1/assessments", { method: "POST", idem: true, body: { ai_system_name: "SYNTHETIC SAMPLE — Example Bank", industry: "banking", questionnaire_version: "1.0.0" } });
          for (const [filename, text] of [["SAMPLE-ai-register.txt", SAMPLE_AI_REGISTER], ["SAMPLE-ai-policy.txt", SAMPLE_AI_POLICY]]) {
            const buf = new TextEncoder().encode(text).buffer;
            const g = await api(`/v1/assessments/${a.assessment_id}/evidence/upload-url`, { method: "POST", body: { filename, content_type: "text/plain", file_size_bytes: buf.byteLength, claimed_sha256: await sha256Hex(buf) } });
            const uploaded = await api(g.upload_url, { method: "PUT", body: buf, headers: { "Content-Type": "application/octet-stream" } });
            if (uploaded.state !== "clean") throw new Error("Sample upload did not pass the safety check. Open the sample assessment to retry.");
          }
          toast("Separate sample assessment created. Your customer assessments were not changed."); go(`#/assessment/${a.assessment_id}`);
        } finally { button.disabled = false; button.textContent = "Try sample data in a separate assessment"; }
      }) }, "Try sample data in a separate assessment") : ""));
}

routes.assessments = async () => {
  const { items } = await api("/v1/assessments");
  const canCreate = !state.me.is_staff && state.me.roles.some((r) => ["customer_admin", "customer_architect"].includes(r));
  const rows = items.map((a) => el("tr", {}, el("td", {}, el("a", { href: `#/assessment/${a.assessment_id}` }, a.ai_system_name)), el("td", {}, a.industry), el("td", {}, el("span", { class: `tag ${a.status === "In progress" ? "medium" : "ok"}` }, a.status)), el("td", {}, a.questionnaire_version)));
  const form = el("form", { class: "module-panel assessment-create-form", onsubmit: safe(async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const a = await api("/v1/assessments", { method: "POST", idem: true, body: { ai_system_name: f.get("name"), industry: f.get("industry"), questionnaire_version: "1.0.0" } });
    go(`#/assessment/${a.assessment_id}`);
  }) }, el("h3", {}, "New assessment"),
  el("label", { for: "nm" }, "AI system name"), el("input", { id: "nm", name: "name", required: true, maxlength: 200 }),
  el("label", { for: "ind" }, "Industry"), el("select", { id: "ind", name: "industry" }, ["banking", "investment", "insurance", "healthcare", "logistics", "industrial", "government", "other"].map((i) => el("option", { value: i }, i))),
  el("p", {}, el("button", {}, "Create assessment")));
  main.replaceChildren(moduleFrame("TAAD · CUSTOMER WORKSPACE", "AI architecture diagnosis", "Assess your AI system against the versioned question catalogue, attach evidence, and track reviewed outcomes.",
    assessmentGuide(canCreate),
    el("section", { class: "module-metrics compact" }, [["Assessments", items.length], ["In progress", items.filter((a) => a.status === "In progress").length], ["Submitted", items.filter((a) => a.status !== "In progress").length]].map(([label, value]) => el("article", {}, el("span", {}, label), el("strong", {}, String(value))))),
    canCreate ? form : "",
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "YOUR WORKSPACE"), el("h3", {}, "Assessments"))),
      rows.length ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" }, el("thead", {}, el("tr", {}, ["AI system", "Industry", "Status", "Questionnaire"].map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows)))
        : el("div", { class: "empty-state" }, canCreate ? "Start by creating an assessment for an AI system." : "No assessments have been assigned to this workspace."))));
};

routes.assessment = async (aid) => {
  const a = await api(`/v1/assessments/${aid}`);
  const ctx = { aid, a, scopeType: "org", scopeId: "org", section: null, answers: {}, evidence: [] };
  const wrap = el("div", { class: "module-page assessment-page" });
  main.replaceChildren(wrap);
  const draw = async () => {
    ctx.a = await api(`/v1/assessments/${aid}`);
    ctx.evidence = (await api(`/v1/assessments/${aid}/evidence`)).items;
    ctx.answers = Object.fromEntries((await api(`/v1/assessments/${aid}/answers`)).items.map((x) => [`${x.scope_id}|${x.question_id}`, x]));
    const qs = (await api(`/v1/assessments/${aid}/questions?scope_id=${encodeURIComponent(ctx.scopeId)}&scope_type=${ctx.scopeType}`)).questions;
    const sections = [...new Set(qs.map((q) => q.section))];
    if (!sections.includes(ctx.section)) ctx.section = sections[0];
    const p = ctx.a.progress, frozen = ctx.a.status !== "In progress";
    const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    const nextStep = frozen ? "assessment-review" : ctx.evidence.length ? "assessment-questions" : "assessment-documents";
    wrap.replaceChildren(
      el("div", { class: "module-page-heading" }, el("span", { class: "eyebrow" }, "YOUR AI ASSESSMENT"), el("h2", {}, ctx.a.ai_system_name),
        el("p", {}, "Share your documents, answer a few questions, then send your assessment for review."), el("span", { class: `tag ${frozen ? "ok" : "medium"}` }, ctx.a.status)),
      assessmentGuide(!state.me.is_staff && state.me.roles.some((r) => ["customer_admin", "customer_architect"].includes(r))),
      state.cfg.assessment_model === "demo" ? el("p", { class: "assessment-model-notice", role: "status" }, "DEMO ENVIRONMENT: AI analysis here uses scripted examples. Real customer documents need a connected AI service and reviewer approval. Sample reports are illustrations only.")
        : state.cfg.assessment_model === "unavailable" ? el("p", { class: "assessment-model-notice", role: "status" }, "Document AI analysis is not connected yet. You can upload documents and complete the questionnaire for review; automatic document findings and the diagnostic roadmap require the AI service.") : "",
      el("nav", { class: "assessment-steps", "aria-label": "Assessment steps" },
        [["assessment-details", "1", "Details", "Your AI system"], ["assessment-documents", "2", "Documents", "Share what you have"], ["assessment-questions", "3", "Questions", "Tell us about your AI"], ["assessment-review", "4", "Review & report", "Send for review"]].map(([id, number, title, hint]) =>
          el("button", { class: `assessment-step ${nextStep === id ? "is-next" : ""}`, type: "button", onclick: () => jump(id) }, el("span", { class: "step-number" }, number), el("span", {}, el("strong", {}, title), el("small", {}, hint))))),
      el("section", { id: "assessment-details", class: "card assessment-details" }, el("span", { class: "eyebrow" }, "STEP 1 · DETAILS"), el("h3", {}, "Your assessment at a glance"),
        el("dl", { class: "assessment-detail-list" }, [["AI system", ctx.a.ai_system_name], ["Industry", ctx.a.industry], ["Status", ctx.a.status]].map(([label, value]) => el("div", {}, el("dt", {}, label), el("dd", {}, value || "Not specified")))),
        el("button", { class: "secondary", type: "button", onclick: () => jump("assessment-documents") }, "Continue to documents")),
      evidencePanel(ctx, draw),
      el("section", { id: "assessment-questions", class: "assessment-question-step" },
      el("div", { class: "module-panel assessment-progress" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "STEP 3 · QUESTIONS"), el("h3", {}, `${p.required_answered} of ${p.required_total} required answers`)), el("strong", {}, `${p.required_total ? Math.round(p.required_answered / p.required_total * 100) : 0}%`)), el("progress", { id: "pg", max: p.required_total || 1, value: p.required_answered }), el("p", { class: "help" }, "Answers save automatically when you finish a field. Choose ‘I don't know’ when you are unsure.")),
      el("details", { class: "setup-panel" }, el("summary", {}, el("strong", {}, "Scope & team"), el("span", { class: "help" }, ctx.scopeType === "org" ? " Whole organisation · optional settings" : ` ${ctx.scopeType}: ${ctx.scopeId}`)),
        scopeBar(ctx, draw),
        state.me.roles.some((role) => ["customer_admin", "customer_architect"].includes(role)) ? assignmentPanel(ctx, sections, draw) : ""),
      el("div", { class: `layout ${sections.length === 1 ? "single-section" : ""}` },
        el("nav", { class: "sections", "aria-label": "Questionnaire sections" }, el("span", { class: "eyebrow" }, "SECTIONS"), sections.map((sec) => {
          const inSec = qs.filter((q) => q.section === sec), done = inSec.filter((q) => ctx.answers[`${ctx.scopeId}|${q.question_id}`]).length;
          return el("button", { "aria-current": sec === ctx.section, onclick: () => { ctx.section = sec; draw(); window.scrollTo({ top: 0 }); } },
            el("span", {}, sec), el("small", { class: done === inSec.length ? "done" : "" }, done === inSec.length ? "✓" : `${done}/${inSec.length}`));
        })),
        el("div", { class: "questions" }, el("h3", { class: "section-title" }, ctx.section), qs.filter((q) => q.section === ctx.section).map((q, i) => questionCard(ctx, q, frozen, draw, i + 1))))),
      el("section", { id: "assessment-review" },
      !frozen && !state.me.is_staff ? submitPanel(ctx, draw) : "",
      await reportsPanel(ctx, draw)));
  };
  await draw();
};

function assignmentPanel(ctx, sections, draw) {
  const member = el("input", { type: "email", required: true, maxlength: 200, placeholder: "colleague@organisation.com" });
  const sectionSelect = el("select", { multiple: true, required: true, "aria-label": "Sections to assign" },
    sections.map((section) => el("option", { value: section, selected: section === ctx.section }, section)));
  const assignments = ctx.a.assignments || {};
  const assigned = Object.entries(assignments).map(([sub, owned]) => el("li", {}, `${sub} · ${owned.join(", ")}`));
  const form = el("form", { class: "assignment-form", onsubmit: safe(async (event) => {
    event.preventDefault();
    const response = await api(`/v1/assessments/${ctx.aid}/assignments`, { method: "POST", body: {
      sub: member.value.trim(), sections: [...sectionSelect.selectedOptions].map((option) => option.value),
    } });
    ctx.a.assignments = { ...(ctx.a.assignments || {}), [response.sub]: response.sections };
    toast("Assessment sections assigned"); await draw();
  }) }, el("label", {}, "Colleague work email", member), el("label", {}, "Questionnaire sections", sectionSelect),
  el("button", {}, "Assign sections"));
  return el("section", { class: "card assignment-panel" }, el("div", { class: "section-heading" }, el("div", {},
    el("span", { class: "eyebrow" }, "COLLABORATION"), el("h3", {}, "Assign a colleague"))),
    el("p", { class: "help" }, "Only members of this tenant can be assigned."), form,
    assigned.length ? el("ul", { class: "assignment-list" }, assigned) : el("p", { class: "help" }, "No section assignments yet."));
}

function scopeBar(ctx, draw) {
  const t = el("select", { id: "st" }, [["org", "Organisation"], ["ai_system", "AI system"], ["agent", "Agent"], ["workflow", "Workflow"], ["system", "System"]].map(([v, l]) => el("option", { value: v, selected: v === ctx.scopeType }, l)));
  const n = el("input", { id: "sn", value: ctx.scopeType === "org" ? "" : ctx.scopeId, placeholder: "Name of scope", disabled: ctx.scopeType === "org" });
  t.addEventListener("change", () => { n.disabled = t.value === "org"; });
  return el("form", { class: "card row", onsubmit: (e) => { e.preventDefault(); ctx.scopeType = t.value; ctx.scopeId = t.value === "org" ? "org" : (n.value.trim() || "default"); draw(); } },
    el("div", {}, el("label", { for: "st" }, "Scope type"), t), el("div", {}, el("label", { for: "sn" }, "Scope name"), n), el("button", { class: "secondary" }, "Switch scope"));
}

function questionCard(ctx, q, frozen, draw, num = 0) {
  const key = `${ctx.scopeId}|${q.question_id}`, cur = ctx.answers[key];
  const id = `q-${q.question_id}`, status = el("span", {}, cur ? `✓ Saved` : "Not answered yet");
  let input;
  const dis = frozen || (state.me.is_staff && false);
  if (q.response_type === "select_one") {
    input = el("select", { id, disabled: dis }, el("option", { value: "" }, "Select…"), q.options.map((o) => el("option", { value: o, selected: cur?.value === o }, o)));
  } else if (q.response_type === "select_multi") {
    input = el("fieldset", { id }, el("legend", {}, "Select all that apply"), q.options.map((o) => el("label", {}, el("input", { type: "checkbox", value: o, checked: (cur?.value || []).includes(o), disabled: dis }), o)));
  } else if (q.response_type === "number") {
    input = el("input", { id, type: "number", value: cur?.value ?? "", disabled: dis });
  } else {
    input = el(q.response_type === "long_text" ? "textarea" : "input", { id, rows: 3, disabled: dis, maxlength: 10000 }, ...(q.response_type === "long_text" ? [cur?.value ?? ""] : []));
    if (q.response_type !== "long_text") input.value = cur?.value ?? "";
  }
  const read = () => q.response_type === "select_multi" ? [...input.querySelectorAll("input:checked")].map((i) => i.value)
    : q.response_type === "number" ? (input.value === "" ? null : Number(input.value)) : input.value;
  const unknown = el("input", { type: "checkbox", id: `${id}-u`, checked: cur?.answer_status === "unknown", disabled: dis });
  const ev = el("select", { id: `${id}-e`, multiple: true, "aria-label": "Attach evidence", disabled: dis }, ctx.evidence.filter((e) => e.state === "clean").map((e) => el("option", { value: e.evidence_id, selected: (cur?.evidence_refs || []).includes(e.evidence_id) }, e.filename)));
  const save = safe(async () => {
    const value = read(), isUnknown = unknown.checked;
    if (!isUnknown && (value === "" || value === null || (Array.isArray(value) && !value.length))) return;
    const body = { scope_id: ctx.scopeId, value: isUnknown ? null : value, answer_status: isUnknown ? "unknown" : "answered", evidence_refs: [...ev.selectedOptions].map((o) => o.value) };
    try {
      const res = await api(`/v1/assessments/${ctx.aid}/answers/${q.question_id}`, { method: "PUT", body, headers: { "If-Match": ctx.answers[key]?.etag || "0" }, raw: true });
      const data = await res.json();
      if (res.status === 409) { status.textContent = "Changed by someone else; reloading latest…"; say(status.textContent); return routes.assessment(ctx.aid); }
      if (!res.ok) throw new Error(data.message);
      ctx.answers[key] = data; status.textContent = "✓ Saved"; say(`Saved ${q.question_id}`);
      // Progress and conditional questions depend on persisted answers. Refresh after
      // each save so the submit gate and adaptive branches do not remain stale.
      await draw();
    } catch (e) { toast(e.message, true); }
  });
  [input, unknown, ev].forEach((n) => n.addEventListener("change", save));
  const swaskaOut = el("div", { class: "help", "aria-live": "polite" });
  const swaskaPrompt = el("textarea", { rows: 2, maxlength: 2000, placeholder: "Ask why this is needed or what evidence could help.", "aria-label": `Question for Swaska about ${q.question_id}` });
  const ask = el("button", { class: "secondary", type: "button", onclick: safe(async () => {
    const userMessage = swaskaPrompt.value.trim();
    if (!userMessage) return toast("Enter a question for Swaska", true);
    const t = await api(`/v1/assessments/${ctx.aid}/swaska/turns`, { method: "POST", body: { scope_id: ctx.scopeId, user_message: userMessage, parent_question_id: q.question_id } });
    swaskaOut.replaceChildren(el("strong", {}, "Swaska: "), t.clarification_text, t.needs_evidence ? ` Suggested evidence: ${t.evidence_type}.` : "", ` (${t.uncertainty})`);
  }) }, "Ask about this question");
  const swaskaDrawer = el("details", { class: "swaska-drawer" }, el("summary", {}, "Ask Swaska · question help"),
    el("p", { class: "help" }, "Swaska can explain this question and suggest evidence. Suggestions are not approvals."), swaskaPrompt, ask, swaskaOut);
  const answered = Boolean(cur);
  return el("article", { class: `q-card ${answered ? "is-answered" : ""}` },
    el("div", { class: "q-head" }, el("span", { class: "q-num" }, String(num)),
      el("div", {}, el("label", { for: id, class: "q-title" }, q.question),
        el("div", { class: "q-meta" }, el("span", { class: `tag ${q.required === "yes" ? "req" : ""}` }, q.required === "yes" ? "Required" : "If applicable"), state.me.is_staff ? el("span", { class: "q-id" }, q.question_id) : ""),
        q.guidance ? el("p", { class: "q-guidance" }, q.guidance) : "")),
    el("div", { class: "q-input" }, input),
    ctx.evidence.some((e) => e.state === "clean") ? el("div", { class: "q-evidence" }, el("span", { class: "help" }, "Attach evidence (optional)"), ev) : "",
    el("div", { class: "q-foot" },
      el("label", { class: "unknown-toggle", for: `${id}-u` }, unknown, el("span", {}, "I don't know")),
      q.evidence_request ? el("details", { class: "question-evidence-help" }, el("summary", {}, "What document could help?"), el("p", { class: "help" }, q.evidence_request)) : "",
      el("span", { class: `q-status ${answered ? "ok" : ""}`, id: `${id}-s` }, status)),
    swaskaDrawer);
}

function evidencePanel(ctx, draw) {
  const extractOut = el("div", { "aria-live": "polite" });
  const extractable = (e) => e.state === "clean" && ["text/plain", "text/csv", "application/json"].includes(e.content_type);
  const list = ctx.evidence.map((e) => el("li", {}, `${e.filename} - `, el("span", { class: `tag ${e.state === "clean" ? "ok" : "high"}` }, e.state), e.injection_flagged ? el("span", { class: "tag medium" }, "instruction-like text flagged") : "",
    extractable(e) ? agentButton("Suggest answers from this file", extractOut, async () => {
      const r = await api(`/v1/assessments/${ctx.aid}/agents/extraction`, { method: "POST", body: { evidence_id: e.evidence_id } });
      return r.items.length ? advisoryBox(`Candidate answers (${r.mode}) - unverified, enter them yourself if correct`, r.items.map((i) => `${i.question_id}: ${i.candidate_value}  [source: "${i.excerpt}"]`))
        : el("p", { class: "help" }, "No candidate answers found in this file.");
    }) : ""));
  const f = el("input", { type: "file", id: "ef", accept: ".pdf,.txt,.csv,.json,.docx,.xlsx" });
  return el("section", { class: "card assessment-documents", id: "assessment-documents" }, el("span", { class: "eyebrow" }, "STEP 2 · DOCUMENTS"), el("h3", {}, "Upload documents about your AI"),
    el("p", {}, "Start with any documents you already have. You can answer the questions even if you have no documents yet."),
    el("div", { class: "document-examples" }, [ ["AI register", "A list of your AI tools, their purpose and owners."], ["System overview", "How your AI works and which data or systems it uses."], ["Policies & test reports", "Your AI rules, approvals, risks or testing results."] ].map(([title, description]) => el("div", {}, el("strong", {}, title), el("p", { class: "help" }, description)))),
    list.length ? el("ul", {}, list) : el("p", { class: "help" }, "No files uploaded yet."), extractOut,
    el("label", { for: "ef" }, "Upload a document"), f,
    el("p", {}, el("button", { onclick: safe(async () => {
      const file = f.files[0]; if (!file) return toast("Choose a file first", true);
      const buf = await file.arrayBuffer();
      const g = await api(`/v1/assessments/${ctx.aid}/evidence/upload-url`, { method: "POST", body: { filename: file.name, content_type: file.type || "application/octet-stream", file_size_bytes: file.size, claimed_sha256: await sha256Hex(buf) } });
      const r = await api(g.upload_url, { method: "PUT", body: buf, headers: { "Content-Type": "application/octet-stream" } });
      toast(r.state === "clean" ? "Uploaded and scanned: clean" : `Upload ${r.state}: ${r.reason}`, r.state !== "clean"); draw();
    }) }, "Upload")),
    el("p", { class: "help" }, "PDF, Word, Excel, TXT, CSV or JSON. Files are checked for safety before use."),
    el("div", { class: "row" }, el("button", { class: "secondary", type: "button", onclick: () => document.getElementById("assessment-questions")?.scrollIntoView({ behavior: "smooth", block: "start" }) }, "Continue to questions"),
      list.length ? el("a", { href: `#/use-cases/${ctx.aid}` }, "View AI use cases from documents →") : ""));
}

function submitPanel(ctx, draw) {
  const p = ctx.a.progress, ready = p.required_answered >= p.required_total;
  return el("section", { class: "card" }, el("span", { class: "eyebrow" }, "STEP 4 · REVIEW & REPORT"), el("h3", {}, "Send your assessment for review"), el("p", { class: "help" }, "CloudSeals reviews your assessment before publishing your report. Submitting freezes your answers. This cannot be undone."),
    el("button", { disabled: !ready, onclick: safe(async () => { if (!confirm("Submit and freeze all answers?")) return; await api(`/v1/assessments/${ctx.aid}/submit`, { method: "POST", idem: true }); toast("Submitted"); draw(); }) }, ready ? "Submit" : `Answer ${p.required_total - p.required_answered} more required question(s)`));
}

async function reportsPanel(ctx, draw) {
  const { items } = await api(`/v1/assessments/${ctx.aid}/reports`);
  const staff = state.me.is_staff;
  const kids = [el("h3", {}, "Your reports"), el("p", { class: "help" }, "Your final report is based on your assessment and is released after CloudSeals review."),
    el("a", { href: "sample-assessment-report.html", target: "_blank", rel: "noopener" }, "Preview a sample report (synthetic example)")];
  if (!staff) {
    const inventory = await api(`/v1/assessments/${ctx.aid}/inventory`);
    if (inventory.delivery) kids.push(deliveredDiagnosticPanel(ctx.aid, inventory.delivery));
    else kids.push(el("p", { class: "help" }, "Document-based report and improvement roadmap: awaiting analysis, review and publication."));
  }
  if (!items.length) kids.push(el("p", { class: "help" }, staff || ctx.a.status === "In progress" ? "No reports yet." : "Your report is under CloudSeals review. It is published after approval."));
  for (const r of items) {
    const row = el("div", { class: "row" }, el("span", { class: `tag ${r.status === "published" ? "ok" : ""}` }, r.status), `v${r.version}`,
      ["pdf", "docx"].map((f) => el("button", { class: "secondary", onclick: safe(() => dl(`/v1/assessments/${ctx.aid}/reports/${r.report_id}/download?format=${f}`, `taad-report.${f}`)) }, f.toUpperCase())));
    kids.push(row);
    if (staff) kids.push(await reviewPanel(ctx, r, draw));
  }
  if (!staff) { const f = await api(`/v1/assessments/${ctx.aid}/findings`); if (f.items.length) kids.push(findingsTable(f.items)); }
  return el("section", { class: "card" }, kids);
}

function findingsTable(items, adjust) {
  return el("table", {}, el("caption", {}, "Findings (candidates for review, not legal determinations)"),
    el("thead", {}, el("tr", {}, ["Rule", "Severity", "Status", "Basis", adjust ? "Adjust" : ""].map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, items.map((f) => el("tr", {}, el("td", {}, `${f.rule_id} ${f.title}`), el("td", {}, el("span", { class: `tag ${f.severity_hint}` }, f.severity_hint)),
      el("td", {}, f.status), el("td", {}, f.citations.map((c) => `${c.question_id}=${c.answer}`).join(", ")), el("td", {}, adjust ? adjust(f) : "")))));
}

// ---------- TrustOps Core sandbox ----------
routes.trustops = async (selectedRunId) => {
  const overview = await api("/v1/agentops");
  const { items: runs, total } = await api("/v1/runs?limit=25");
  let activeRunId = selectedRunId || runs[0]?.run_id || null;
  const isSandbox = overview.mode === "sandbox";
  const canStart = isSandbox && state.me.roles.some((r) => ["customer_admin", "customer_architect", "customer_risk", "customer_controller", "cloudseals_assessor", "cloudseals_admin"].includes(r));
  const canApprove = state.me.roles.includes("customer_controller");
  const canExecute = isSandbox && state.me.roles.some((r) => ["customer_admin", "customer_architect", "customer_risk", "customer_controller", "cloudseals_assessor", "cloudseals_admin"].includes(r));
  const receiptId = `R-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const ref = `INV-${receiptId.slice(-6)}`;
  const sample = { receipt: { receipt_id: receiptId, amount_minor: 25000, currency: "USD", reference: ref },
    invoices: [{ invoice_id: `I-${receiptId.slice(-6)}`, amount_minor: 25000, currency: "USD", reference: ref }], remittance: { reference: ref } };
  const formField = (id, label, value, type = "text", attrs = {}) => {
    const control = el("input", { id, type, value, ...attrs });
    return el("div", { class: "workflow-field" }, el("label", { for: id }, label), control);
  };
  const receiptIdField = formField("workflow-receipt-id", "Receipt ID", sample.receipt.receipt_id, "text", { maxlength: 200, autocomplete: "off" });
  const receiptRefField = formField("workflow-receipt-reference", "Payment reference", sample.receipt.reference, "text", { maxlength: 200 });
  const amountField = formField("workflow-amount", "Received amount", "250.00", "number", { min: "0.01", step: "0.01", inputmode: "decimal" });
  const currencyField = formField("workflow-currency", "Currency", "USD", "text", { maxlength: 3, pattern: "[A-Za-z]{3}", autocapitalize: "characters" });
  const remittanceField = formField("workflow-remittance", "Remittance reference", sample.remittance.reference, "text", { maxlength: 200 });
  const invoiceRows = el("div", { class: "invoice-candidate-list" });
  let nextInvoiceIndex = 1;
  const makeInvoiceRow = (index, invoice = {}) => {
    const row = el("article", { class: "invoice-candidate" });
    row.append(el("div", { class: "invoice-candidate-heading" },
      el("span", { class: "invoice-candidate-number" }, `Candidate ${index + 1}`),
      el("button", { class: "remove-candidate", type: "button", "aria-label": `Remove candidate ${index + 1}`, onclick: () => {
        if (invoiceRows.children.length <= 1) return toast("Keep at least one invoice candidate", true);
        row.remove();
        [...invoiceRows.children].forEach((candidate, i) => {
          candidate.querySelector(".invoice-candidate-number").textContent = `Candidate ${i + 1}`;
          candidate.querySelector(".remove-candidate").setAttribute("aria-label", `Remove candidate ${i + 1}`);
        });
      } }, "Remove")),
      formField(`invoice-id-${index}`, "Invoice ID", invoice.invoice_id || `I-${receiptId.slice(-6)}-${index + 1}`, "text", { maxlength: 200 }),
      formField(`invoice-amount-${index}`, "Invoice amount", "250.00", "number", { min: "0.01", step: "0.01", inputmode: "decimal" }),
      formField(`invoice-currency-${index}`, "Currency", invoice.currency || "USD", "text", { maxlength: 3, pattern: "[A-Za-z]{3}" }),
      formField(`invoice-reference-${index}`, "Invoice reference", invoice.reference || ref, "text", { maxlength: 200 }));
    return row;
  };
  invoiceRows.append(makeInvoiceRow(0, sample.invoices[0]));
  const addInvoiceButton = el("button", { class: "secondary add-candidate", type: "button", onclick: () => {
    const index = nextInvoiceIndex++;
    const row = makeInvoiceRow(index);
    row.querySelector(`#invoice-amount-${index}`).value = amountField.querySelector("input").value;
    row.querySelector(`#invoice-currency-${index}`).value = currencyField.querySelector("input").value.toUpperCase();
    row.querySelector(`#invoice-reference-${index}`).value = receiptRefField.querySelector("input").value;
    invoiceRows.append(row);
  } }, "+ Add invoice candidate");
  const buildWorkflowPayload = () => {
    const minorUnits = (raw) => {
      const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
      if (!match) return null;
      const amount = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
      return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
    };
    const receiptIdValue = receiptIdField.querySelector("input").value.trim();
    const referenceValue = receiptRefField.querySelector("input").value.trim();
    const amount = minorUnits(amountField.querySelector("input").value);
    const currency = currencyField.querySelector("input").value.trim().toUpperCase();
    const remittance = remittanceField.querySelector("input").value.trim();
    if (!receiptIdValue || !referenceValue || !remittance || !amount || !/^[A-Z]{3}$/.test(currency)) {
      toast("Check the receipt, amount, three-letter currency, and references", true); return null;
    }
    const invoices = [...invoiceRows.children].map((row) => ({
      invoice_id: row.querySelector('[id^="invoice-id-"]').value.trim(),
      amount_minor: minorUnits(row.querySelector('[id^="invoice-amount-"]').value),
      currency: row.querySelector('[id^="invoice-currency-"]').value.trim().toUpperCase(),
      reference: row.querySelector('[id^="invoice-reference-"]').value.trim(),
    }));
    if (invoices.some((invoice) => !invoice.invoice_id || !invoice.amount_minor || !/^[A-Z]{3}$/.test(invoice.currency) || !invoice.reference)) {
      toast("Complete every invoice candidate with a valid amount and currency", true); return null;
    }
    return { receipt: { receipt_id: receiptIdValue, amount_minor: amount, currency, reference: referenceValue },
      invoices, remittance: { reference: remittance } };
  };
  const flow = el("section", { class: "trustops-flow is-ready", role: "status", "aria-live": "polite", "aria-busy": "false" });
  const isBedrock = String(overview.agent_mode).endsWith("_configured");
  const flowNames = ["Intake", "Match", "Reconciliation", "Cash Allocation", "Exception", "Audit"];
  const drawFlow = (mode) => {
    const running = mode === "running";
    const failed = mode === "error";
    const label = isBedrock ? "AI-ASSISTED WORKFLOW" : "GOVERNED AGENT WORKFLOW";
    const title = failed ? "Run stopped before a complete trace" : running ? "Six-agent workflow is running"
      : isBedrock ? "AI agents ready for a workflow" : "Six agents, one governed workflow";
    const message = failed ? "The runtime did not return a valid result. Check the input or model configuration, then try again."
      : running ? isBedrock ? "Six specialist steps are reviewing the payment and candidate invoices; the trace will appear when the workflow completes."
        : "Six specialist steps are checking the payment, candidate invoices, policy outcome, and audit record."
      : isBedrock ? "Run a workflow to review its six specialist steps, policy checks, and traceable outcome."
        : "Run a workflow to review the payment, check candidate invoices, apply policy, and create a traceable outcome.";
    flow.className = `trustops-flow ${running ? "is-running" : failed ? "is-error" : "is-ready"}`;
    flow.setAttribute("aria-busy", String(running));
    flow.replaceChildren(
      el("div", { class: "flow-heading" },
        el("div", {}, el("span", { class: "eyebrow" }, label), el("h3", {}, title), el("p", {}, message)),
        el("span", { class: `flow-live-pill ${running ? "" : "flow-idle-pill"}` },
          running ? el("span", { class: "flow-live-dot" }) : el("span", { class: "flow-ready-mark" }, failed ? "!" : "✓"),
          failed ? "STOPPED" : running ? "IN PROGRESS" : "READY")),
      el("div", { class: "flow-track", "aria-label": flowNames.join(", ") },
        flowNames.map((name, index) => el("div", { class: "flow-step" },
          el("span", { class: "flow-node" }, String(index + 1).padStart(2, "0")), el("span", { class: "flow-step-name" }, name)))),
      el("div", { class: "flow-progress", "aria-hidden": "true" }, el("span", {})),
      el("p", { class: "flow-footnote" }, running ? "Waiting for the run result and agent trace…"
        : failed ? "No successful run was recorded."
          : "Intake → Match → Reconciliation → Cash Allocation → Exception → Audit"));
  };
  drawFlow("ready");
  const runButton = el("button", { class: "primary-action", onclick: safe(async () => {
    const body = buildWorkflowPayload();
    if (!body) return;
    runButton.disabled = true;
    runButton.classList.add("button-running");
    runButton.replaceChildren("Running agents", el("span", { class: "button-spinner", "aria-hidden": "true" }));
    drawFlow("running");
    try {
      const run = await api(`/v1/workflows/${encodeURIComponent(overview.workflow_pack)}/runs`, { method: "POST", idem: true, body });
      toast(`Six agents completed: ${run.status}`); await routes.trustops(run.run_id);
    } catch {
      drawFlow("error");
      toast("Workflow run failed; no successful result was recorded.", true);
    } finally {
      runButton.disabled = false;
      runButton.classList.remove("button-running");
      runButton.replaceChildren("Run workflow", el("span", { "aria-hidden": "true" }, "→"));
    }
  }) }, "Run workflow", el("span", { "aria-hidden": "true" }, "→"));
  const detail = el("section", { id: "trustops-detail", class: "card run-detail", "aria-live": "polite" });
  const drawDetail = async (runId) => {
    if (!runId) { detail.replaceChildren(el("p", { class: "help" }, "Select a run to inspect its agent trace.")); return; }
    activeRunId = runId;
    const run = await api(`/v1/runs/${encodeURIComponent(runId)}`);
    const trace = (run.agent_trace || []).map((step, index) => {
      const rec = step.recommendation || {};
      const name = step.agent_id.split(".").at(-1).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
      const statusLabel = ({ completed: "Completed", routed: "Sent for review", no_action: "No action", failed: "Failed", evidence_manifest_created: "Recorded", proposal_created: "Proposal ready", not_required: "Not needed" })[step.status] || step.status.replaceAll("_", " ");
      const specifics = [rec.rationale || rec.explanation || rec.summary,
        rec.selected_invoice_id ? `Selected invoice ${rec.selected_invoice_id}.` : "",
        step.candidate_ids?.length ? `Candidate invoices: ${step.candidate_ids.join(", ")}.` : "",
        step.classification || step.reason_code ? `Decision: ${(step.classification || step.reason_code).replaceAll("_", " ")}.` : ""]
        .filter(Boolean).join(" ");
      const fallback = ({ intake: "Payment details were validated for this workflow.",
        cash_allocation: step.status === "proposal_created" ? "A cash allocation proposal was prepared for review." : "No allocation was proposed for this run.",
        exception: step.status === "routed" ? "This case was sent to the exception queue for human review." : "No exception: this case is within policy.",
        audit: "The workflow evidence record was created." })[name.toLowerCase().replaceAll(" ", "_")] || "The workflow step completed.";
      const stateClass = ["completed", "routed", "evidence_manifest_created"].includes(step.status) ? "trace-status-ok"
        : ["failed", "no_action"].includes(step.status) ? "trace-status-review" : "";
      return el("li", { class: "trace-step" },
        el("span", { class: "trace-step-index", "aria-hidden": "true" }, String(index + 1).padStart(2, "0")),
        el("div", { class: "trace-step-copy" }, el("h4", {}, name), el("p", {}, specifics || fallback)),
        el("span", { class: `trace-step-status ${stateClass}` }, statusLabel));
    });
    const proposal = run.proposal ? el("div", { class: "allocation-summary" },
      el("div", { class: "allocation-summary-intro" },
        el("span", { class: "allocation-check", "aria-hidden": "true" }, "✓"),
        el("div", {}, el("strong", {}, "Recommended allocation"),
          el("span", { class: "help" }, "Review the invoice and amount before preparing this action."))),
      el("div", { class: "allocation-details" },
        el("div", {}, el("span", { class: "summary-label" }, "Invoice"), el("strong", {}, run.proposal.invoice_id || "—")),
        el("div", {}, el("span", { class: "summary-label" }, "Amount"), el("strong", {}, `${run.proposal.currency || run.currency || ""} ${((run.proposal.amount_minor ?? run.amount_minor) / 100).toFixed(2)}`)),
        el("div", {}, el("span", { class: "summary-label" }, "Reference"), el("strong", {}, run.proposal.reference || "—"))))
      : el("p", { class: "help" }, "No allocation proposal was authorized.");
    const policy = run.policy_decision || {};
    const policyReason = (policy.reason_code || "").toLowerCase().replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
    const actions = [];
    if (run.status === "approval_required" && canApprove) {
      const reason = el("input", { "aria-label": "Controller decision reason", placeholder: "Reason required", maxlength: 2000 });
      const sumOut = el("div", { "aria-live": "polite" });
      actions.push(el("section", { class: "card" }, el("h3", {}, "Controller approval"), agentButton("Summarise for approver (advisory)", sumOut, () => approvalSummary(run.run_id)), sumOut,
        el("p", { class: "help" }, "A different customer_controller must approve. The API enforces maker-checker separation."), reason,
        el("div", { class: "row" }, el("button", { onclick: safe(async () => {
          if (!reason.value.trim()) return toast("Enter an approval reason", true);
          await api(`/v1/approvals/${run.run_id}/decision`, { method: "POST", idem: true, body: { decision: "approve", reason: reason.value } });
          toast("Approval recorded"); await routes.trustops(run.run_id);
        }) }, "Approve"), el("button", { class: "danger", onclick: safe(async () => {
          if (!reason.value.trim()) return toast("Enter a rejection reason", true);
          await api(`/v1/approvals/${run.run_id}/decision`, { method: "POST", idem: true, body: { decision: "reject", reason: reason.value } });
          toast("Proposal rejected"); await routes.trustops(run.run_id);
        }) }, "Reject"))));
    }
    if (canExecute && ["ready_to_prepare", "approved_to_prepare", "prepared"].includes(run.status)) {
      actions.push(el("div", { class: "card" }, el("h3", {}, "Governed execution"),
        el("p", { class: "help" }, "This action runs in the isolated sandbox and will not update a connected ERP system."),
        el("div", { class: "row" }, el("button", { class: "secondary", onclick: safe(async () => {
          const prepared = await api("/v1/execution/prepare", { method: "POST", idem: true, body: { run_id: run.run_id } });
          if (prepared.action_token) trustopsTokens.set(run.run_id, prepared.action_token);
          toast("Prepared. One-time token is valid for 60 seconds."); await drawDetail(run.run_id);
        }) }, run.status === "prepared" ? "Refresh action token" : "Prepare action"),
        run.status === "prepared" ? el("button", { onclick: safe(async () => {
          const token = trustopsTokens.get(run.run_id);
          if (!token) return toast("Prepare again to issue a new short-lived token", true);
          await api("/v1/execution/execute", { method: "POST", idem: true, body: { run_id: run.run_id, action_token: token } });
          trustopsTokens.delete(run.run_id); toast("Sandbox action completed"); await routes.trustops(run.run_id);
        }) }, "Run sandbox action") : "")));
    }
    if (run.status === "completed") actions.push(el("button", { class: "secondary", onclick: safe(async () => {
      const result = await api(`/v1/evidence/${run.run_id}/verify`, { method: "POST" });
      toast(result.valid ? "Evidence chain verified (local hash chain)" : "Evidence chain verification failed", !result.valid);
      await drawDetail(run.run_id);
    }) }, "Verify evidence chain"));
    const decisionSummary = el("div", { class: "decision-summary" },
      el("div", {}, el("span", { class: "summary-label" }, "Policy decision"),
        el("strong", { class: policy.decision === "ALLOW" ? "decision-allow" : "decision-escalate" }, policy.decision === "ALLOW" ? "Within policy" : policy.decision === "ESCALATE" ? "Review required" : policy.decision || "—"),
        el("span", { class: "help" }, policyReason)),
      el("div", {}, el("span", { class: "summary-label" }, "Payment amount"), el("strong", {}, `${run.currency || ""} ${(run.amount_minor / 100).toFixed(2)}`)));
    const auditFields = [
      ["Run ID", run.run_id], ["Workflow version", `${run.workflow_id} v${run.workflow_version}`],
      ["Input fingerprint", run.input_digest || "Unavailable"],
      ...(run.agent_trace || []).filter((step) => step.input_digest).map((step) => [`${step.agent_id} fingerprint`, step.input_digest]),
    ];
    const auditDetails = el("details", { class: "trace-integrity" }, el("summary", {}, "Technical audit details"),
      el("dl", {}, auditFields.map(([label, value]) => el("div", {}, el("dt", {}, label),
        el("dd", {}, label.includes("fingerprint") ? el("code", {}, value) : value)))));
    detail.replaceChildren(
      el("div", { class: "run-detail-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "WORKFLOW RUN"),
        el("h3", {}, `${run.receipt_id}`), el("p", { class: "help" }, "Payment review and agent trace")),
        el("span", { class: `status-pill ${run.status === "completed" ? "status-success" : run.status === "escalated" || run.status === "rejected" ? "status-danger" : "status-neutral"}` }, run.status.replaceAll("_", " "))),
      decisionSummary,
      el("div", { class: "section-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "EXECUTION TRACE"), el("h3", {}, "Six-agent workflow")),
        el("span", { class: "tag" }, `${run.agent_trace.length} steps`)),
      el("ol", { class: "trace-timeline", "aria-label": "Workflow agent trace" }, trace),
      auditDetails,
      el("div", { class: "proposal-panel" }, el("div", { class: "section-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "PROPOSED ACTION"), el("h3", {}, "Cash allocation"))), proposal),
      ...actions);
  };
  const history = runs.length ? el("div", { class: "run-list" }, runs.map((r) => el("button", { class: `run-item${activeRunId === r.run_id ? " is-active" : ""}`, "aria-pressed": activeRunId === r.run_id,
    onclick: safe(async (event) => {
      activeRunId = r.run_id;
      history.querySelectorAll(".run-item").forEach((item) => { item.classList.remove("is-active"); item.setAttribute("aria-pressed", "false"); });
      event.currentTarget.classList.add("is-active"); event.currentTarget.setAttribute("aria-pressed", "true");
      await drawDetail(r.run_id); detail.scrollIntoView({ behavior: "smooth", block: "start" });
    }) },
    el("span", { class: "run-item-main" }, el("strong", {}, r.receipt_id), el("span", { class: "help" }, `${r.currency || ""} ${(r.amount_minor / 100).toFixed(2)}`)),
    el("span", { class: `status-pill ${r.status === "completed" ? "status-success" : r.status === "escalated" || r.status === "rejected" ? "status-danger" : "status-neutral"}` }, r.status.replaceAll("_", " ")))))
    : el("p", { class: "empty-state" }, "No workflow runs yet. Start a run to see its trace here.");
  const agentCards = overview.agents.map((agent, index) => el("article", { class: "agent-card" },
    el("div", { class: "agent-card-top" }, el("span", { class: "agent-index" }, String(index + 1).padStart(2, "0")),
      el("span", { class: "agent-version" }, `v${agent.version}`)),
    el("h3", {}, agent.id.split(".").at(-1).replaceAll("_", " ")),
    el("p", { class: "agent-purpose" }, agent.purpose),
    el("div", { class: "permission-list" }, agent.authority.map((permission) => el("span", { class: "permission-chip" }, permission)))));
  const packCard = (title, text, status, href, active = false) => el(href ? "a" : "article", { class: `pack-card${active ? " is-active" : ""}${href || active ? "" : " is-planned"}`, ...(href ? { href } : {}) },
    el("span", { class: "pack-status" }, status), el("strong", {}, title), el("p", {}, text));
  const packs = el("section", { class: "pack-strip", "aria-label": "TrustOps workflow packs and tools" },
    packCard("LedgerSight AR / Cash", "Governed cash application with policy gates and maker-checker approval.", "WORKFLOW PACK · AVAILABLE", null, true),
    packCard("AI governance diagnostic", "Documents to AI use cases, framework gaps, maturity, roadmap and report.", "PIPELINE · AVAILABLE", "#/use-cases"),
    packCard("Framework library", "EU AI Act, ISO 42001, NIST AI RMF, SR 11-7 and FDA SaMD requirements.", "REFERENCE · AVAILABLE", "#/frameworks"),
    packCard("Agent Flow", "Watch all agents work through a flow, step by step.", "LIVE VIEW", "#/agent-flow"),
    packCard("More workflow packs", "Additional governed workflows are added as packs; none are configured yet.", "PLANNED", null));
  const page = el("div", { class: "trustops-page" }, packs,
    el("section", { class: "trustops-hero" }, el("div", {}, el("span", { class: "eyebrow" }, "CLOUDSEALS · TRUSTOPS CORE"),
      el("h2", {}, "LedgerSight AR / Cash"), el("p", {}, "Governed cash application with a traceable decision at every step.")),
      el("div", { class: "hero-badges" }, el("span", { class: "environment-pill" }, isSandbox ? "SANDBOX ENVIRONMENT" : "RUNTIME UNAVAILABLE"),
        el("span", { class: "pack-pill" }, `${overview.workflow_pack} · v${overview.workflow_version}`))),
    el("section", { class: `runtime-notice ${isSandbox ? "notice-sandbox" : "notice-unavailable"}`, role: "status" },
      el("span", { class: "notice-mark", "aria-hidden": "true" }, "i"),
      el("p", {}, isSandbox ? (String(overview.agent_mode).endsWith("_configured")
        ? "AI-assisted recommendations are checked against workflow policy before an action can be prepared. Every step is recorded for review."
        : "Matching and policy decisions follow defined workflow rules. Ambiguous cases are routed to authorized reviewers, and each step is traceable.")
        : "Workflow execution is unavailable in this environment. You can still review registered agents and available run traces.")),
    el("section", { class: "metric-grid", "aria-label": "Workflow run summary" },
      [["Runs", overview.runs], ["Completed", overview.completed], ["Needs approval", overview.approval_required], ["Escalated", overview.escalated]].map(([label, value], i) =>
        el("article", { class: "metric-card" }, el("span", { class: "metric-icon", "aria-hidden": "true" }, ["↗", "✓", "◷", "!"][i]),
          el("span", { class: "metric-value" }, String(value)), el("span", { class: "metric-label" }, label)))),
    flow,
    el("section", { class: "workbench-grid" },
      canStart ? el("article", { class: "workbench-card run-composer" },
        el("div", { class: "section-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "NEW EXECUTION"), el("h3", {}, "Start a workflow")),
          el("span", { class: "sample-pill" }, "Ready to edit")),
        el("p", { class: "workbench-description" }, "Review the payment details and candidate invoices before starting the governed workflow."),
        el("section", { class: "workflow-input-section", "aria-labelledby": "payment-heading" },
          el("div", { class: "workflow-section-title" }, el("div", {}, el("span", { class: "form-step" }, "01"), el("h4", { id: "payment-heading" }, "Received payment")),
            el("span", { class: "form-section-hint" }, "Bank receipt")),
          el("div", { class: "workflow-field-grid payment-fields" }, receiptIdField, receiptRefField, amountField, currencyField),
          el("div", { class: "remittance-field" }, remittanceField)),
        el("section", { class: "workflow-input-section invoice-section", "aria-labelledby": "invoice-heading" },
          el("div", { class: "workflow-section-title" }, el("div", {}, el("span", { class: "form-step" }, "02"), el("h4", { id: "invoice-heading" }, "Invoice candidates")),
            el("span", { class: "form-section-hint" }, "Exact match required")),
          invoiceRows, addInvoiceButton),
        el("div", { class: "composer-footer" }, el("span", { class: "help" }, "Exact matches proceed; ambiguous cases are escalated."), runButton)) : "",
      el("article", { class: "workbench-card history-card" }, el("div", { class: "section-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "TENANT ACTIVITY"), el("h3", {}, "Recent runs")),
        el("span", { class: "section-count" }, `${total} total`)), history)),
    detail,
    el("section", { class: "agent-section" }, el("div", { class: "section-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "THE SPECIALIST TEAM"),
      el("h3", {}, "Six focused agents")), el("span", { class: "section-count" }, "01 — 06")),
      el("div", { class: "agent-grid" }, agentCards)));
  main.replaceChildren(page);
  if (runs.length) await drawDetail(selectedRunId || runs[0].run_id);
};

// ---------- TrustOps workspace modules ----------
const moduleFrame = (eyebrow, title, description, ...content) => el("div", { class: "module-page" },
  el("div", { class: "module-page-heading" }, el("span", { class: "eyebrow" }, eyebrow), el("h2", {}, title), el("p", {}, description)), ...content);
const moduleCard = (title, description, status, route = null, variant = "") => el(route ? "a" : "article", {
  class: `module-card${route ? " module-card-link" : ""}${variant ? ` ${variant}` : ""}`,...(route ? { href: `#/${route}` } : {})
}, el("span", { class: "module-card-status" }, status), el("h3", {}, title), el("p", {}, description),
route ? el("span", { class: "module-card-open" }, "Open module →") : "");
const runStatusLabel = (status) => ({ completed: "Completed", escalated: "Escalated", rejected: "Rejected", approval_required: "Needs approval",
  prepared: "Ready to prepare", approved_to_prepare: "Approved to prepare", ready_to_prepare: "Ready to prepare" })[status] || status.replaceAll("_", " ");
const runStatusTag = (run) => el("span", { class: `tag ${run.status === "completed" ? "ok" : ["escalated", "rejected"].includes(run.status) ? "high" : ""}` }, runStatusLabel(run.status));
const decisionLabel = (run) => {
  const code = run.policy_decision?.reason_code || run.policy_decision?.decision;
  return ({ multiple_exact_candidates: "Multiple invoice matches", exact_match_within_limit: "Exact match within limits",
    allow: "Within policy", escalate: "Review required" })[(code || "").toLowerCase()] || (code ? code.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase()) : "Pending review");
};
const openRunLink = (run) => el("a", { href: `#/trustops/${encodeURIComponent(run.run_id)}` }, "Open trace");
const runTable = (runs, headings = ["Receipt", "Amount", "Decision", "Status", ""] ) => el("div", { class: "table-wrap" },
  el("table", { class: "module-table" }, el("thead", {}, el("tr", {}, headings.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, runs.map((r) => el("tr", {},
      el("td", {}, r.receipt_id), el("td", {}, `${r.currency || ""} ${((r.amount_minor || 0) / 100).toFixed(2)}`),
      el("td", {}, r.policy_decision?.reason_code || r.policy_decision?.decision || "Pending"), el("td", {}, runStatusTag(r)), el("td", {}, openRunLink(r)))))));

routes.dashboard = async () => {
  const [overview, { items: runs }, { items: assessments }] = await Promise.all([
    api("/v1/agentops"), api("/v1/runs?limit=100"), api("/v1/assessments")]);
  const canUseAdminMetrics = state.me.roles.some((role) => ["cloudseals_admin", "cloudseals_platform_ops", "cloudseals_reviewer", "cloudseals_assessor"].includes(role));
  const staffMetrics = canUseAdminMetrics ? await api("/v1/admin/metrics") : null;
  const cards = [
    moduleCard("LedgerSight AR / Cash", "Review payments, match invoices and create a governed cash application outcome.", "SANDBOX WORKFLOW", "trustops", "module-card-primary"),
    moduleCard("AI Architecture Diagnosis", "Assess systems, answer the versioned questionnaire, attach evidence and review published reports.", "ASSESSMENTS", "assessments"),
    moduleCard("AI Use Cases", "Read your documents, list the AI use cases they evidence and review each one before any analysis.", "DOCUMENT AGENT", "use-cases"),
    moduleCard("Reconciliation", "Inspect receipt matches, allocation proposals and policy outcomes.", "LIVE RUN DATA", "reconciliation"),
    moduleCard("Exceptions", "Review ambiguous matches, escalations and rejected workflow actions.", "LIVE RUN DATA", "exceptions"),
    moduleCard("Approvals", "Handle controller decisions with maker-checker separation.", "ROLE-GATED", "approvals"),
    moduleCard("Evidence Fabric", "Review run evidence and verify its integrity chain and signatures.", "TAMPER-EVIDENT", "evidence"),
    moduleCard("Readiness", "Track assessment completion and reviewer-approved reports.", "ASSESSMENT STATUS", "readiness"),
    moduleCard("Frameworks", "EU AI Act, ISO 42001, NIST AI RMF, SR 11-7 and FDA SaMD reference requirements and controls.", "REFERENCE LIBRARY", "frameworks"),
    moduleCard("Shadow ROI", "ROI measurement is unavailable until baseline and cost telemetry are configured.", "NOT CONFIGURED", "shadow-roi"),
  ];
  const metrics = staffMetrics
    ? [["Assessments", staffMetrics.assessments], ["Submitted", staffMetrics.submitted], ["In review", staffMetrics.review_queue], ["Published reports", staffMetrics.published_reports]]
    : [["Assessments", assessments.length], ["Workflow runs", overview.runs], ["Completed", overview.completed], ["Needs approval", overview.approval_required]];
  const tenant = state.me.tenant ? tenantLabel(state.me.tenant) : state.me.is_staff ? "CloudSeals operations" : "Customer workspace";
  const metricNotes = canUseAdminMetrics ? ["In this workspace", "Awaiting submission", "Reviewer queue", "Approved and available"]
    : ["In this workspace", "Across all workflows", "Successfully completed", "Waiting for controller"];
  const activity = runs.length ? el("div", { class: "dashboard-activity-list", "aria-label": "Latest workflow activity" }, runs.slice(0, 5).map((run) =>
    el("article", { class: "dashboard-activity-row" },
      el("div", { class: "activity-main" }, el("span", { class: "activity-mark", "aria-hidden": "true" }, run.status === "completed" ? "✓" : run.status === "escalated" ? "!" : "↗"),
        el("div", {}, el("strong", {}, run.receipt_id), el("span", {}, decisionLabel(run)))),
      el("span", { class: "activity-amount" }, `${run.currency || ""} ${((run.amount_minor || 0) / 100).toFixed(2)}`), runStatusTag(run),
      el("a", { class: "activity-open", href: `#/trustops/${encodeURIComponent(run.run_id)}`, "aria-label": `Open workflow trace for ${run.receipt_id}` }, "View trace →"))))
    : el("div", { class: "dashboard-empty" }, el("span", { class: "dashboard-empty-mark", "aria-hidden": "true" }, "↗"),
      el("div", {}, el("strong", {}, "No workflow activity yet"), el("p", {}, "Start a LedgerSight workflow to see payment decisions and traceable outcomes here.")),
      el("a", { href: "#/trustops" }, "Start a workflow →"));
  main.replaceChildren(el("div", { class: "module-page command-center-page" },
    el("section", { class: "command-hero" },
      el("div", { class: "command-hero-copy" }, el("span", { class: "eyebrow" }, "CLOUDSEALS · TRUSTOPS"),
        el("h2", {}, "Command Center"), el("p", {}, "A clear view of your assessments, governed workflows and decisions that need attention."),
        el("div", { class: "command-hero-actions" }, el("a", { class: "command-action command-action-primary", href: "#/trustops" }, "Start a workflow", el("span", { "aria-hidden": "true" }, "→")),
          el("a", { class: "command-action", href: "#/assessments" }, "Open diagnosis"))),
      el("div", { class: "command-hero-side" }, el("span", { class: "workspace-mark", "aria-hidden": "true" }, tenant.slice(0, 1).toUpperCase()),
        el("div", {}, el("span", { class: "workspace-label" }, "WORKSPACE"), el("strong", {}, tenant)))),
    el("section", { class: "module-metrics command-metrics", "aria-label": "Workspace summary" }, metrics.map(([label, value], index) =>
      el("article", { class: `command-metric metric-accent-${index + 1}` }, el("span", { class: "command-metric-icon", "aria-hidden": "true" }, ["◫", "↗", "✓", "◷"][index]),
        el("div", {}, el("span", {}, label), el("strong", {}, String(value)), el("small", {}, metricNotes[index]))))),
    el("section", { class: "command-modules" }, el("div", { class: "command-section-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "YOUR WORKSPACE"),
      el("h3", {}, "Operations and governance")), el("span", { class: "section-count" }, "8 modules")), el("div", { class: "module-card-grid dashboard-card-grid" }, cards)),
    el("section", { class: "module-panel dashboard-activity-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "LATEST ACTIVITY"),
      el("h3", {}, "Recent workflow decisions")), el("a", { href: "#/reconciliation" }, "All activity →")), activity)));
};

routes.reconciliation = async () => {
  const { items, total } = await api("/v1/runs?limit=100");
  const matched = items.filter((r) => !["escalated", "rejected"].includes(r.status));
  main.replaceChildren(moduleFrame("OPERATIONS · CASH APPLICATION", "Reconciliation",
    `${total} tenant-scoped workflow runs · inspect match and allocation decisions`,
    el("section", { class: "module-metrics compact" }, [["Runs", total], ["Reconciled", matched.length], ["Exceptions", items.length - matched.length]].map(([k, v]) => el("article", {}, el("span", {}, k), el("strong", {}, String(v))))),
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "RECEIPT MATCHING"), el("h3", {}, "Recent reconciliations"))),
      items.length ? runTable(items) : el("p", { class: "empty-state" }, "No reconciliations yet. Start a LedgerSight workflow to create one."))));
};

routes.exceptions = async () => {
  const { items } = await api("/v1/runs?limit=100");
  const exceptions = items.filter((r) => ["escalated", "approval_required", "rejected"].includes(r.status) || r.policy_decision?.decision === "ESCALATE");
  main.replaceChildren(moduleFrame("OPERATIONS · HUMAN REVIEW", "Exceptions",
    "Escalated, ambiguous or rejected transactions that need human attention.",
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "ATTENTION REQUIRED"), el("h3", {}, `${exceptions.length} open or resolved exceptions`))),
      exceptions.length ? runTable(exceptions) : el("p", { class: "empty-state" }, "No exceptions are recorded."))));
};

async function approvalSummary(runId) {
  const r = await api(`/v1/runs/${runId}/approval-summary`);
  return advisoryBox(`Approval summary (${r.mode}) - the policy decision is unchanged`, [r.summary, r.decision_reason, r.uncertainty]);
}

routes.approvals = async () => {
  const { items } = await api("/v1/runs?limit=100");
  const pending = items.filter((r) => r.status === "approval_required");
  const canApprove = state.me.roles.includes("customer_controller");
  const cards = pending.map((run) => {
    const reason = el("textarea", { rows: 2, maxlength: 2000, placeholder: "Decision reason (required)", "aria-label": `Decision reason for ${run.receipt_id}` });
    const decide = (decision) => safe(async () => {
      if (!reason.value.trim()) return toast("Enter a decision reason", true);
      await api(`/v1/approvals/${run.run_id}/decision`, { method: "POST", idem: true, body: { decision, reason: reason.value.trim() } });
      toast(`Approval ${decision} recorded`); await routes.approvals();
    });
    const sumOut = el("div", { "aria-live": "polite" });
    return el("article", { class: "approval-card" }, el("div", {}, el("span", { class: "eyebrow" }, "PENDING CONTROLLER REVIEW"), el("h3", {}, run.receipt_id),
      el("p", {}, `${run.currency} ${(run.amount_minor / 100).toFixed(2)} · ${run.policy_decision?.reason_code || "Approval required"}`), openRunLink(run),
      agentButton("Summarise for approver (advisory)", sumOut, () => approvalSummary(run.run_id)), sumOut),
      canApprove ? el("div", {}, reason, el("div", { class: "row" }, el("button", { onclick: decide("approve") }, "Approve"), el("button", { class: "danger", onclick: decide("reject") }, "Reject")))
        : el("p", { class: "module-note" }, "Controller role required. The workflow initiator cannot approve their own action."));
  });
  main.replaceChildren(moduleFrame("OPERATIONS · MAKER CHECKER", "Approvals", "Controller decisions are recorded with a reason and an evidence event.",
    el("section", { class: "module-panel" }, cards.length ? cards : el("p", { class: "empty-state" }, "No controller approvals are waiting."))));
};

routes.evidence = async () => {
  const { items } = await api("/v1/runs?limit=100");
  const verify = async (runId) => {
    const result = await api(`/v1/evidence/${runId}/verify`, { method: "POST" });
    evidenceVerification.set(runId, result);
    toast(result.valid ? "Local evidence chain verified" : "Evidence chain verification failed", !result.valid);
    await routes.evidence();
  };
  const rows = items.map((run) => {
    const evidence = evidenceVerification.get(run.run_id);
    return el("tr", {}, el("td", {}, run.receipt_id), el("td", {}, runStatusTag(run)),
      el("td", {}, evidence ? `${evidence.valid ? "Verified" : "Invalid"} · ${evidence.records.length} records · ${evidence.integrity}` : "Not checked"),
      el("td", {}, el("button", { class: "secondary", disabled: !["completed", "prepared", "approved_to_prepare"].includes(run.status),
        onclick: safe(() => verify(run.run_id)) }, evidence ? "Recheck chain" : "Verify chain")));
  });
  main.replaceChildren(moduleFrame("GOVERNANCE · EVIDENCE FABRIC", "Evidence",
    "Run evidence is scoped to your tenant. This environment verifies a local SHA-256 chain; production KMS signatures and immutable storage are not connected.",
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "RUNTIME EVIDENCE"), el("h3", {}, "Evidence verification"))),
      rows.length ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" }, el("thead", {}, el("tr", {}, ["Receipt", "Run status", "Integrity", ""].map((h) => el("th", {}, h)))), el("tbody", {}, rows)))
        : el("p", { class: "empty-state" }, "No workflow evidence yet."))));
};

routes.readiness = async () => {
  const { items } = await api("/v1/assessments");
  const rows = await Promise.all(items.map(async (assessment) => {
    const [detail, reports, findings] = await Promise.all([
      api(`/v1/assessments/${assessment.assessment_id}`), api(`/v1/assessments/${assessment.assessment_id}/reports`),
      api(`/v1/assessments/${assessment.assessment_id}/findings`)]);
    return { assessment, detail, reports: reports.items, findings: findings.items };
  }));
  const table = rows.length ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" },
    el("thead", {}, el("tr", {}, ["AI system", "Assessment", "Required answers", "Findings", "Published reports"].map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map(({ assessment, detail, reports, findings }) => el("tr", {},
      el("td", {}, assessment.ai_system_name), el("td", {}, assessment.status),
      el("td", {}, `${detail.progress.required_answered} / ${detail.progress.required_total}`), el("td", {}, String(findings.length)),
      el("td", {}, String(reports.filter((r) => r.status === "published").length)))))))
    : el("p", { class: "empty-state" }, "Create an assessment to start collecting readiness evidence.");
  main.replaceChildren(moduleFrame("DIAGNOSIS · READINESS", "Readiness", "Assessment progress and reviewed artifacts only. This view does not certify regulatory compliance.",
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "ASSESSMENT COVERAGE"), el("h3", {}, "Evidence-backed status"))), table)));
};

routes["shadow-roi"] = async () => {
  main.replaceChildren(moduleFrame("OPERATIONS · ECONOMICS", "Shadow ROI", "Compare governed workflow outcomes with a measured baseline before estimating value.",
    el("section", { class: "module-panel roi-empty" }, el("span", { class: "module-card-status" }, "NOT CONFIGURED"), el("h3", {}, "ROI baseline is not connected"),
      el("p", {}, "No savings, automation rate or cost figures are shown because the required baseline and model/runtime cost telemetry are not configured."),
      el("div", { class: "module-metrics compact" }, [["Baseline", "Not set"], ["Workflow costs", "Not metered"], ["Verified benefit", "No data"]].map(([k, v]) => el("article", {}, el("span", {}, k), el("strong", {}, v)))))));
};

routes.integrations = async () => {
  const overview = await api("/v1/agentops");
  main.replaceChildren(moduleFrame("ADMINISTRATION · CONNECTIONS", "Integrations", "Only connections actually configured by this environment are shown.",
    el("section", { class: "module-card-grid" }, moduleCard("SAP ERP", "Cash allocation execution is routed to the isolated mock adapter.", overview.connector_status === "mock_only" ? "MOCK ONLY" : "UNAVAILABLE"),
      moduleCard("Bank / remittance", "Remittance arrives as a reviewed workflow input; no bank feed is connected.", "NOT CONNECTED"),
      moduleCard("Identity provider", state.cfg.mode === "oidc" ? "OIDC sign-in is configured for this environment." : "Local development access is active; no external provider is used.", state.cfg.mode === "oidc" ? "OIDC" : "LOCAL DEV"))));
};

routes.datasets = async () => {
  const { items } = await api("/v1/assessments");
  const rows = await Promise.all(items.map(async (assessment) => ({ assessment,
    evidence: (await api(`/v1/assessments/${assessment.assessment_id}/evidence`)).items })));
  const table = rows.length ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" },
    el("thead", {}, el("tr", {}, ["Assessment", "Industry", "Evidence files", "Scan state"].map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map(({ assessment, evidence }) => el("tr", {}, el("td", {}, assessment.ai_system_name), el("td", {}, assessment.industry),
      el("td", {}, String(evidence.length)), el("td", {}, evidence.length ? [...new Set(evidence.map((e) => e.state))].join(", ") : "No uploads"))))))
    : el("p", { class: "empty-state" }, "No assessments or evidence datasets yet.");
  main.replaceChildren(moduleFrame("ADMINISTRATION · DATA", "Datasets", "Evidence uploads are tenant-scoped, quarantined and scanned before use.",
    el("section", { class: "module-panel" }, table)));
};

routes.workflows = async () => {
  const overview = await api("/v1/agentops");
  main.replaceChildren(moduleFrame("ADMINISTRATION · WORKFLOW REGISTRY", "Workflows", "Registered workflow packs and the environment boundary.",
    el("section", { class: "module-card-grid" }, moduleCard(overview.workflow_pack, `Version ${overview.workflow_version} · ${overview.connector} adapter`, overview.mode === "sandbox" ? "SANDBOX ENABLED" : "DISABLED"),
      moduleCard("Runtime activation", "No production activation path is configured in this TAAD deployment.", "REQUIRES CORE APPROVAL"))));
};

routes.agents = async () => {
  const [overview, advisory] = await Promise.all([api("/v1/agentops"), api("/v1/agents")]);
  main.replaceChildren(moduleFrame("ADMINISTRATION · AGENT REGISTRY", "Agents", "Registered specialists, their responsibilities and their permitted authority.",
    el("section", { class: "module-card-grid agent-registry-grid" }, advisory.items.map((agent, index) => el("article", { class: "module-panel" },
      el("span", { class: "module-card-status" }, `ADVISORY ${String(index + 1).padStart(2, "0")} · v${agent.version} · READ ONLY`),
      el("h3", {}, agent.agent_id.split(".").at(-1).replaceAll("_", " ")), el("p", {}, agent.purpose),
      el("div", { class: "permission-list" }, agent.approved_capabilities.map((c) => el("span", { class: "permission-chip" }, c))),
      el("p", { class: "module-note" }, `Fallback: ${agent.fallback}`)))),
    el("section", { class: "module-card-grid agent-registry-grid" }, overview.agents.map((agent, index) => el("article", { class: "module-panel" },
      el("span", { class: "module-card-status" }, `AGENT ${String(index + 1).padStart(2, "0")} · v${agent.version}`),
      el("h3", {}, agent.id.split(".").at(-1).replaceAll("_", " ")), el("p", {}, agent.purpose),
      el("div", { class: "permission-list" }, agent.authority.map((permission) => el("span", { class: "permission-chip" }, permission))))))));
};

routes.models = async () => {
  const overview = await api("/v1/agentops");
  const configured = String(overview.agent_mode).endsWith("_configured");
  main.replaceChildren(moduleFrame("ADMINISTRATION · MODEL ROUTING", "Models", "Model reasoning is advisory; deterministic policy controls action authority.",
    el("section", { class: "module-card-grid" }, moduleCard(configured ? (overview.agent_mode.startsWith("vertex") ? "Google Vertex AI (Gemini)" : "Amazon Bedrock") : "Deterministic reference mode",
      configured ? `Configured route: ${overview.model_id}.` : "No model route is configured. Agent roles use deterministic local logic.", configured ? "CONFIGURED" : "ACTIVE"),
      moduleCard("Cost and latency metering", "Per-call token, latency and cost telemetry are not available in this environment.", "NOT INSTRUMENTED"))));
};

routes.policies = async () => {
  const overview = await api("/v1/agentops");
  const { items } = await api("/v1/runs?limit=50");
  main.replaceChildren(moduleFrame("ADMINISTRATION · POLICY", "Policies", "Read-only view of active workflow guardrails and recent policy outcomes.",
    el("section", { class: "module-panel" }, el("span", { class: "module-card-status" }, "ACTIVE WORKFLOW GUARDRAILS"),
      el("ul", { class: "guardrail-list" }, overview.global_prohibitions.map((rule) => el("li", {}, rule)))),
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "DECISION HISTORY"), el("h3", {}, "Recent policy decisions"))),
      items.length ? runTable(items.slice(0, 20)) : el("p", { class: "empty-state" }, "No policy decisions yet."))));
};

routes.authority = async () => {
  const overview = await api("/v1/agentops");
  main.replaceChildren(moduleFrame("ADMINISTRATION · DELEGATED AUTHORITY", "Authority", "Authority is constrained by the workflow manifest; no user-editable authority grants are exposed here.",
    el("section", { class: "module-card-grid agent-registry-grid" }, overview.agents.map((agent) => el("article", { class: "module-panel" },
      el("h3", {}, agent.id.split(".").at(-1).replaceAll("_", " ")), el("p", {}, agent.purpose),
      el("div", { class: "permission-list" }, agent.authority.map((permission) => el("span", { class: "permission-chip" }, permission))))))));
};

routes["approval-matrix"] = async () => {
  const { items } = await api("/v1/runs?limit=100");
  main.replaceChildren(moduleFrame("ADMINISTRATION · SEGREGATION OF DUTIES", "Approval matrix", "Runtime approval rules are enforced by the API and cannot be edited in this workspace.",
    el("section", { class: "module-panel" }, el("div", { class: "table-wrap" }, el("table", { class: "module-table" },
      el("thead", {}, el("tr", {}, ["Action", "Required role", "Separation rule", "Current queue"].map((h) => el("th", {}, h)))),
      el("tbody", {}, [["Approve consequential allocation", "customer_controller", "Initiator cannot approve own action", items.filter((r) => r.status === "approval_required").length],
        ["Prepare / execute", "Authorized workflow role", "Policy + approval + pre-commit evidence required", items.filter((r) => ["ready_to_prepare", "approved_to_prepare", "prepared"].includes(r.status)).length]]
        .map((row) => el("tr", {}, row.map((cell) => el("td", {}, String(cell)))))))))));
};

routes.agentops = async () => {
  const overview = await api("/v1/agentops");
  const { items } = await api("/v1/runs?limit=100");
  main.replaceChildren(moduleFrame("ADMINISTRATION · AGENT OPERATIONS", "AgentOps", "Runtime health and run outcomes. Cost, latency, retry and queue telemetry are not instrumented here.",
    el("section", { class: "module-metrics compact" }, [["Run count", overview.runs], ["Completed", overview.completed], ["Approvals", overview.approval_required], ["Escalated", overview.escalated]].map(([k, v]) => el("article", {}, el("span", {}, k), el("strong", {}, String(v))))),
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "RUN LOG"), el("h3", {}, "Recent activity"))),
      items.length ? runTable(items) : el("p", { class: "empty-state" }, "No runtime activity yet."))));
};

routes["tenant-settings"] = async (tenantId) => {
  let tenant = state.me.tenant;
  if (state.me.roles.includes("cloudseals_admin")) {
    const { items } = await api("/v1/admin/tenants");
    tenant = items.find((item) => item.tenant_id === tenantId) || (items.length === 1 ? items[0] : null);
    if (!tenant) return main.replaceChildren(moduleFrame("ADMINISTRATION · TENANT", "Tenant settings", "Choose a tenant to review its settings.",
      el("section", { class: "module-card-grid" }, items.map((item) => moduleCard(item.name || item.tenant_id,
        `Industry: ${item.industry || "Not set"} · Residency: ${item.residency_profile || "Not set"}`, "TENANT", `tenant-settings/${item.tenant_id}`)))));
  }
  if (!tenant) return main.replaceChildren(moduleFrame("ADMINISTRATION · TENANT", "Tenant settings", "No tenant context is available for this identity.",
    el("p", { class: "empty-state" }, "Tenant settings are unavailable.")));
  const canManage = state.me.roles.includes("cloudseals_admin");
  const toggle = el("input", { type: "checkbox", id: "preliminary-report", checked: Boolean(tenant.allow_preliminary_report), disabled: !canManage });
  const save = el("button", { disabled: !canManage, onclick: safe(async () => {
    const updated = await api(`/v1/admin/tenants/${tenant.tenant_id}/settings`, { method: "PUT", body: { allow_preliminary_report: toggle.checked } });
    state.me.tenant = updated; toast("Tenant setting saved");
  }) }, "Save setting");
  main.replaceChildren(moduleFrame("ADMINISTRATION · TENANT", "Tenant settings", "Tenant identity and report visibility controls.",
    el("section", { class: "module-panel tenant-settings-panel" }, el("span", { class: "module-card-status" }, canManage ? "ADMIN ACCESS" : "READ ONLY"),
      el("h3", {}, tenantLabel(tenant)),
      el("dl", { class: "tenant-facts" }, el("div", {}, el("dt", {}, "Tenant ID"), el("dd", {}, tenant.tenant_id)),
        el("div", {}, el("dt", {}, "Industry"), el("dd", {}, tenant.industry || "Not provided")),
        el("div", {}, el("dt", {}, "Residency"), el("dd", {}, tenant.residency_profile || "Not configured"))),
      el("label", { class: "setting-toggle", for: "preliminary-report" }, toggle, "Allow preliminary report visibility"),
      el("p", { class: "module-note" }, "Preliminary reports remain visibly marked as draft; this setting does not approve or publish reports."), save)));
};

async function reviewPanel(ctx, r, draw) {
  const { items } = await api(`/v1/assessments/${ctx.aid}/findings`);
  const reason = el("textarea", { id: `rr-${r.report_id}`, rows: 2, placeholder: "Reviewer reason (required)" });
  reason.value = ctx.reason || "";                       // survive panel re-renders after each action
  reason.addEventListener("input", () => { ctx.reason = reason.value; });
  const published = r.status === "published";
  const adjust = (f) => { const s = el("select", { "aria-label": `Status for ${f.rule_id}`, disabled: published }, ["Confirmed gap", "Potential gap", "No gap evidenced", "Not applicable"].map((o) => el("option", { value: o, selected: o === f.status }, o)));
    s.addEventListener("change", safe(async () => { if (!reason.value.trim()) { toast("Enter a reviewer reason first", true); s.value = f.status; return; } await api(`/v1/assessments/${ctx.aid}/findings/${f.rule_id}/review`, { method: "POST", body: { status: s.value, reason: reason.value } }); toast("Finding updated"); draw(); })); return s; };
  const decide = (d) => safe(async () => { if (!reason.value.trim()) return toast("Enter a reviewer reason", true); await api(`/v1/assessments/${ctx.aid}/reviews/${r.report_id}/decision`, { method: "POST", idem: true, body: { decision: d, reviewer_reason: reason.value } }); toast(`Decision recorded: ${d}`); draw(); });
  const sumOut = el("div", { "aria-live": "polite" });
  const kids = [findingsTable(items, adjust), agentButton("Summarise findings (advisory)", sumOut, async () => {
    const r = await api(`/v1/assessments/${ctx.aid}/agents/findings-summary`, { method: "POST" });
    return advisoryBox(`Findings summary (${r.mode})`, r.items.map((i) => `${i.rule_id}: ${i.summary} (${i.uncertainty})`));
  }), sumOut];
  if (state.me.roles.includes("cloudseals_reviewer") && !published) kids.push(el("label", { for: reason.id }, "Reviewer reason"), reason,
    el("div", { class: "row" }, el("button", { onclick: decide("approve") }, "Approve & publish"), el("button", { class: "secondary", onclick: decide("request_clarification") }, "Request clarification"), el("button", { class: "danger", onclick: decide("reject") }, "Reject")));
  if (published && state.me.roles.some((x) => ["cloudseals_admin", "cloudseals_assessor"].includes(x))) kids.push(blueprintForm(ctx, r));
  return el("div", {}, kids);
}

function blueprintForm(ctx, r) {
  const notesOut = el("div", { "aria-live": "polite" });
  const f = el("form", { onsubmit: safe(async (e) => { e.preventDefault(); const d = new FormData(f);
    const criteria = String(d.get("sc") || "").split("\n").map((x) => x.trim()).filter(Boolean);
    const bp = await api(`/v1/assessments/${ctx.aid}/poc-blueprints`, { method: "POST", idem: true, body: { report_id: r.report_id, workflow_pack_id: d.get("wp"), customer_security_signoff_ref: d.get("cs"), cloudseals_architect_signoff_ref: d.get("ca"), success_criteria: criteria } });
    toast(`Draft blueprint ${bp.blueprint_id.slice(0, 8)} created (runtime blocked)`);
    notesOut.replaceChildren(agentButton("Draft scope notes (advisory)", notesOut, async () => {
      const n = await api(`/v1/assessments/${ctx.aid}/poc-blueprints/${bp.blueprint_id}/draft-notes`, { method: "POST" });
      return advisoryBox(`POC draft notes (${n.mode})`, [n.scope_summary, ...n.open_questions.map((q) => `Open question: ${q}`), n.uncertainty]);
    })); }) },
  el("h3", {}, "Draft POC blueprint"), el("p", { class: "help" }, "Draft only. Runtime activation and credentials need a separate approval."),
  el("label", { for: "wp" }, "Workflow pack ID"), el("input", { id: "wp", name: "wp", required: true }),
  el("label", { for: "cs" }, "Customer security sign-off ref"), el("input", { id: "cs", name: "cs" }),
  el("label", { for: "ca" }, "CloudSeals architect sign-off ref"), el("input", { id: "ca", name: "ca" }),
  el("label", { for: "sc" }, "Success criteria (one per line, at least one)"), el("textarea", { id: "sc", name: "sc", rows: 3, required: true }),
  el("p", {}, el("button", {}, "Create draft blueprint")), notesOut);
  return f;
}

// ---------- customer team ----------
routes.team = async () => {
  const out = el("p", { class: "help", "aria-live": "polite" });
  const sel = el("select", { id: "role" }, ["customer_architect", "customer_risk", "customer_contributor"].map((r) => el("option", { value: r }, r)));
  main.replaceChildren(moduleFrame("WORKSPACE · PEOPLE", "Team", "Invite colleagues into this tenant workspace and assign the least access they need.",
    el("section", { class: "module-card-grid team-actions" },
      el("form", { class: "module-panel", onsubmit: safe(async (event) => { event.preventDefault(); const r = await api("/v1/tenant/invitations", { method: "POST", body: { role: sel.value } }); out.textContent = r.invitation_token ? `Invitation token (local development only): ${r.invitation_token}` : "Invitation created. Delivery depends on workspace email configuration."; }) },
        el("span", { class: "eyebrow" }, "INVITE MEMBER"), el("h3", {}, "Choose a workspace role"), el("label", { for: "role" }, "Role"), sel,
        el("p", { class: "help" }, "Administrators and architects can coordinate assessment work; contributors receive scoped access."), el("button", {}, "Create invitation"), out),
      el("form", { class: "module-panel", onsubmit: safe(async (event) => { event.preventDefault(); await api("/v1/invitations/accept", { method: "POST", body: { token: $("#tok").value.trim() } }); state.me = null; toast("Invitation accepted"); render(); }) },
        el("span", { class: "eyebrow" }, "JOIN WORKSPACE"), el("h3", {}, "Accept an invitation"), el("label", { for: "tok" }, "Invitation token"), el("input", { id: "tok", required: true }),
        el("p", { class: "help" }, "Use the invitation token provided by your workspace administrator."), el("button", { class: "secondary" }, "Accept invitation")))));
};

// ---------- staff ----------
routes.admin = async () => {
  const m = await api("/v1/admin/metrics");
  const labels = { registrations: "Registrations", assessments: "Assessments", submitted: "Submitted", review_queue: "In review queue", published_reports: "Published reports", poc_blueprints: "POC blueprints" };
  main.replaceChildren(moduleFrame("CLOUDSEALS · ADMINISTRATION", "Portfolio", "A cross-tenant operational overview for authorized CloudSeals staff.",
    el("section", { class: "module-metrics" }, Object.entries(labels).map(([key, label]) => el("article", {}, el("span", {}, label), el("strong", {}, String(m[key] ?? 0))))),
    el("section", { class: "module-card-grid" }, moduleCard("Review queue", "Open submitted assessments awaiting reviewer action.", `${m.review_queue ?? 0} IN QUEUE`, "queue"),
      moduleCard("Registrations", "Review organisation access requests and engagement verification.", `${m.registrations ?? 0} REQUESTS`, "registrations"),
      moduleCard("Activity", "Inspect recorded administrative and assessment events.", "AUDIT VIEW", "activity"))));
};
routes.queue = async () => {
  const { items } = await api("/v1/admin/review-queue");
  const rows = items.map((i) => el("tr", {},
    el("td", {}, i.assessment_id.slice(0, 8)), el("td", {}, String(i.finding_count)),
    el("td", {}, el("span", { class: "tag medium" }, i.status)),
    el("td", {}, el("a", { href: `#/assessment/${i.assessment_id}` }, "Review assessment →"))));
  const content = items.length
    ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" },
      el("thead", {}, el("tr", {}, ["Assessment", "Findings", "Status", ""].map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows)))
    : el("p", { class: "empty-state" }, "Nothing is waiting for review.");
  main.replaceChildren(moduleFrame("CLOUDSEALS · REVIEW", "Review queue", "Review submitted assessment findings, record a decision, and publish only approved reports.",
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "ASSESSMENTS AWAITING REVIEW"), el("h3", {}, `${items.length} in queue`))), content)));
};
routes.registrations = async () => {
  const { items } = await api("/v1/admin/registrations");
  const act = (r, d) => safe(async () => { const x = await api(`/v1/admin/registrations/${r.registration_id}/decision`, { method: "POST", body: { decision: d, reason: "Portal decision" } }); toast(x.invitation_token ? `Approved. Local development invitation token: ${x.invitation_token}` : `Registration ${x.status}`); render(); });
  const rows = items.map((r) => el("tr", {},
    el("td", {}, r.organisation_name), el("td", {}, r.work_email),
    el("td", {}, el("span", { class: `tag ${r.engagement_verified ? "ok" : "medium"}` }, r.engagement_verified ? "Verified" : "Not verified")),
    el("td", {}, r.status), el("td", {}, r.status === "pending_approval"
      ? el("div", { class: "row" }, el("button", { disabled: !r.engagement_verified, onclick: act(r, "approve") }, "Approve"), el("button", { class: "secondary", onclick: act(r, "reject") }, "Reject")) : "—")));
  const content = items.length
    ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" },
      el("thead", {}, el("tr", {}, ["Organisation", "Email", "Engagement", "Status", "Decision"].map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows)))
    : el("p", { class: "empty-state" }, "No workspace access requests.");
  main.replaceChildren(moduleFrame("CLOUDSEALS · CUSTOMER ONBOARDING", "Registrations", "Verify each organisation request and engagement before granting workspace access.",
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "ACCESS REQUESTS"), el("h3", {}, `${items.length} total`))), content)));
};
routes.activity = async () => {
  const q = { text: "", action: "", actor: "", from: "", to: "", offset: 0, limit: 50 };
  const out = el("div", {}), cats = el("div", { class: "case-filters", role: "group", "aria-label": "Filter by category" });
  const params = (extra = {}) => {
    const u = new URLSearchParams();
    if (q.text) u.set("q", q.text); if (q.action) u.set("action", q.action); if (q.actor) u.set("actor", q.actor);
    if (q.from) u.set("since", String(new Date(`${q.from}T00:00:00`).getTime() / 1000)); if (q.to) u.set("until", String(new Date(`${q.to}T23:59:59`).getTime() / 1000));
    for (const [k, v] of Object.entries(extra)) u.set(k, String(v)); return u.toString();
  };
  const load = safe(async () => {
    const r = await api(`/v1/admin/activity?${params({ limit: q.limit, offset: q.offset })}`);
    cats.replaceChildren(el("button", { class: `chip${q.action ? "" : " on"}`, onclick: () => { q.action = ""; q.offset = 0; load(); } }, "All", el("em", {}, String(Object.values(r.categories).reduce((a, b) => a + b, 0)))),
      ...Object.entries(r.categories).map(([c, n]) => el("button", { class: `chip${q.action === `${c}.` ? " on" : ""}`, onclick: () => { q.action = `${c}.`; q.offset = 0; load(); } }, c, el("em", {}, String(n)))));
    const from = r.total ? r.offset + 1 : 0, to = Math.min(r.offset + r.limit, r.total);
    out.replaceChildren(r.items.length ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" },
      el("thead", {}, el("tr", {}, ["When", "Who", "Action", "Reference"].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, r.items.map((a) => el("tr", {}, el("td", {}, new Date(a.at * 1000).toLocaleString()), el("td", {}, a.email || a.sub, a.email ? el("br") : "", a.email ? el("small", { class: "help" }, a.sub) : ""),
        el("td", {}, el("span", { class: "audit-action" }, a.action)), el("td", {}, String(a.ref).slice(0, 80))))))) : el("p", { class: "empty-state" }, "No events match these filters."),
      el("div", { class: "row audit-pager" }, el("span", { class: "help" }, `Showing ${from} to ${to} of ${r.total}`),
        el("button", { class: "secondary", disabled: q.offset === 0, onclick: () => { q.offset = Math.max(0, q.offset - q.limit); load(); } }, "← Newer"),
        el("button", { class: "secondary", disabled: to >= r.total, onclick: () => { q.offset += q.limit; load(); } }, "Older →")));
  });
  const field = (name, type, ph, key) => el("input", { type, placeholder: ph, "aria-label": ph, value: q[key], onchange: (e) => { q[key] = e.target.value.trim(); q.offset = 0; load(); } });
  main.replaceChildren(moduleFrame("CLOUDSEALS · AUDIT", "Audit logs", "Every administrative, review and agent event this environment has recorded. Filter, page through it, or export it.",
    el("section", { class: "module-panel" }, el("div", { class: "row case-tools" }, field("q", "search", "Search action, reference or person", "text"), field("actor", "text", "Person", "actor"),
      el("label", { class: "uc-picker" }, "From", field("from", "date", "From date", "from")), el("label", { class: "uc-picker" }, "To", field("to", "date", "To date", "to")),
      el("button", { class: "secondary", onclick: safe(async (e) => { e.currentTarget.disabled = true; await dl(`/v1/admin/activity/export?${params()}`, "activity-log.csv"); e.currentTarget.disabled = false; }) }, "Export CSV")),
      cats, out)));
  load();
};

routes["service-health"] = async () => {
  const draw = async (probe) => {
    const h = await api(`/v1/admin/health${probe ? "?probe=true" : ""}`);
    const dot = (s) => el("span", { class: `hdot ${s}`, "aria-hidden": "true" });
    const probeLine = (p) => p ? el("p", { class: p.ok ? "help" : "module-note" }, p.ok ? `Live check passed in ${p.ms} ms` : `Live check failed after ${p.ms} ms: ${p.error}`) : "";
    const card = (title, status, lines, extra = "") => el("article", { class: "module-panel health-card" }, el("div", { class: "health-head" }, dot(status), el("h3", {}, title)),
      el("dl", { class: "health-list" }, lines.filter(Boolean).map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, String(v))))), extra);
    const upt = (s) => s > 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`;
    const calls = Object.entries(h.agents.calls_last_24h);
    main.replaceChildren(moduleFrame("CLOUDSEALS · OPERATIONS", "Service health", "What this environment is running on and whether each part is working. Live checks make small real calls to the model and the signing key.",
      el("p", {}, el("button", { onclick: safe(async (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = "Checking…"; await draw(true); }) }, "Run live checks"), " ", el("button", { class: "secondary", onclick: () => draw(false) }, "Refresh")),
      el("section", { class: "module-card-grid health-grid" },
        card("Service", "ok", [["Revision", h.service.revision || "local"], ["Environment", h.service.environment], ["Sign-in", h.service.auth], ["Uptime", upt(h.service.uptime_seconds)]]),
        card("Application state", h.state.last_save_error ? "bad" : h.state.durable ? "ok" : "warn", [["Storage", h.state.backend], ["Durable", h.state.durable ? "Yes" : "No (lost on restart)"],
          ["Saves since start", h.state.saves], ["Last save", h.state.last_save_at ? new Date(h.state.last_save_at * 1000).toLocaleTimeString() : "none yet"], h.state.last_save_error ? ["Last error", h.state.last_save_error] : null]),
        card("Evidence storage", h.evidence_store.backend === "local-disk" ? "warn" : "ok", [["Backend", h.evidence_store.backend]]),
        card("Malware scanning", h.malware_scanner.probe ? (h.malware_scanner.probe.ok ? "ok" : "bad") : h.malware_scanner.configured ? "ok" : "warn",
          [["Engine", h.malware_scanner.engine || "Basic byte checks only (no scanner configured)"], ["Uploads", h.malware_scanner.configured ? "Scanned before use; rejected if the scanner is down" : "Checked for known signatures only"]], probeLine(h.malware_scanner.probe)),
        card("AI model", h.model.probe ? (h.model.probe.ok ? "ok" : "bad") : h.model.configured ? "ok" : "off", [["Provider", h.model.provider || "none (deterministic agents only)"], ["Model", h.model.model_id || "n/a"]], probeLine(h.model.probe)),
        card("Evidence signing", h.evidence_signing.probe ? (h.evidence_signing.probe.ok ? "ok" : "bad") : h.evidence_signing.configured ? "ok" : "off",
          [["Signer", h.evidence_signing.configured ? "Cloud KMS" : "Local hash chain only"], ["Key version", h.evidence_signing.key_version ? h.evidence_signing.key_version.split("/").slice(-5).join("/") : "n/a"]], probeLine(h.evidence_signing.probe)),
        card("Workflow runtime", h.runtime.mode === "sandbox" ? "warn" : "off", [["Mode", h.runtime.mode === "sandbox" ? "Sandbox (mock connector)" : "Unavailable in this environment"]]),
        card("Agents, last 24 hours", calls.length ? "ok" : "off", [["Advisory agents registered", h.agents.advisory_agents], ...calls.map(([k, v]) => [k.replace("agent.", "").replaceAll("_", " "), v])]),
        card("Records", "ok", [["Users", h.counts.users], ["Assessments", h.counts.assessments], ["Cases", h.counts.cases], ["Audit events", h.counts.audit_events]]))));
  };
  await draw(false);
};


// ---------- Agent Flow: watch the agents run, step by step ----------
const FLOW_NODES = {
  payment: [["ledgersight.intake", "Intake", "Checks the payment data and fingerprints it"],
    ["ledgersight.match", "Match", "Finds candidate invoices for the payment"],
    ["ledgersight.reconciliation", "Reconciliation", "Explains amount and reference differences"],
    ["ledgersight.cash_allocation", "Cash Allocation", "Recommends a bounded allocation proposal"],
    ["ledgersight.exception", "Exception", "Sends unresolved cases to a human"],
    ["ledgersight.audit", "Audit", "Creates the evidence record"],
    ["trustops.approval_summarizer", "Approval Summary", "Summarises the decision for the approver"]],
  diagnosis: [["cloudseals.swaska.diagnostic_interviewer", "Interviewer", "Asks one clarifying question about an assessment question"],
    ["cloudseals.swaska.evidence_extractor", "Evidence Extractor", "Suggests candidate answers from uploaded evidence"],
    ["trustops.inventory_agent", "Inventory Agent", "Reads documents and lists the AI use cases they evidence"],
    ["cloudseals.swaska.findings_summarizer", "Findings Summary", "Summarises candidate findings for reviewers"],
    ["trustops.gap_analysis_agent", "Gap Analysis", "Compares validated use cases with a framework"],
    ["trustops.maturity_scorer", "Maturity Scorer", "Scores governance maturity on five principles"],
    ["trustops.roadmap_agent", "Roadmap Agent", "Turns validated gaps into a prioritised plan"],
    ["trustops.architecture_overlay", "Architecture Overlay", "Draws the evidenced and the target architecture"],
    ["cloudseals.swaska.poc_drafter", "POC Drafter", "Drafts scope notes for the POC blueprint"]],
};
const FLOW_STATE = { waiting: "Waiting", running: "Running…", done: "Done", skipped: "Skipped", failed: "Failed" };
const PRESETS = { low: "Low value, exact match", high: "High value (needs approval)", ambiguous: "Ambiguous (two matches)", nomatch: "No matching invoice" };
function paymentBody(preset) {
  const id = String(Date.now()).slice(-8), ref = `INV-${id}`, inv = (n, amount, reference) => ({ invoice_id: `I-${id}-${n}`, amount_minor: amount, currency: "USD", reference });
  const amount = preset === "high" ? 999999999 : 25000;
  const invoices = preset === "ambiguous" ? [inv(1, amount, ref), inv(2, amount, ref)] : preset === "nomatch" ? [inv(1, amount + 100, `OTHER-${id}`)] : [inv(1, amount, ref)];
  return { receipt: { receipt_id: `R-${id}`, amount_minor: amount, currency: "USD", reference: ref }, invoices, remittance: { reference: ref } };
}
function describeStep(step) {
  const rec = step.recommendation || {}, lines = [];
  if (step.candidate_ids) lines.push(`Candidate invoices: ${step.candidate_ids.length ? step.candidate_ids.join(", ") : "none"}`);
  if (step.classification) lines.push(`Result: ${step.classification.replaceAll("_", " ")}`);
  if (step.proposal) lines.push(`Proposal: allocate ${step.proposal.amount_minor / 100} ${step.proposal.currency} to invoice ${step.proposal.invoice_id}`);
  if (step.exception) lines.push(`Sent to ${step.exception.queue.replaceAll("_", " ")}: ${step.exception.reason_code.replaceAll("_", " ").toLowerCase()}`);
  if (step.input_digest) lines.push(`Input fingerprint: ${step.input_digest.slice(0, 16)}…`);
  for (const t of [rec.rationale, rec.explanation, rec.summary]) if (t) lines.push(t);
  return lines.length ? lines : [`Status: ${step.status.replaceAll("_", " ")}`];
}

// CSP forbids inline style attributes; setting the width through the CSSOM is allowed.
function progressFill(pct) { const f = el("div", { class: "af-progress-bar", role: "presentation" }); f.style.width = `${pct}%`; return f; }


routes["agent-flow"] = async () => {
  const roles = state.me.roles;
  const [{ items: assessments }, overview] = await Promise.all([api("/v1/assessments"), api("/v1/agentops")]);
  const runtimeUp = overview.mode === "sandbox";
  let flow = runtimeUp ? "payment" : "diagnosis", preset = "low", running = false, assessmentId = assessments[0]?.assessment_id || "", nodes = [], summary = null, current = -1;
  const reset = () => { nodes = FLOW_NODES[flow].map(([id, name, does]) => ({ id, name, does, state: "waiting", lines: [], ms: null, caption: "" })); summary = null; current = -1; };
  reset();
  const note = el("p", { class: "module-note" });
  const stage = el("div", { class: "af-stage", "aria-hidden": "true" }), bubble = el("div", { class: "af-bubble", "aria-live": "polite" });
  const list = el("ol", { class: "af-list" }), banner = el("div", { class: "af-banner" }), controls = el("div", { class: "af-controls" });
  const office = createAgentOffice(el, { onRun: () => runBtn.click() });
  const officeToggle = el("button", { type: "button", class: "secondary", "aria-expanded": "true", onclick: (e) => {
    office.element.hidden = !office.element.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!office.element.hidden));
    e.currentTarget.textContent = office.element.hidden ? "Show office view" : "Hide office view";
  } }, "Hide office view");
  const initials = (n) => n.name.split(" ").map((w) => w[0]).join("").slice(0, 2);
  const draw = () => {
    office.update({ nodes, flow, current, running });
    const done = nodes.filter((n) => ["done", "skipped", "failed"].includes(n.state)).length;
    note.textContent = flow === "payment"
      ? "Each step below is driven by an execution event from the workflow service. Select a desk to inspect the returned result. External ERP posting is not enabled in this workspace."
      : "Each agent is a separate real call. Agents you cannot use, or that have nothing to work on yet, are marked Skipped with the reason. Output is advisory and never saved as an answer.";
    banner.replaceChildren(el("div", { class: "af-progress" }, progressFill(Math.round(done / nodes.length * 100))),
      el("span", {}, running ? `Running… ${done} of ${nodes.length} agents finished` : done ? `${done} of ${nodes.length} agents finished` : "Choose a flow and press Run"), summary || "");
    const parts = [];
    nodes.forEach((n, i) => {
      parts.push(el("div", { class: `af-agent is-${n.state}` }, el("div", { class: "af-orb" }, el("span", {}, n.state === "done" ? "✓" : n.state === "failed" ? "!" : n.state === "skipped" ? "–" : initials(n))), el("small", {}, n.name)));
      if (i < nodes.length - 1) parts.push(el("div", { class: `af-link ${nodes[i + 1].state !== "waiting" ? "is-done" : n.state === "done" ? "is-travel" : ""}` }, el("i", {})));
    });
    stage.replaceChildren(...parts);
    const cur = nodes[current];
    bubble.replaceChildren(cur && cur.state === "running" ? el("div", { class: "af-thinking" }, el("span", { class: "af-dots" }, el("i", {}), el("i", {}), el("i", {})), el("strong", {}, `${cur.name} `), cur.caption)
      : cur && cur.lines.length ? el("div", { class: "af-said" }, el("strong", {}, `${cur.name}: `), cur.lines[0]) : el("span", { class: "help" }, running ? "" : "The active agent will show what it is doing here."));
    list.replaceChildren(...nodes.map((n, i) => el("li", { class: `af-node is-${n.state}` },
      el("span", { class: "af-dot", "aria-hidden": "true" }, n.state === "done" ? "✓" : n.state === "failed" ? "!" : n.state === "skipped" ? "–" : String(i + 1)),
      el("div", { class: "af-card" }, el("div", { class: "af-card-head" }, el("strong", {}, n.name), el("span", { class: `af-chip ${n.state}` }, n.state === "running" ? el("span", { class: "spin", "aria-hidden": "true" }) : "", FLOW_STATE[n.state]),
        n.ms != null ? el("small", {}, `${n.ms} ms`) : ""), el("p", {}, n.does),
        n.lines.length ? el("ul", { class: "af-out" }, n.lines.map((l) => el("li", {}, l))) : ""))));
  };
  const set = (i, patch) => { Object.assign(nodes[i], patch); draw(); };
  const skip = (i, why) => { current = i; set(i, { state: "skipped", lines: [why] }); };
  // Status follows the pending request, with no artificial work timers.
  async function act(i, task) {
    current = i;
    set(i, { state: "running", lines: [], caption: "Request in progress…" });
    const t = performance.now();
    try { const res = await task(); set(i, { ms: Math.round(performance.now() - t), ...res }); }
    catch (e) { set(i, { state: e.status === 403 ? "skipped" : "failed", lines: [e.status === 403 ? "Your role does not have access to this agent." : e.message] }); }
  }

  async function runPayment() {
    const response = await api("/v1/workflows/ledgersight.ar_cash/runs/stream", { method: "POST", idem: true, raw: true, body: paymentBody(preset) });
    if (!response.ok) throw new Error((await response.json()).message || "Workflow could not be started");
    const reader = response.body.getReader(), decoder = new TextDecoder(), starts = new Map();
    let buffer = "", run = null;
    const receive = event => {
      if (event.event === "run.failed") throw new Error(event.error?.message || "Workflow did not complete");
      if (event.event === "run.completed") { run = event.run; return; }
      const i = nodes.findIndex(n => n.id === event.agent_id);
      if (i < 0) return;
      current = i;
      if (event.event === "agent.started") {
        starts.set(i, event.at);
        set(i, { state: "running", lines: [], caption: "Executing workflow step…" });
      } else if (event.event === "agent.completed") {
        set(i, { state: "done", lines: describeStep(event.step), ms: Math.max(0, Math.round((event.at - (starts.get(i) ?? event.at)) * 1000)) });
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        let split;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const packet = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const json = packet.split("\n").find(line => line.startsWith("data: "));
          if (json) receive(JSON.parse(json.slice(6)));
        }
        if (done) break;
      }
      if (!run) throw new Error("Workflow connection ended before the result was received");
      // A replay of an idempotent request may contain only its final saved result.
      run.agent_trace.forEach((step, i) => set(i, { state: "done", lines: describeStep(step) }));
      await act(6, async () => {
        const result = await api(`/v1/runs/${run.run_id}/approval-summary`);
        return { state: "done", lines: [result.summary, result.decision_reason] };
      });
      const pd = run.policy_decision;
      summary = el("div", { class: "af-result" }, el("strong", {}, `Policy decision: ${pd.decision}`), ` · ${pd.reason_code.replaceAll("_", " ").toLowerCase()} · `,
        el("a", { href: `#/trustops/${run.run_id}` }, "Open full run →"));
    } catch (error) {
      const failed = nodes.findIndex(n => n.state === "running");
      set(failed >= 0 ? failed : 0, { state: "failed", lines: [error.message] });
      nodes.forEach((n, i) => { if (n.state === "waiting") skip(i, "Not executed because the workflow stopped."); });
      throw error;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async function runDiagnosis() {
    if (!assessmentId) { nodes.forEach((_, i) => skip(i, "No assessment is available in this workspace yet.")); return; }
    const staffReview = roles.some((r) => ["cloudseals_admin", "cloudseals_assessor", "cloudseals_reviewer"].includes(r));
    await act(0, async () => {
      const r = await api(`/v1/assessments/${assessmentId}/swaska/turns`, { method: "POST", body: { scope_id: "org", user_message: "What evidence would help here?", parent_question_id: "Q-BASE-006" } });
      return { state: "done", lines: [r.clarification_text, r.needs_evidence ? `Suggested evidence: ${r.evidence_type}` : "No evidence needed", r.uncertainty] };
    });
    const files = (await api(`/v1/assessments/${assessmentId}/evidence`)).items.filter((e) => e.state === "clean");
    const evid = files.find((e) => ["text/plain", "text/csv", "application/json"].includes(e.content_type));
    if (!evid) skip(1, "No clean text, CSV or JSON evidence uploaded yet.");
    else await act(1, async () => {
      const r = await api(`/v1/assessments/${assessmentId}/agents/extraction`, { method: "POST", body: { evidence_id: evid.evidence_id } });
      return { state: "done", lines: r.items.length ? r.items.map((c) => `${c.question_id}: ${c.candidate_value} (unverified)`) : [`No candidate answers found in ${evid.filename}`] };
    });
    const readable = files.filter((e) => ["application/pdf", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(e.content_type));
    if (!readable.length) skip(2, "No clean PDF, Word or text document uploaded yet.");
    else await act(2, async () => {
      const r = await api(`/v1/assessments/${assessmentId}/inventory/run`, { method: "POST", body: {} });
      if (r.mode === "unavailable") return { state: "skipped", lines: [r.note] };
      return { state: "done", lines: r.items.length ? r.items.map((u) => `${u.name} · ${TIER_LABEL[u.risk_tier]} · ${Math.round(u.extraction_confidence * 100)}% confidence (needs review)`) : ["No AI use cases were evidenced in the documents."] };
    });
    if (!staffReview) skip(3, "Needs a CloudSeals reviewer. Customers do not see findings before review.");
    else await act(3, async () => {
      const r = await api(`/v1/assessments/${assessmentId}/agents/findings-summary`, { method: "POST" });
      return r.items.length ? { state: "done", lines: r.items.map((f) => f.summary) } : { state: "skipped", lines: ["No findings yet. The customer must submit the assessment first."] };
    });
    if (!staffReview) skip(4, "Needs a CloudSeals reviewer to validate use cases and run the analysis.");
    else {
      const validated = (await api(`/v1/assessments/${assessmentId}/inventory`)).use_cases.filter((u) => u.status === "VALIDATED");
      if (!validated.length) skip(4, "No validated use cases yet. A reviewer validates them on the AI use cases page first.");
      else await act(4, async () => {
        const r = await api(`/v1/assessments/${assessmentId}/gap-analysis/run`, { method: "POST", body: { framework_id: "eu_ai_act" } });
        if (r.mode === "unavailable") return { state: "skipped", lines: [r.note] };
        return { state: "done", lines: r.items.length ? r.items.slice(0, 5).map((g) => `${g.severity.toUpperCase()} · ${g.framework_clause.replaceAll("_", " ")}: ${g.title}`) : ["No gaps were raised against the EU AI Act."] };
      });
    }
    const inv = staffReview ? await api(`/v1/assessments/${assessmentId}/inventory`) : null;
    if (!staffReview) skip(5, "Needs a CloudSeals reviewer to validate use cases first.");
    else if (!inv.use_cases.some((u) => u.status === "VALIDATED")) skip(5, "No validated use cases yet.");
    else await act(5, async () => {
      const r = await api(`/v1/assessments/${assessmentId}/maturity/run`, { method: "POST" });
      if (r.mode === "unavailable") return { state: "skipped", lines: [r.note] };
      return r.maturity ? { state: "done", lines: [`Overall ${r.maturity.overall_score} / 5 (needs review)`, ...Object.entries(r.maturity.scores).map(([p, sc]) => `${PRINCIPLE_LABEL[p]}: ${sc}`)] } : { state: "skipped", lines: [r.note] };
    });
    if (!staffReview) skip(6, "Needs a CloudSeals reviewer to validate gaps first.");
    else if (!inv.gaps.some((g) => g.status === "VALIDATED") && inv.maturity?.status !== "VALIDATED") skip(6, "Validate a gap or the maturity score first.");
    else await act(6, async () => {
      const r = await api(`/v1/assessments/${assessmentId}/roadmap/run`, { method: "POST" });
      if (r.mode === "unavailable") return { state: "skipped", lines: [r.note] };
      return { state: "done", lines: r.items.length ? [`${r.summary.total_items} items, about ${r.summary.total_effort_days} person-days`, ...r.items.slice(0, 4).map((i) => `${i.timeline_band} days: ${i.title}`)] : ["No usable roadmap items were returned."] };
    });
    if (!staffReview) skip(7, "Needs a CloudSeals reviewer to validate use cases first.");
    else if (!inv.use_cases.some((u) => u.status === "VALIDATED")) skip(7, "No validated use cases yet.");
    else await act(7, async () => {
      const r = await api(`/v1/assessments/${assessmentId}/overlay/run`, { method: "POST" });
      if (r.mode === "unavailable") return { state: "skipped", lines: [r.note] };
      return r.overlay ? { state: "done", lines: [`${r.overlay.current.nodes.length} nodes today, ${r.overlay.target.nodes.length} in the target (needs review)`, ...r.overlay.key_differences.slice(0, 3)] } : { state: "skipped", lines: [r.note] };
    });
    if (!roles.some((r) => ["cloudseals_admin", "cloudseals_assessor"].includes(r))) skip(8, "Needs a CloudSeals assessor, after a reviewer has approved the report.");
    else {
      const bp = (await api(`/v1/assessments/${assessmentId}/poc-blueprints`)).items[0];
      if (!bp) skip(8, "No draft POC blueprint yet. An assessor creates one from the approved report.");
      else await act(8, async () => {
        const r = await api(`/v1/assessments/${assessmentId}/poc-blueprints/${bp.blueprint_id}/draft-notes`, { method: "POST" });
        return { state: "done", lines: [r.scope_summary, ...r.open_questions.map((q) => `Open question: ${q}`)] };
      });
    }
  }

  const runBtn = el("button", { onclick: safe(async () => {
    if (running) return; running = true; reset(); drawControls(); draw();
    try { await (flow === "payment" ? runPayment() : runDiagnosis()); } finally { running = false; drawControls(); draw(); }
  }) }, "▶ Run agents");
  function drawControls() {
    runBtn.disabled = running;
    const tab = (id, label) => el("button", { class: flow === id ? "" : "secondary", disabled: running || (id === "payment" && !runtimeUp), title: id === "payment" && !runtimeUp ? "The governed workflow runtime is not enabled in this environment" : null, onclick: () => { flow = id; reset(); drawControls(); draw(); } }, label);
    const picker = flow === "payment"
      ? el("label", {}, "Scenario", el("select", { disabled: running, onchange: (e) => { preset = e.target.value; } }, Object.entries(PRESETS).map(([v, l]) => el("option", { value: v, selected: v === preset }, l))))
      : el("label", {}, "Assessment", el("select", { disabled: running, onchange: (e) => { assessmentId = e.target.value; } },
        assessments.length ? assessments.map((a) => el("option", { value: a.assessment_id, selected: a.assessment_id === assessmentId }, `${a.ai_system_name} (${a.status})`)) : el("option", { value: "" }, "No assessments")));
    const demo = flow === "diagnosis" && !assessments.length && state.cfg.mode === "dev" ? el("button", { class: "secondary", disabled: running, onclick: safe(async () => {
      const a = await api("/v1/assessments", { method: "POST", idem: true, body: { ai_system_name: "Demo credit agent", industry: "banking", questionnaire_version: "1.0.0" } });
      const data = new TextEncoder().encode("Q-BASE-006: Yes\nQ-IAM-002: Yes\n");
      const g = await api(`/v1/assessments/${a.assessment_id}/evidence/upload-url`, { method: "POST", body: { filename: "architecture-notes.txt", content_type: "text/plain", file_size_bytes: data.byteLength, claimed_sha256: await sha256Hex(data.buffer) } });
      await api(g.upload_url, { method: "PUT", body: data.buffer, headers: { "Content-Type": "application/octet-stream" } });
      toast("Demo assessment created"); await routes["agent-flow"]();
    }) }, "Create a demo assessment with sample evidence") : "";
    controls.replaceChildren(el("div", { class: "row" }, tab("payment", "Payment workflow (7 agents)"), tab("diagnosis", "Diagnosis agents (9 agents)")), el("div", { class: "row af-picker" }, picker, demo, runBtn));
  }
  drawControls(); draw();
  main.replaceChildren(moduleFrame("AGENTS · OFFICE VIEW", "AI Agents Office", "Meet your specialist team. Select a desk to inspect its task, status and returned output. Use Run agents to start the selected workflow.",

    el("section", { class: "module-panel af-panel" }, controls, banner, officeToggle, office.element,
      el("details", { class: "office-trace", open: true }, el("summary", {}, "Step-by-step activity"), el("div", { class: "af-sticky" }, stage, bubble), list),
      note)));
};


// ---------- AI use cases: document inventory and framework gap analysis ----------
const REVIEW_ROLES = ["cloudseals_admin", "cloudseals_assessor", "cloudseals_reviewer"];
const TIER_LABEL = { prohibited: "Prohibited practice", high_risk: "High risk", limited_risk: "Limited risk", minimal_risk: "Minimal risk" };
const TIER_CLASS = { prohibited: "high", high_risk: "high", limited_risk: "medium", minimal_risk: "ok" };
const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const STATUS_LABEL = { UNREVIEWED: "Needs review", VALIDATED: "Validated", REJECTED: "Rejected" };
let useCaseNote = "";

function statusChip(status) { return el("span", { class: `uc-status uc-${String(status).toLowerCase()}` }, STATUS_LABEL[status] || status); }
function reviewControls(label, onDecide) {
  const reason = el("input", { placeholder: "Reviewer reason (required)", maxlength: 2000, "aria-label": `${label}: reviewer reason` });
  const go_ = (status) => safe(async () => { if (!reason.value.trim()) return toast("Enter a reviewer reason first", true); await onDecide(status, reason.value.trim()); });
  return el("div", { class: "uc-review" }, reason, el("button", { onclick: go_("validated") }, "Validate"), el("button", { class: "secondary", onclick: go_("rejected") }, "Reject"));
}

function useCaseCard(aid, u, canReview, redraw) {
  const meta = [["Business owner", u.business_owner], ["Technical owner", u.technical_owner], ["Model type", u.model_type],
    ["Decision authority", u.decision_authority?.replaceAll("_", " ")], ["Foundation models", u.foundation_models_used?.join(", ")], ["Data sources", u.data_sources?.join(", ")]]
    .filter(([, v]) => v);
  return el("article", { class: `uc-card uc-card-${String(u.status).toLowerCase()}` },
    el("div", { class: "uc-head" }, el("h4", {}, u.name), el("span", { class: `tag ${TIER_CLASS[u.risk_tier] || ""}` }, TIER_LABEL[u.risk_tier] || u.risk_tier),
      statusChip(u.status), el("span", { class: "uc-conf", title: "How sure the agent is that this use case exists in the document" }, `${Math.round(u.extraction_confidence * 100)}% confidence`)),
    el("p", { class: "uc-desc" }, u.description),
    u.needs_validation && u.status === "UNREVIEWED" ? el("p", { class: "module-note" }, "Low confidence: check this against the source document before relying on it.") : "",
    u.injection_flagged ? el("p", { class: "module-note" }, "The source document contained instruction-like text. It was treated as data only.") : "",
    meta.length ? el("dl", { class: "uc-meta" }, meta.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))) : "",
    el("p", { class: "uc-why" }, el("strong", {}, "Why this risk tier (candidate, not a legal conclusion): "), u.risk_tier_rationale),
    el("div", { class: "uc-quotes" }, el("span", { class: "eyebrow" }, `EVIDENCE FROM ${u.source_filename}`), u.source_quotes.map((q) => el("blockquote", {}, q))),
    u.status !== "UNREVIEWED" ? el("p", { class: "help" }, canReview ? `${STATUS_LABEL[u.status]} by ${u.reviewed_by}: ${u.review_reason}` : `${STATUS_LABEL[u.status]} by CloudSeals`)
      : canReview ? reviewControls(u.name, async (status, reason) => { await api(`/v1/assessments/${aid}/inventory/use-cases/${u.use_case_id}`, { method: "PATCH", body: { status, reason } }); toast(`Use case ${status}`); redraw(); })
        : el("p", { class: "help" }, "Waiting for a CloudSeals reviewer to validate this use case."));
}

function gapCard(aid, g, canReview, redraw) {
  return el("article", { class: `uc-card uc-gap uc-sev-${g.severity}` },
    el("div", { class: "uc-head" }, el("h4", {}, g.title), el("span", { class: `tag sev-${g.severity}` }, g.severity.toUpperCase()), statusChip(g.status),
      el("span", { class: "uc-conf" }, `${g.framework_id.replaceAll("_", " ").toUpperCase()} · ${g.framework_clause.replaceAll("_", " ")}`)),
    el("p", { class: "uc-desc" }, g.description),
    el("p", { class: "uc-why" }, el("strong", {}, "Suggested action: "), g.recommendation, ` (about ${g.estimated_effort_days} person-days, ${g.suggested_timeline} days)`),
    g.evidence_quotes.length ? el("div", { class: "uc-quotes" }, el("span", { class: "eyebrow" }, "EVIDENCE"), g.evidence_quotes.map((q) => el("blockquote", {}, q))) : "",
    g.status !== "UNREVIEWED" ? el("p", { class: "help" }, canReview ? `${STATUS_LABEL[g.status]} by ${g.reviewed_by}: ${g.review_reason}` : `${STATUS_LABEL[g.status]} by CloudSeals`)
      : canReview ? reviewControls(g.title, async (status, reason) => { await api(`/v1/assessments/${aid}/gaps/${g.gap_id}`, { method: "PATCH", body: { status, reason } }); toast(`Gap ${status}`); redraw(); }) : "");
}


const PRINCIPLE_LABEL = { model_agnostic: "P1 Model Agnostic", neuro_symbolic: "P2 Neuro-Symbolic", digital_twin: "P3 Digital Twin", evidence_fabric: "P4 Evidence Fabric", model_welfare: "P5 Model Welfare" };
const BAND_LABEL = { "0-90": "0 to 90 days", "90-180": "90 to 180 days", "180-365": "180 to 365 days", "365+": "Beyond 365 days" };
function scoreBar(score) { const f = el("b", { role: "presentation" }); f.style.width = `${Math.round(score * 20)}%`; return el("i", { class: "mat-track" }, f); }

function maturityPanel(aid, inv, canReview, validatedUc, redraw) {
  const m = inv.maturity;
  const run = el("button", { disabled: !validatedUc, title: validatedUc ? "" : "Validate at least one use case first", onclick: safe(async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = "Scoring…";
    const r = await api(`/v1/assessments/${aid}/maturity/run`, { method: "POST" });
    useCaseNote = r.mode === "unavailable" ? r.note : r.maturity ? "Maturity score drafted for review." : r.note;
    await redraw();
  }) }, m ? "Re-run maturity scoring" : "Run maturity scoring");
  const body = m ? el("div", {},
    el("div", { class: "mat-head" }, el("strong", { class: "mat-overall" }, `${m.overall_score}`), el("span", {}, " / 5 overall"), statusChip(m.status)),
    Object.keys(PRINCIPLE_LABEL).map((p) => el("div", { class: "mat-row" }, el("div", { class: "mat-line" }, el("span", {}, PRINCIPLE_LABEL[p]), scoreBar(m.scores[p]), el("em", {}, String(m.scores[p]))),
      el("p", { class: "uc-why" }, m.rationale[p], m.evidence_refs[p]?.length ? ` (${m.evidence_refs[p].length} cited item${m.evidence_refs[p].length === 1 ? "" : "s"})` : ""))),
    m.capped_for_missing_evidence?.length ? el("p", { class: "module-note" }, `Scores for ${m.capped_for_missing_evidence.join(", ")} were capped at 2.0 because no evidence was cited for a score of 3 or more.`) : "",
    m.improvement_priorities?.length ? el("div", {}, el("span", { class: "eyebrow" }, "IMPROVEMENT PRIORITIES"), el("ul", { class: "fw-controls" }, m.improvement_priorities.map((x) => el("li", {}, x)))) : "",
    m.notes_for_architect ? el("p", { class: "help" }, `Notes for the architect: ${m.notes_for_architect}`) : "",
    m.status !== "UNREVIEWED" ? el("p", { class: "help" }, `${STATUS_LABEL[m.status]} by ${m.reviewed_by}: ${m.review_reason}`)
      : canReview ? reviewControls("Maturity", async (status, reason) => { await api(`/v1/assessments/${aid}/maturity`, { method: "PATCH", body: { status, reason } }); toast(`Maturity ${status}`); redraw(); }) : "")
    : el("p", { class: "empty-state" }, validatedUc ? "No maturity score yet." : "Validate a use case to unlock maturity scoring.");
  return el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "STEP 3 · MATURITY SCORER"), el("h3", {}, "Governance maturity"))),
    el("p", { class: "help" }, "Five principles scored 1 to 5. A score of 3 or more needs cited evidence; otherwise it is capped at 2. The overall score is calculated here, not by the model."), el("div", { class: "row" }, run), body);
}

function roadmapPanel(aid, inv, canReview, ready, redraw) {
  const items = inv.roadmap || [];
  const run = el("button", { disabled: !ready, title: ready ? "" : "Validate a gap or the maturity score first", onclick: safe(async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = "Building roadmap…";
    const r = await api(`/v1/assessments/${aid}/roadmap/run`, { method: "POST" });
    useCaseNote = r.mode === "unavailable" ? r.note : `${r.items.length} roadmap item(s) drafted${r.rejected ? `; ${r.rejected} unusable item(s) were dropped` : ""}${r.uncovered_gaps?.length ? `; ${r.uncovered_gaps.length} critical or high gap(s) are not covered yet` : ""}.`;
    await redraw();
  }) }, items.length ? "Re-run roadmap" : "Build roadmap");
  const card = (i) => el("article", { class: `uc-card uc-card-${String(i.status).toLowerCase()}` },
    el("div", { class: "uc-head" }, el("h4", {}, i.title), el("span", { class: "tag" }, i.responsible_role), el("span", { class: "tag" }, `${i.effort_days} person-days`), el("span", { class: "tag" }, `cost: ${i.estimated_cost_band}`), statusChip(i.status)),
    el("p", { class: "uc-desc" }, i.description),
    i.timeline_adjusted ? el("p", { class: "module-note" }, "Moved into the first 90 days because it addresses a critical gap.") : "",
    el("ul", { class: "fw-controls" }, i.success_criteria.map((c) => el("li", {}, c))),
    i.dependencies.length ? el("p", { class: "help" }, `Depends on ${i.dependencies.length} other item${i.dependencies.length === 1 ? "" : "s"} in this roadmap.`) : "",
    i.status !== "UNREVIEWED" ? el("p", { class: "help" }, `${STATUS_LABEL[i.status]} by ${i.reviewed_by}: ${i.review_reason}`)
      : canReview ? reviewControls(i.title, async (status, reason) => { await api(`/v1/assessments/${aid}/roadmap/${i.item_id}`, { method: "PATCH", body: { status, reason } }); toast(`Roadmap item ${status}`); redraw(); }) : "");
  const bands = ["0-90", "90-180", "180-365", "365+"].filter((b) => items.some((i) => i.timeline_band === b));
  return el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "STEP 4 · ROADMAP AGENT"), el("h3", {}, `${items.length} roadmap item${items.length === 1 ? "" : "s"}`))),
    el("p", { class: "help" }, "Built from validated gaps. Critical gaps always land in the first 90 days, dependencies are checked for loops, and effort totals are calculated here."),
    el("div", { class: "row" }, run), bands.length ? bands.map((b) => el("div", {}, el("h4", { class: "section-title" }, BAND_LABEL[b]), el("div", { class: "uc-list" }, items.filter((i) => i.timeline_band === b).map(card))))
      : el("p", { class: "empty-state" }, ready ? "No roadmap yet." : "Validate a gap or the maturity score to unlock the roadmap."));
}


function overlayPanel(aid, inv, canReview, validatedUc, redraw) {
  const o = inv.overlay;
  const run = el("button", { disabled: !validatedUc, title: validatedUc ? "" : "Validate at least one use case first", onclick: safe(async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = "Drawing…";
    const r = await api(`/v1/assessments/${aid}/overlay/run`, { method: "POST" });
    useCaseNote = r.mode === "unavailable" ? r.note : r.overlay ? "Architecture diagrams drafted for review." : r.note;
    await redraw();
  }) }, o ? "Redraw architecture" : "Draw architecture");
  const img = (svg, alt) => el("img", { class: "overlay-img", alt, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
  const body = o ? el("div", {}, el("div", { class: "row" }, statusChip(o.status)),
    el("div", { class: "overlay-grid" }, el("figure", {}, img(o.current_svg, "Current architecture, drawn only from what the documents evidence"), el("figcaption", {}, "Current: dashed boxes are things the documents do not evidence")),
      el("figure", {}, img(o.target_svg, "Recommended target architecture organised around the five principles"), el("figcaption", {}, "Target: organised around the five TrustOps principles"))),
    o.principles_missing_from_target.length ? el("p", { class: "module-note" }, `The target diagram does not show: ${o.principles_missing_from_target.join(", ")}.`) : "",
    o.current.nodes.some((n) => n.kind === "unknown") ? el("p", { class: "help" }, "Items marked unknown are not evidenced in the documents and are drawn dashed. Confirm them with the customer or remove them.") : "",
    o.gap_commentary.split("\n\n").map((p) => el("p", { class: "uc-desc" }, p)),
    el("span", { class: "eyebrow" }, "KEY DIFFERENCES"), el("ul", { class: "fw-controls" }, o.key_differences.map((d) => el("li", {}, d))),
    o.status !== "UNREVIEWED" ? el("p", { class: "help" }, `${STATUS_LABEL[o.status]} by ${o.reviewed_by}: ${o.review_reason}`)
      : canReview ? reviewControls("Architecture overlay", async (status, reason) => { await api(`/v1/assessments/${aid}/overlay`, { method: "PATCH", body: { status, reason } }); toast(`Architecture ${status}`); redraw(); }) : "")
    : el("p", { class: "empty-state" }, validatedUc ? "No diagram yet." : "Validate a use case to unlock the architecture overlay.");
  return el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "OPTIONAL · ARCHITECTURE OVERLAY"), el("h3", {}, "Current and target architecture"))),
    el("p", { class: "help" }, "Two diagrams drawn by the platform from a structured description. Nothing is shown as existing unless the documents evidence it. It joins the report once validated."),
    el("div", { class: "row" }, run), body);
}

async function reportPanel(aid) {
  const st = await api(`/v1/assessments/${aid}/diagnostic-report?format=json`);
  const canPublish = state.me.roles.some((r) => ["cloudseals_admin", "cloudseals_reviewer"].includes(r));
  const alreadyPublished = st.published?.source_digest === st.source_digest;
  const reason = el("input", { "aria-label": "Final report review reason", placeholder: "Final report review reason", maxlength: 2000 });
  const publish = el("button", { disabled: Boolean(st.publication_blockers.length || alreadyPublished), onclick: safe(async (e) => {
    if (!reason.value.trim()) return toast("Enter a final review reason before publishing", true);
    const button = e.currentTarget; button.disabled = true;
    try {
      await api(`/v1/assessments/${aid}/diagnostic-report/publish`, { method: "POST", idem: true, body: { reason: reason.value.trim(), source_digest: st.source_digest } });
      toast("Report and roadmap published to the customer"); await routes["use-cases"](aid);
    } finally { button.disabled = false; }
  }) }, "Publish report to customer");
  const dlBtn = (label, qs, cls = "") => el("button", { class: cls, onclick: safe(async (e) => {
    const button = e.currentTarget; button.disabled = true;
    try { await dl(`/v1/assessments/${aid}/diagnostic-report${qs}`, `diagnostic-report-${st.status}.html`); } finally { button.disabled = false; }
  }) }, label);
  return el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "STEP 5 · REPORT"), el("h3", {}, "Diagnostic report"))),
    el("p", { class: "help" }, "Contains only items a reviewer has validated. The narrative is optional and AI-drafted; everything else is assembled without a model."),
    el("p", {}, el("span", { class: `tag ${st.status === "FINAL" ? "ok" : "medium"}` }, st.status), st.missing.length ? ` Still needed: ${st.missing.join("; ")}.` : " Ready to deliver after your final check."),
    el("div", { class: "row" }, dlBtn("Download report (HTML)", ""), dlBtn("Download with AI narrative", "?narrative=true", "secondary")),
    el("p", { class: "help" }, "Downloads are reviewer previews. Publish after checking the report to give the customer the reviewed report and roadmap. The published version uses reviewed material without an AI narrative."),
    st.publication_blockers.length ? el("p", { class: "module-note" }, `Before publication: ${st.publication_blockers.join("; ")}.`) : "",
    canPublish ? el("div", { class: "row" }, reason, publish) : el("p", { class: "help" }, "A CloudSeals reviewer or admin publishes the final report."),
    alreadyPublished ? el("p", { class: "help" }, "This reviewed material is already published to the customer.") : "",
    st.versions.length ? el("div", {}, el("h4", {}, "Published versions"), st.versions.map((r) => el("p", { class: "row" },
      `Version ${r.version} · ${when(r.published_at)} · ${r.published_by}`, el("button", { class: "secondary", onclick: safe(async () => {
        await dl(`/v1/assessments/${aid}/diagnostic-report?report_id=${r.report_id}`, `diagnostic-report-v${r.version}-FINAL.html`);
      }) }, `Download version ${r.version}`)))) : "");
}

function deliveredDiagnosticPanel(aid, delivery) {
  if (!delivery) return el("section", { class: "module-panel" }, el("h3", {}, "Your report and improvement roadmap"),
    el("p", { class: "empty-state" }, "CloudSeals is preparing your diagnostic results. The reviewed report and roadmap will appear here after publication."));
  const { snapshot: s, facts: f } = delivery;
  return el("section", { class: "module-panel" }, el("span", { class: "eyebrow" }, "PUBLISHED BY CLOUDSEALS"),
    el("h3", {}, "Your report and improvement roadmap"), el("p", { class: "help" }, `Version ${delivery.version} · ${when(delivery.published_at)}`),
    el("div", { class: "row" }, el("button", { onclick: safe(async () => {
      await dl(`/v1/assessments/${aid}/diagnostic-report?report_id=${delivery.report_id}`, `diagnostic-report-v${delivery.version}-FINAL.html`);
    }) }, "Download published report (HTML)")),
    el("p", {}, `${f.validated_use_cases} reviewed AI use case(s), ${f.validated_gaps} reviewed gap(s), maturity ${f.overall_maturity_score} / 5.`),
    el("h4", {}, "Reviewed gaps"), s.gaps.length ? el("div", { class: "uc-list" }, s.gaps.map((g) => gapCard(aid, g, false, () => {})))
      : el("p", { class: "help" }, "No reviewed gaps are included in this version."),
    el("h4", {}, "Improvement roadmap"), el("p", { class: "help" }, `${f.roadmap_items} action(s), approximately ${f.roadmap_effort_days} person-days in total.`),
    el("div", { class: "uc-list" }, s.roadmap.map((r) => el("article", { class: "uc-card" }, el("h4", {}, r.title),
      el("p", {}, r.description), el("p", { class: "help" }, `${BAND_LABEL[r.timeline_band]} · ${r.responsible_role} · ${r.effort_days} person-days`),
      el("ul", { class: "fw-controls" }, r.success_criteria.map((c) => el("li", {}, c)))))));
}

function pipelineStepper(inv) {
  const v = (xs) => (xs || []).some((x) => x.status === "VALIDATED");
  const steps = [["Inventory", v(inv.use_cases)], ["Gap analysis", v(inv.gaps)], ["Maturity", inv.maturity?.status === "VALIDATED"], ["Roadmap", v(inv.roadmap)]];
  const ov = inv.overlay?.status === "VALIDATED";
  return el("ol", { class: "pipe-steps", "aria-label": "Diagnostic pipeline" }, steps.map(([n, done], i) => el("li", { class: done ? "is-done" : "" }, el("span", {}, done ? "✓" : String(i + 1)), n)),
    el("li", { class: steps.every(([, d]) => d) ? "is-done" : "" }, el("span", {}, steps.every(([, d]) => d) ? "✓" : "5"), "Report"),
    el("li", { class: `optional${ov ? " is-done" : ""}` }, el("span", {}, ov ? "✓" : "+"), "Architecture (optional)"));
}

routes["use-cases"] = async (aidArg) => {
  const { items: assessments } = await api("/v1/assessments");
  if (!assessments.length) return main.replaceChildren(moduleFrame("DIAGNOSIS · AI INVENTORY", "AI use cases", "Read documents and list the AI use cases they evidence.",
    el("p", { class: "empty-state" }, "Create an assessment and upload documents first."), el("a", { class: "btn", href: "#/assessments" }, "Go to Diagnosis")));
  const aid = assessments.some((a) => a.assessment_id === aidArg) ? aidArg : assessments[0].assessment_id;
  const canReview = state.me.roles.some((r) => REVIEW_ROLES.includes(r));
  const [inv, evidence, fw] = await Promise.all([api(`/v1/assessments/${aid}/inventory`), api(`/v1/assessments/${aid}/evidence`), api("/v1/frameworks")]);
  const docTypes = ["application/pdf", "text/plain", "text/csv", "application/json", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  const docs = evidence.items.filter((e) => e.state === "clean" && docTypes.includes(e.content_type));
  const redraw = () => routes["use-cases"](aid);
  const picker = el("label", { class: "uc-picker" }, "Assessment", el("select", { onchange: (e) => go(`#/use-cases/${e.target.value}`) },
    assessments.map((a) => el("option", { value: a.assessment_id, selected: a.assessment_id === aid }, `${a.ai_system_name} (${a.status})`))));
  const runBtn = el("button", { disabled: !docs.length, title: docs.length ? "" : "Upload a clean PDF, Word or text document first", onclick: safe(async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = "Reading documents…";
    const r = await api(`/v1/assessments/${aid}/inventory/run`, { method: "POST", body: {} });
    useCaseNote = r.mode === "unavailable" ? r.note : `${r.items.length} candidate use case(s) found in ${r.documents_read} document(s)${r.rejected ? `; ${r.rejected} unverifiable candidate(s) were dropped` : ""}.`;
    await redraw();
  }) }, "Find AI use cases in the documents");
  const useCasePanel = el("section", { class: "module-panel" },
    el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "STEP 1 · INVENTORY AGENT"), el("h3", {}, `${inv.use_cases.length} candidate use case${inv.use_cases.length === 1 ? "" : "s"}`))),
    el("p", { class: "help" }, `${docs.length} readable document${docs.length === 1 ? "" : "s"} in this assessment (PDF, Word, text). Every candidate must quote the document word for word; anything the agent cannot back with a quote is discarded.`),
    el("div", { class: "row" }, picker, runBtn), useCaseNote ? el("p", { class: "module-note" }, useCaseNote) : "",
    inv.use_cases.length ? el("div", { class: "uc-list" }, inv.use_cases.map((u) => useCaseCard(aid, u, canReview, redraw)))
      : el("p", { class: "empty-state" }, "No use cases yet. Upload documents in Diagnosis, then run the Inventory Agent."));
  const validated = inv.use_cases.filter((u) => u.status === "VALIDATED").length;
  const fwSel = el("select", { "aria-label": "Framework" }, fw.items.map((f) => el("option", { value: f.id }, `${f.short_name} (${f.requirement_count} requirements)`)));
  const gapRun = el("button", { disabled: !validated, title: validated ? "" : "Validate at least one use case first", onclick: safe(async (e) => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = "Analysing…";
    const r = await api(`/v1/assessments/${aid}/gap-analysis/run`, { method: "POST", body: { framework_id: fwSel.value } });
    useCaseNote = r.mode === "unavailable" ? r.note : `${r.items.length} candidate gap(s) for ${fwSel.selectedOptions[0].textContent.split(" (")[0]}${r.rejected ? `; ${r.rejected} unverifiable candidate(s) were dropped` : ""}.`;
    await redraw();
  }) }, "Run gap analysis");
  const gaps = [...inv.gaps].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const gapPanel = canReview ? el("section", { class: "module-panel" },
    el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "STEP 2 · GAP ANALYSIS AGENT"), el("h3", {}, `${gaps.length} candidate gap${gaps.length === 1 ? "" : "s"}`))),
    el("p", { class: "help" }, "Compares validated use cases with a framework. Each gap cites a real requirement or control ID and stays unreviewed until a reviewer decides."),
    el("div", { class: "row" }, el("label", { class: "uc-picker" }, "Framework", fwSel), gapRun),
    gaps.length ? el("div", { class: "uc-list" }, gaps.map((g) => gapCard(aid, g, canReview, redraw))) : el("p", { class: "empty-state" }, validated ? "No gaps recorded yet. Run the analysis." : "Validate a use case to unlock gap analysis."))
    : el("section", { class: "module-panel" }, el("span", { class: "eyebrow" }, "STEP 2 · GAP ANALYSIS"), el("p", { class: "help" }, inv.gaps_note || "Gap analysis is prepared by CloudSeals reviewers."));
  const validatedGaps = inv.gaps.some((g) => g.status === "VALIDATED");
  const staffPanels = canReview ? [maturityPanel(aid, inv, canReview, validated > 0, redraw), roadmapPanel(aid, inv, canReview, validatedGaps || inv.maturity?.status === "VALIDATED", redraw), overlayPanel(aid, inv, canReview, validated > 0, redraw), await reportPanel(aid)] : [];
  main.replaceChildren(moduleFrame("DIAGNOSIS · AI GOVERNANCE STUDIO", "Diagnostic studio", "From documents to a reviewed inventory, framework gaps, maturity, roadmap and report. Every step is a draft until a CloudSeals reviewer validates it.",
    canReview ? pipelineStepper(inv) : deliveredDiagnosticPanel(aid, inv.delivery), useCasePanel, gapPanel, ...staffPanels));
};

routes.frameworks = async (fid) => {
  const { items } = await api("/v1/frameworks");
  const active = items.find((f) => f.id === fid)?.id;
  const detail = active ? await api(`/v1/frameworks/${active}`) : null;
  const cards = items.map((f) => el("a", { class: `module-card module-card-link${f.id === active ? " module-card-primary" : ""}`, href: `#/frameworks/${f.id}` },
    el("span", { class: "module-card-status" }, "PENDING LEGAL REVIEW"), el("h3", {}, f.short_name), el("p", {}, `${f.name} · ${f.jurisdiction}`),
    el("p", {}, `${f.requirement_count} requirements · ${f.control_count} controls`), el("span", { class: "module-card-open" }, "View requirements →")));
  const body = detail ? el("section", { class: "module-panel" },
    el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, detail.version || "FRAMEWORK"), el("h3", {}, detail.name))),
    el("p", { class: "module-note" }, detail.notice), el("p", { class: "help" }, detail.description),
    detail.requirements.map((r) => el("details", { class: "fw-req" }, el("summary", {}, el("strong", {}, r.title), el("span", { class: "q-id" }, ` ${r.id}`)),
      el("p", {}, r.text), el("ul", { class: "fw-controls" }, (r.controls || []).map((c) => el("li", {}, el("span", { class: "q-id" }, c.id), ` ${c.description}`,
        c.evidence_needed?.length ? el("small", {}, ` Evidence: ${c.evidence_needed.join("; ")}`) : ""))))))
    : el("p", { class: "empty-state" }, "Choose a framework to read its requirements and controls.");
  main.replaceChildren(moduleFrame("OPERATIONS · REFERENCE", "Frameworks", "The requirement and control definitions the gap analysis agent compares use cases against. Read-only.",
    el("section", { class: "module-card-grid fw-grid" }, cards), body));
};


// ---------- Users and access (CloudSeals admins) ----------
const ROLE_LABEL = { cloudseals_admin: "Admin", cloudseals_assessor: "Assessor", cloudseals_reviewer: "Reviewer", cloudseals_platform_ops: "Platform ops", auditor_readonly: "Auditor (read only)",
  customer_admin: "Customer admin", customer_architect: "Customer architect", customer_risk: "Customer risk", customer_controller: "Customer controller", customer_contributor: "Customer contributor" };
const STAFF_ROLE_IDS = ["cloudseals_admin", "cloudseals_assessor", "cloudseals_reviewer", "cloudseals_platform_ops"];
const CUSTOMER_ROLE_IDS = ["customer_admin", "customer_architect", "customer_risk", "customer_controller", "customer_contributor", "auditor_readonly"];
const OWNER_BADGE = (roles) => STAFF_ROLE_IDS.every((r) => roles.includes(r));
const roleChips = (roles) => OWNER_BADGE(roles) ? el("span", { class: "role-chips" }, el("span", { class: "role-chip staff" }, "Owner (all CloudSeals roles)")) : el("span", { class: "role-chips" }, roles.map((r) => el("span", { class: `role-chip${r.startsWith("cloudseals") ? " staff" : ""}` }, ROLE_LABEL[r] || r)));
function roleChecks(ids, selected, name) {
  return el("div", { class: "role-checks" }, ids.map((id) => el("label", { class: "role-check" }, el("input", { type: "checkbox", name, value: id, checked: selected.includes(id) }), ROLE_LABEL[id])));
}
const pickedRoles = (root, name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

routes.users = async () => {
  if (!state.me.roles.includes("cloudseals_admin")) return main.replaceChildren(moduleFrame("ADMINISTRATION", "Users", "Only CloudSeals admins manage access.", el("p", { class: "empty-state" }, "You do not have access to this page.")));
  const [{ items, pending, staff_email_domains: domains, sign_in: signIn }, { items: tenants }] = await Promise.all([api("/v1/admin/users"), api("/v1/admin/tenants")]);
  const redraw = () => routes.users();
  const kind = el("select", { "aria-label": "Type of user" }, el("option", { value: "staff" }, "CloudSeals staff"), el("option", { value: "customer" }, "Customer user"));
  const email = el("input", { type: "email", placeholder: "name@cloudseals.co.uk", required: true, maxlength: 254, "aria-label": "Email address" });
  const tenantSel = el("select", { "aria-label": "Customer workspace" }, tenants.map((t) => el("option", { value: t.tenant_id }, t.name || t.tenant_id)));
  const staffBox = roleChecks(STAFF_ROLE_IDS, ["cloudseals_reviewer"], "new-roles"), custBox = roleChecks(CUSTOMER_ROLE_IDS, ["customer_contributor"], "new-roles");
  const tenantRow = el("label", {}, "Customer workspace", tenantSel);
  const sync = () => { const staff = kind.value === "staff"; staffBox.hidden = !staff; custBox.hidden = staff; tenantRow.hidden = staff; };
  kind.addEventListener("change", sync);
  const form = el("form", { class: "module-panel user-form", onsubmit: safe(async (e) => {
    e.preventDefault(); const staff = kind.value === "staff"; const roles = pickedRoles(staff ? staffBox : custBox, "new-roles");
    if (!roles.length) return toast("Choose at least one role", true);
    await api("/v1/admin/users", { method: "POST", body: { email: email.value.trim(), roles, tenant_id: staff ? null : tenantSel.value } });
    toast("Added. Access starts when they first sign in with Google."); redraw();
  }) }, el("span", { class: "eyebrow" }, "ADD A USER"), el("h3", {}, "Give someone access"),
    signIn !== "google" ? el("p", { class: "module-note" }, "Adding people by email needs Google sign-in. Use workspace invitations for this environment.") : "",
    el("div", { class: "row" }, el("label", {}, "Type", kind), el("label", { class: "grow" }, "Email", email)), tenantRow,
    el("label", {}, "Roles"), staffBox, custBox,
    el("p", { class: "help" }, `They sign in with this Google email; access begins at their first sign-in.${domains.length ? ` CloudSeals roles are limited to ${domains.join(", ")}.` : ""}`),
    el("button", { disabled: signIn !== "google" }, "Add user"));
  sync();

  const row = (u) => {
    const editor = el("div", { class: "user-edit", hidden: true });
    const isStaff = u.roles.some((r) => r.startsWith("cloudseals"));
    const boxes = roleChecks(isStaff ? STAFF_ROLE_IDS : CUSTOMER_ROLE_IDS, u.roles, `r-${u.sub}`);
    editor.append(boxes, el("div", { class: "row" }, el("button", { onclick: safe(async () => {
      const roles = pickedRoles(editor, `r-${u.sub}`); if (!roles.length) return toast("Choose at least one role", true);
      await api(`/v1/admin/users/${encodeURIComponent(u.sub)}`, { method: "PATCH", body: { roles } }); toast("Roles updated"); redraw();
    }) }, "Save roles"), el("button", { class: "secondary", onclick: () => { editor.hidden = true; } }, "Cancel")));
    const remove = el("button", { class: "danger", disabled: u.is_self, title: u.is_self ? "You cannot remove yourself" : "", onclick: safe(async (e) => {
      if (e.currentTarget.dataset.armed !== "1") { e.currentTarget.dataset.armed = "1"; e.currentTarget.textContent = "Click again to remove"; return; }
      await api(`/v1/admin/users/${encodeURIComponent(u.sub)}`, { method: "DELETE" }); toast("User removed"); redraw();
    }) }, "Remove");
    return el("tr", {}, el("td", {}, el("strong", {}, u.email || u.sub), u.is_self ? el("span", { class: "tag ok" }, "you") : "", el("br"), el("small", { class: "help" }, u.email ? u.sub : "")),
      el("td", {}, roleChips(u.roles), editor), el("td", {}, u.tenant_name || (isStaff ? "CloudSeals" : u.tenant_id || "")),
      el("td", {}, el("div", { class: "row" }, el("button", { class: "secondary", onclick: () => { editor.hidden = !editor.hidden; } }, "Edit roles"),
        isStaff && !STAFF_ROLE_IDS.every((r) => u.roles.includes(r)) ? el("button", { class: "secondary", title: "Grant every CloudSeals role", onclick: safe(async () => {
          await api(`/v1/admin/users/${encodeURIComponent(u.sub)}`, { method: "PATCH", body: { roles: STAFF_ROLE_IDS } }); toast("Now an owner: all CloudSeals roles"); redraw();
        }) }, "Make owner") : "", remove)));
  };
  const table = (head, rows) => el("div", { class: "table-wrap" }, el("table", { class: "module-table" }, el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows)));
  const pend = pending.length ? el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "WAITING FOR FIRST SIGN-IN"), el("h3", {}, `${pending.length} pending`))),
    table(["Email", "Roles", "Workspace", ""], pending.map((p) => el("tr", {}, el("td", {}, p.email), el("td", {}, roleChips(p.roles)), el("td", {}, p.tenant_name || "CloudSeals"),
      el("td", {}, el("button", { class: "secondary", onclick: safe(async () => { await api(`/v1/admin/users/pending/${encodeURIComponent(p.email)}`, { method: "DELETE" }); toast("Invitation cancelled"); redraw(); }) }, "Cancel")))))) : "";
  main.replaceChildren(moduleFrame("ADMINISTRATION · ACCESS", "Users", "Who can sign in, with which roles. Changes are recorded in the activity log.", form,
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "MEMBERS"), el("h3", {}, `${items.length} user${items.length === 1 ? "" : "s"}`))),
      table(["User", "Roles", "Workspace", ""], items.map(row))), pend));
};


// ---------- Cases: CloudSeals engagement tracking ----------
const CASE_STATUS = ["draft", "intake", "inventory", "gap", "review", "report", "delivered", "archived"];
const CASE_STATUS_LABEL = { draft: "Draft", intake: "Intake", inventory: "Inventory", gap: "Gap analysis", review: "In review", report: "Report", delivered: "Delivered", archived: "Archived" };
const INDUSTRIES = ["financial_services", "pharma", "healthcare", "retail", "manufacturing", "energy", "public_sector", "technology", "other"];
const FRAMEWORK_SHORT = { eu_ai_act: "EU AI Act", iso_42001: "ISO 42001", nist_ai_rmf: "NIST AI RMF", sr_11_7: "SR 11-7", fda_samd: "FDA SaMD" };
const label = (v) => String(v).replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
const caseStatusChip = (s) => el("span", { class: `case-status cs-${s}` }, CASE_STATUS_LABEL[s] || s);
const when = (t) => new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const staffName = (a) => a.email || a.sub;

routes.cases = async () => {
  const [{ items }, { items: staff }] = await Promise.all([api("/v1/cases"), api("/v1/staff")]);
  const canCreate = state.me.roles.some((r) => ["cloudseals_admin", "cloudseals_assessor"].includes(r));
  let tenants = []; try { tenants = (await api("/v1/admin/tenants")).items; } catch { /* only some staff roles may list workspaces */ }
  const view = { status: "all", q: "", sort: "newest" };
  const list = el("div", { class: "table-wrap" });
  const chips = el("div", { class: "case-filters", role: "group", "aria-label": "Filter by status" });
  const draw = () => {
    chips.replaceChildren(...["all", ...CASE_STATUS].map((s) => el("button", { class: `chip${view.status === s ? " on" : ""}`, onclick: () => { view.status = s; draw(); } },
      s === "all" ? "All" : CASE_STATUS_LABEL[s], el("em", {}, String(s === "all" ? items.length : items.filter((c) => c.status === s).length)))));
    const rows = items.filter((c) => (view.status === "all" || c.status === view.status) && (!view.q || `${c.title} ${c.customer_name}`.toLowerCase().includes(view.q.toLowerCase())))
      .sort((a, b) => view.sort === "customer" ? a.customer_name.localeCompare(b.customer_name) : view.sort === "oldest" ? a.created_at - b.created_at : b.created_at - a.created_at);
    list.replaceChildren(rows.length ? el("table", { class: "module-table" }, el("thead", {}, el("tr", {}, ["Case", "Frameworks", "Status", "Risk", "Maturity", "Updated", ""].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, rows.map((c) => el("tr", {}, el("td", {}, el("a", { href: `#/case/${c.case_id}` }, el("strong", {}, c.title)), el("br"), el("small", { class: "help" }, `${c.customer_name} · ${label(c.tier)}`)),
        el("td", {}, c.frameworks_in_scope.map((f) => el("span", { class: "tag" }, FRAMEWORK_SHORT[f] || f))), el("td", {}, caseStatusChip(c.status)),
        el("td", {}, c.progress.risk_level ? el("span", { class: `tag ${TIER_CLASS[c.progress.risk_level] || ""}` }, TIER_LABEL[c.progress.risk_level]) : "—"),
        el("td", {}, c.progress.maturity_score != null ? `${c.progress.maturity_score} / 5` : "—"), el("td", {}, when(c.updated_at)),
        el("td", {}, el("a", { href: `#/case/${c.case_id}` }, "Open →")))))) : el("p", { class: "empty-state" }, items.length ? "No cases match this filter." : "No cases yet. Create the first one."));
  };
  const form = el("form", { class: "module-panel user-form", hidden: true, onsubmit: safe(async (e) => {
    e.preventDefault(); const d = new FormData(form);
    const body = { title: d.get("title"), customer_name: d.get("customer"), industry: d.get("industry"), region: d.get("region"), tier: d.get("tier"),
      frameworks_in_scope: d.getAll("fw"), lead_architect: d.get("lead") || null, architects: d.getAll("arch"), target_delivery_date: d.get("due") || null, notes: d.get("notes") || "", tenant_id: d.get("tenant") || null };
    const c = await api("/v1/cases", { method: "POST", body }); toast("Case created"); go(`#/case/${c.case_id}`);
  }) }, el("span", { class: "eyebrow" }, "NEW CASE"), el("h3", {}, "Open a diagnostic engagement"),
    el("div", { class: "row" }, el("label", { class: "grow" }, "Case title", el("input", { name: "title", required: true, minlength: 3, maxlength: 200, placeholder: "e.g. Demo Bank AI governance review Q4" })),
      el("label", { class: "grow" }, "Customer", el("input", { name: "customer", required: true, minlength: 2, maxlength: 200, placeholder: "e.g. Demo Bank plc" }))),
    el("div", { class: "row" }, el("label", {}, "Industry", el("select", { name: "industry" }, INDUSTRIES.map((i) => el("option", { value: i }, label(i))))),
      el("label", {}, "Region", el("select", { name: "region" }, ["UK", "EU", "US", "APAC", "Other"].map((r) => el("option", { value: r }, r)))),
      el("label", {}, "Tier", el("select", { name: "tier" }, ["tier_1", "tier_2", "tier_3"].map((t) => el("option", { value: t }, label(t))))),
      el("label", {}, "Target delivery", el("input", { name: "due", type: "date" })),
      tenants.length ? el("label", {}, "Customer workspace (optional)", el("select", { name: "tenant" }, el("option", { value: "" }, "None yet"), tenants.map((t) => el("option", { value: t.tenant_id }, t.name || t.tenant_id)))) : ""),
    el("label", {}, "Frameworks in scope"), el("div", { class: "role-checks" }, Object.entries(FRAMEWORK_SHORT).map(([id, n]) => el("label", { class: "role-check" }, el("input", { type: "checkbox", name: "fw", value: id, checked: id === "eu_ai_act" }), n))),
    el("label", {}, "Lead architect", el("select", { name: "lead" }, staff.map((a) => el("option", { value: a.sub, selected: a.sub === state.me.sub }, staffName(a))))),
    el("label", {}, "Other architects"), el("div", { class: "role-checks" }, staff.map((a) => el("label", { class: "role-check" }, el("input", { type: "checkbox", name: "arch", value: a.sub }), staffName(a)))),
    el("label", {}, "Notes", el("textarea", { name: "notes", rows: 2, maxlength: 4000 })), el("div", { class: "row" }, el("button", {}, "Create case"), el("button", { type: "button", class: "secondary", onclick: () => { form.hidden = true; } }, "Cancel")));
  const search = el("input", { type: "search", placeholder: "Search cases or customers", "aria-label": "Search cases", oninput: (e) => { view.q = e.target.value; draw(); } });
  const sort = el("select", { "aria-label": "Sort", onchange: (e) => { view.sort = e.target.value; draw(); } }, [["newest", "Newest first"], ["oldest", "Oldest first"], ["customer", "Customer A to Z"]].map(([v, l]) => el("option", { value: v }, l)));
  const open = items.filter((c) => !["delivered", "archived"].includes(c.status)).length;
  main.replaceChildren(moduleFrame("CLOUDSEALS · ENGAGEMENTS", "Cases", "One case per customer engagement: who is assigned, which assessments belong to it, how far the review has got.",
    el("section", { class: "module-metrics compact" }, [["Cases", items.length], ["Open", open], ["Delivered", items.filter((c) => c.status === "delivered").length]].map(([k, v]) => el("article", {}, el("span", {}, k), el("strong", {}, String(v))))),
    canCreate ? el("p", {}, el("button", { onclick: () => { form.hidden = !form.hidden; } }, "+ New case")) : "", form,
    el("section", { class: "module-panel" }, el("div", { class: "row case-tools" }, search, sort), chips, list)));
  draw();
};

routes.case = async (cid) => {
  let tab = "overview";
  const draw = async () => {
    const [c, staff] = await Promise.all([api(`/v1/cases/${cid}`), api("/v1/staff")]);
    const isLead = state.me.roles.includes("cloudseals_admin") || c.lead_architect === state.me.sub;
    const tabs = el("div", { class: "case-tabs", role: "tablist" }, [["overview", "Overview"], ["assessments", `Assessments (${c.assessments.length})`], ["activity", "Activity"]].map(([id, l]) =>
      el("button", { role: "tab", class: `tab${tab === id ? " on" : ""}`, "aria-selected": String(tab === id), onclick: () => { tab = id; draw(); } }, l)));
    let body;
    if (tab === "overview") {
      const next = el("select", { "aria-label": "New status" }, CASE_STATUS.map((s) => el("option", { value: s, selected: s === c.status }, CASE_STATUS_LABEL[s])));
      const why = el("input", { placeholder: "Reason (required)", maxlength: 2000, "aria-label": "Reason for status change" });
      const p = c.progress;
      const steps = [["Use cases", p.validated_use_cases > 0], ["Gaps", p.validated_gaps > 0], ["Maturity", p.maturity_score != null], ["Roadmap", p.validated_roadmap_items > 0], ["Report", p.report === "final"]];
      const fields = [["Customer", c.customer_name], ["Industry", label(c.industry)], ["Region", c.region], ["Tier", label(c.tier)], ["Target delivery", c.target_delivery_date || "Not set"],
        ["Lead architect", staffName(c.architects.find((a) => a.is_lead) || { sub: c.lead_architect })], ["Architects", c.architects.map(staffName).join(", ")], ["Created", when(c.created_at)]];
      const edit = el("form", { class: "user-edit", hidden: true, onsubmit: safe(async (e) => {
        e.preventDefault(); const d = new FormData(edit);
        await api(`/v1/cases/${cid}`, { method: "PATCH", body: { tier: d.get("tier"), target_delivery_date: d.get("due") || null, notes: d.get("notes"), frameworks_in_scope: d.getAll("fw"), lead_architect: d.get("lead"), architects: d.getAll("arch") } });
        toast("Case updated"); draw();
      }) }, el("div", { class: "row" }, el("label", {}, "Tier", el("select", { name: "tier" }, ["tier_1", "tier_2", "tier_3"].map((t) => el("option", { value: t, selected: t === c.tier }, label(t))))),
        el("label", {}, "Target delivery", el("input", { name: "due", type: "date", value: c.target_delivery_date || "" })),
        el("label", {}, "Lead architect", el("select", { name: "lead" }, staff.items.map((a) => el("option", { value: a.sub, selected: a.sub === c.lead_architect }, staffName(a)))))),
        el("label", {}, "Frameworks"), el("div", { class: "role-checks" }, Object.entries(FRAMEWORK_SHORT).map(([id, n]) => el("label", { class: "role-check" }, el("input", { type: "checkbox", name: "fw", value: id, checked: c.frameworks_in_scope.includes(id) }), n))),
        el("label", {}, "Architects"), el("div", { class: "role-checks" }, staff.items.map((a) => el("label", { class: "role-check" }, el("input", { type: "checkbox", name: "arch", value: a.sub, checked: c.architects.some((x) => x.sub === a.sub) }), staffName(a)))),
        el("label", {}, "Notes", el("textarea", { name: "notes", rows: 3, maxlength: 4000 }, c.notes || "")), el("div", { class: "row" }, el("button", {}, "Save"), el("button", { type: "button", class: "secondary", onclick: () => { edit.hidden = true; } }, "Cancel")));
      body = el("div", {}, el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "PROGRESS"), el("h3", {}, "What a reviewer has validated"))),
        el("ol", { class: "pipe-steps" }, steps.map(([n, done], i) => el("li", { class: done ? "is-done" : "" }, el("span", {}, done ? "✓" : String(i + 1)), n))),
        el("p", { class: "help" }, `${p.validated_use_cases} use case(s), ${p.validated_gaps} gap(s), ${p.validated_roadmap_items} roadmap item(s). Risk level: ${p.risk_level ? TIER_LABEL[p.risk_level] : "not set"}. Maturity: ${p.maturity_score != null ? `${p.maturity_score} / 5` : "not scored"}. Report: ${p.report}.`)),
        el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "DETAILS"), el("h3", {}, "Engagement")),
          isLead ? el("button", { class: "secondary", onclick: () => { edit.hidden = !edit.hidden; } }, "Edit") : ""),
          el("dl", { class: "uc-meta" }, fields.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))), c.notes ? el("p", { class: "uc-why" }, c.notes) : "", edit),
        el("section", { class: "module-panel" }, el("span", { class: "eyebrow" }, "STATUS"), el("h3", {}, "Move the case on"),
          isLead ? el("div", { class: "row" }, next, why, el("button", { onclick: safe(async () => { if (!why.value.trim()) return toast("Enter a reason first", true);
            await api(`/v1/cases/${cid}/status`, { method: "POST", body: { status: next.value, reason: why.value.trim() } }); toast("Status updated"); draw(); }) }, "Update status"))
            : el("p", { class: "help" }, "Only the lead architect or an admin changes the status."),
          el("p", { class: "help" }, "Publish a diagnostic report to the customer before marking the case delivered."),
          el("ul", { class: "case-history" }, [...c.status_history].reverse().map((h) => el("li", {}, caseStatusChip(h.status), ` ${when(h.at)} · ${h.by} · ${h.reason}`)))));
    } else if (tab === "assessments") {
      const all = (await api("/v1/assessments")).items.filter((a) => !c.assessment_ids.includes(a.assessment_id) && (!c.tenant_id || a.tenant_id === c.tenant_id));
      const evidence = await Promise.all(c.assessments.map(async (a) => ({ a, ev: (await api(`/v1/assessments/${a.assessment_id}/evidence`)).items })));
      const pick = el("select", { "aria-label": "Assessment to link" }, all.map((a) => el("option", { value: a.assessment_id }, `${a.ai_system_name} (${a.status})`)));
      body = el("div", {}, el("section", { class: "module-panel" }, el("span", { class: "eyebrow" }, "LINKED ASSESSMENTS"), el("h3", {}, `${c.assessments.length} assessment${c.assessments.length === 1 ? "" : "s"}`),
        evidence.length ? evidence.map(({ a, ev }) => el("article", { class: "uc-card" }, el("div", { class: "uc-head" }, el("h4", {}, a.ai_system_name), el("span", { class: "tag" }, a.status),
          el("a", { href: `#/use-cases/${a.assessment_id}` }, "Diagnostic studio →"), el("a", { href: `#/assessment/${a.assessment_id}` }, "Assessment →"),
          isLead ? el("button", { class: "secondary", onclick: safe(async () => { await api(`/v1/cases/${cid}/assessments/${a.assessment_id}`, { method: "DELETE" }); toast("Unlinked"); draw(); }) }, "Unlink") : ""),
          el("p", { class: "help" }, "Documents"), ev.length ? el("ul", { class: "fw-controls" }, ev.map((e) => el("li", {}, `${e.filename} `, el("span", { class: `tag ${e.state === "clean" ? "ok" : "high"}` }, e.state)))) : el("p", { class: "help" }, "No documents uploaded yet.")))
          : el("p", { class: "empty-state" }, "No assessment is linked yet."),
        isLead ? el("div", { class: "row" }, all.length ? pick : el("span", { class: "help" }, "No other assessments are available to link."), all.length ? el("button", { onclick: safe(async () => {
          await api(`/v1/cases/${cid}/assessments`, { method: "POST", body: { assessment_id: pick.value } }); toast("Linked"); draw(); }) }, "Link assessment") : "") : ""));
    } else {
      const { items } = await api(`/v1/cases/${cid}/audit`);
      body = el("section", { class: "module-panel" }, el("span", { class: "eyebrow" }, "ACTIVITY"), el("h3", {}, `${items.length} recorded event${items.length === 1 ? "" : "s"}`),
        items.length ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" }, el("thead", {}, el("tr", {}, ["When", "Who", "Action", "Reference"].map((h) => el("th", { scope: "col" }, h)))),
          el("tbody", {}, items.map((a) => el("tr", {}, el("td", {}, new Date(a.at * 1000).toLocaleString()), el("td", {}, a.email || a.sub), el("td", {}, a.action), el("td", {}, String(a.ref).slice(0, 44))))))) : el("p", { class: "empty-state" }, "Nothing recorded yet."));
    }
    main.replaceChildren(moduleFrame("CLOUDSEALS · CASE", c.title, `${c.customer_name} · ${label(c.tier)}`, el("p", {}, el("a", { href: "#/cases" }, "← All cases"), " ", caseStatusChip(c.status)), tabs, body));
  };
  await draw();
};


// ---------- Customer workspaces: read-only view for CloudSeals staff ----------
routes.workspaces = async () => {
  const { items } = await api("/v1/admin/workspaces");
  main.replaceChildren(moduleFrame("CLOUDSEALS · CUSTOMERS", "Customer workspaces", "See what each customer sees. This is a read-only view: customer actions are done by the customer's own users.",
    items.length ? el("section", { class: "module-card-grid" }, items.map((w) => el("a", { class: "module-card module-card-link", href: `#/workspace/${w.tenant_id}` },
      el("span", { class: "module-card-status" }, w.pending_approvals ? `${w.pending_approvals} APPROVAL${w.pending_approvals === 1 ? "" : "S"} WAITING` : "WORKSPACE"), el("h3", {}, w.name),
      el("p", {}, `${w.assessments} assessment${w.assessments === 1 ? "" : "s"} · ${w.runs} workflow run${w.runs === 1 ? "" : "s"} · ${w.users} user${w.users === 1 ? "" : "s"}`), el("span", { class: "module-card-open" }, "View workspace →"))))
      : el("p", { class: "empty-state" }, "No customer workspace has been activated yet.")));
};

routes.workspace = async (tid) => {
  const w = await api(`/v1/admin/workspaces/${encodeURIComponent(tid)}`);
  const table = (head, rows, empty) => rows.length ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" }, el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows))) : el("p", { class: "empty-state" }, empty);
  main.replaceChildren(moduleFrame("CLOUDSEALS · CUSTOMER WORKSPACE", w.tenant.name || w.tenant.tenant_id, [w.tenant.industry, w.tenant.residency_profile].filter(Boolean).join(" · ") || "Customer workspace",
    el("p", {}, el("a", { href: "#/workspaces" }, "← All workspaces")),
    el("p", { class: "module-note" }, "Read-only view for CloudSeals staff. You can look at everything here, but approvals and customer answers stay with the customer's own users."),
    el("section", { class: "module-panel" }, el("span", { class: "eyebrow" }, "ASSESSMENTS"), el("h3", {}, `${w.assessments.length} assessment${w.assessments.length === 1 ? "" : "s"}`),
      table(["AI system", "Status", "", ""], w.assessments.map((a) => el("tr", {}, el("td", {}, a.ai_system_name), el("td", {}, el("span", { class: "tag" }, a.status)),
        el("td", {}, el("a", { href: `#/assessment/${a.assessment_id}` }, "Open assessment →")), el("td", {}, el("a", { href: `#/use-cases/${a.assessment_id}` }, "Diagnostic studio →")))), "No assessments yet.")),
    el("section", { class: "module-panel" }, el("span", { class: "eyebrow" }, "WORKFLOW RUNS"), el("h3", {}, w.pending_approvals ? `${w.pending_approvals} waiting for a customer controller` : "Recent runs"),
      table(["Receipt", "Amount", "Status", "Started by", ""], w.runs.map((r) => el("tr", {}, el("td", {}, r.receipt_id), el("td", {}, r.amount_minor != null ? `${r.currency} ${(r.amount_minor / 100).toFixed(2)}` : ""),
        el("td", {}, el("span", { class: `tag ${r.status === "approval_required" ? "medium" : r.status === "completed" ? "ok" : ""}` }, r.status.replaceAll("_", " "))), el("td", {}, r.created_by),
        el("td", {}, el("a", { href: `#/trustops/${r.run_id}` }, "Open run →")))), "No workflow runs yet.")),
    el("section", { class: "module-panel" }, el("span", { class: "eyebrow" }, "PEOPLE"), el("h3", {}, `${w.members.length} user${w.members.length === 1 ? "" : "s"}`),
      table(["User", "Roles"], w.members.map((m) => el("tr", {}, el("td", {}, m.email || m.sub), el("td", {}, roleChips(m.roles)))), "No users yet."))));
};

// ---------- boot ----------
async function boot() {
  state.cfg = await fetch("config.json", { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("Portal sign-in configuration could not be loaded.");
    return r.json();
  }).catch(() => ({ mode: "oidc", oidc: {} }));
  const q = new URLSearchParams(location.search);
  if (q.get("code")) { try { await oidcCallback(q); } catch (e) { toast(e.message, true); } }
  render();
}
boot();
