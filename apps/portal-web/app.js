// TAAD portal: dependency-free ES module. All dynamic text goes through textContent (no innerHTML).
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
  if (!r.ok) { const e = new Error(data.message || r.statusText); e.status = r.status; e.code = data.code; throw e; }
  return data;
}
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
  location.href = `${o.authorize_url}?response_type=code&client_id=${encodeURIComponent(o.client_id)}&redirect_uri=${encodeURIComponent(o.redirect_uri)}&scope=${encodeURIComponent(o.scope)}&code_challenge=${challenge}&code_challenge_method=S256&state=${st}`;
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
      "Continue with organisation sign-in", el("span", { "aria-hidden": "true" }, "→")),
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
    ...(hasAnyRole("cloudseals_admin") ? [["registrations", "Registrations"]] : []),
    ...(hasAnyRole("cloudseals_admin", "cloudseals_platform_ops", "auditor_readonly") ? [["activity", "Activity"]] : []),
    ["integrations", "Integrations"], ["datasets", "Datasets"], ["workflows", "Workflows"],
    ["agents", "Agents"], ["models", "Models"], ["policies", "Policies"], ["authority", "Authority"],
    ["approval-matrix", "Approval matrix"], ["agentops", "AgentOps"],
    ...(hasAnyRole("cloudseals_admin") ? [["tenant-settings", "Tenant settings"]] : []),
  ];
  nav.replaceChildren(
    link(["dashboard", "Command Center"]), link(["assessments", "Diagnosis"]), link(["trustops", "TrustOps"]),
    canUseAdminMetrics ? link(["queue", "Review queue"]) : "",
    group("Operations", [["reconciliation", "Reconciliation"], ["exceptions", "Exceptions"], ["approvals", "Approvals"],
      ["evidence", "Evidence"], ["readiness", "Readiness"], ["shadow-roi", "Shadow ROI"], ...(staff ? [] : [["team", "Team"]])]),
    staff ? group("Administration", adminItems) : "");
  who.replaceChildren(state.cfg.mode === "dev"
    ? el("span", { class: "tag" }, `${tenantLabel(state.me.tenant)} workspace`)
    : `${state.me.sub} `, state.cfg.mode === "dev" ? "" : el("button", { class: "secondary", onclick: logout }, "Sign out"));
  contextBar.replaceChildren(
    el("span", {}, el("small", {}, "TENANT"), state.me.tenant ? tenantLabel(state.me.tenant) : staff ? "CloudSeals operations" : "Customer workspace"),
    state.cfg.mode === "dev" ? "" : el("span", {}, el("small", {}, "ENVIRONMENT"), "OIDC session"),
    el("span", {}, el("small", {}, "ENTITY SCOPE"), "Selected in assessment"),
    el("span", {}, el("small", {}, "ROLE"), state.me.roles.join(" · ")),
    el("span", {}, el("small", {}, "QUESTION CATALOG"), "v1.0.0 · 318 questions"),
    el("span", {}, el("small", {}, "EVIDENCE INTEGRITY"), state.cfg.mode === "dev" ? "Local hash chain" : "Environment profile"),
    el("span", {}, el("small", {}, "REGULATORY PACK"), "Not configured"),
    el("span", {}, el("small", {}, "DATA REFRESH"), new Date().toLocaleTimeString()));
  contextBar.scrollLeft = 0;
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
    wrap.replaceChildren(
      el("div", { class: "module-page-heading" }, el("span", { class: "eyebrow" }, "TAAD · ASSESSMENT WORKSPACE"), el("h2", {}, ctx.a.ai_system_name),
        el("p", {}, "Work through the assigned sections, save evidence-backed answers, and submit when required questions are complete."), el("span", { class: `tag ${frozen ? "ok" : "medium"}` }, ctx.a.status)),
      el("div", { class: "module-panel assessment-progress" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "QUESTIONNAIRE PROGRESS"), el("h3", {}, `${p.required_answered} of ${p.required_total} required answers`)), el("strong", {}, `${p.required_total ? Math.round(p.required_answered / p.required_total * 100) : 0}%`)), el("progress", { id: "pg", max: p.required_total || 1, value: p.required_answered })),
      scopeBar(ctx, draw),
      state.me.roles.some((role) => ["customer_admin", "customer_architect"].includes(role)) ? assignmentPanel(ctx, sections, draw) : "",
      el("div", { class: "layout" },
        el("nav", { class: "sections", "aria-label": "Sections" }, sections.map((s) => el("button", { "aria-current": s === ctx.section, onclick: () => { ctx.section = s; draw(); } }, s))),
        el("div", {}, qs.filter((q) => q.section === ctx.section).map((q) => questionCard(ctx, q, frozen, draw)))),
      evidencePanel(ctx, draw),
      !frozen && !state.me.is_staff ? submitPanel(ctx, draw) : "",
      await reportsPanel(ctx, draw));
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

function questionCard(ctx, q, frozen, draw) {
  const key = `${ctx.scopeId}|${q.question_id}`, cur = ctx.answers[key];
  const id = `q-${q.question_id}`, status = el("span", { class: "help", id: `${id}-s` }, cur ? `Saved (rev ${cur.revision})` : "Not answered");
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
      ctx.answers[key] = data; status.textContent = `Saved (rev ${data.revision})`; say(`Saved ${q.question_id}`);
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
  return el("div", { class: "card" },
    el("label", { for: id }, q.question, el("span", { class: "tag" }, q.required === "yes" ? "Required" : "Conditional"), el("span", { class: "tag" }, q.question_id)),
    q.guidance ? el("div", { class: "help" }, q.guidance) : "", input,
    el("div", { class: "row" }, el("label", { for: `${id}-u` }, unknown, " Unknown"), q.evidence_request ? el("span", { class: "help" }, `Evidence: ${q.evidence_request}`) : ""),
    ctx.evidence.some((e) => e.state === "clean") ? ev : "", status, swaskaDrawer);
}

function evidencePanel(ctx, draw) {
  const list = ctx.evidence.map((e) => el("li", {}, `${e.filename} - `, el("span", { class: `tag ${e.state === "clean" ? "ok" : "high"}` }, e.state), e.injection_flagged ? el("span", { class: "tag medium" }, "instruction-like text flagged") : ""));
  const f = el("input", { type: "file", id: "ef", accept: ".pdf,.txt,.csv,.json,.docx,.xlsx" });
  return el("section", { class: "card" }, el("h3", {}, "Evidence (quarantined and scanned before use)"), list.length ? el("ul", {}, list) : el("p", { class: "help" }, "No files uploaded."),
    el("label", { for: "ef" }, "Upload a document"), f,
    el("p", {}, el("button", { onclick: safe(async () => {
      const file = f.files[0]; if (!file) return toast("Choose a file first", true);
      const buf = await file.arrayBuffer();
      const g = await api(`/v1/assessments/${ctx.aid}/evidence/upload-url`, { method: "POST", body: { filename: file.name, content_type: file.type || "application/octet-stream", file_size_bytes: file.size, claimed_sha256: await sha256Hex(buf) } });
      const r = await api(g.upload_url, { method: "PUT", body: buf, headers: { "Content-Type": "application/octet-stream" } });
      toast(r.state === "clean" ? "Uploaded and scanned: clean" : `Upload ${r.state}: ${r.reason}`, r.state !== "clean"); draw();
    }) }, "Upload")));
}

function submitPanel(ctx, draw) {
  const p = ctx.a.progress, ready = p.required_answered >= p.required_total;
  return el("section", { class: "card" }, el("h3", {}, "Submit for diagnosis"), el("p", { class: "help" }, "Submitting freezes your answers. This cannot be undone."),
    el("button", { disabled: !ready, onclick: safe(async () => { if (!confirm("Submit and freeze all answers?")) return; await api(`/v1/assessments/${ctx.aid}/submit`, { method: "POST", idem: true }); toast("Submitted"); draw(); }) }, ready ? "Submit" : `Answer ${p.required_total - p.required_answered} more required question(s)`));
}

async function reportsPanel(ctx, draw) {
  const { items } = await api(`/v1/assessments/${ctx.aid}/reports`);
  const staff = state.me.is_staff;
  const kids = [el("h3", {}, "Reports")];
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
  const isBedrock = overview.agent_mode === "bedrock_configured";
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
      const statusLabel = ({ completed: "Completed", routed: "Sent for review", no_action: "No action", failed: "Failed", evidence_manifest_created: "Recorded" })[step.status] || step.status.replaceAll("_", " ");
      const specifics = [rec.rationale || rec.explanation || rec.summary,
        rec.selected_invoice_id ? `Selected invoice ${rec.selected_invoice_id}.` : "",
        step.candidate_ids?.length ? `Candidate invoices: ${step.candidate_ids.join(", ")}.` : "",
        step.classification || step.reason_code ? `Decision: ${(step.classification || step.reason_code).replaceAll("_", " ")}.` : ""]
        .filter(Boolean).join(" ");
      const fallback = ({ intake: "Payment details were validated for this workflow.",
        cash_allocation: "No allocation was proposed for this run.", exception: "This case was routed for human review.",
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
      actions.push(el("section", { class: "card" }, el("h3", {}, "Controller approval"),
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
  const page = el("div", { class: "trustops-page" },
    el("section", { class: "trustops-hero" }, el("div", {}, el("span", { class: "eyebrow" }, "CLOUDSEALS · TRUSTOPS CORE"),
      el("h2", {}, "LedgerSight AR / Cash"), el("p", {}, "Governed cash application with a traceable decision at every step.")),
      el("div", { class: "hero-badges" }, el("span", { class: "environment-pill" }, isSandbox ? "SANDBOX ENVIRONMENT" : "RUNTIME UNAVAILABLE"),
        el("span", { class: "pack-pill" }, `${overview.workflow_pack} · v${overview.workflow_version}`))),
    el("section", { class: `runtime-notice ${isSandbox ? "notice-sandbox" : "notice-unavailable"}`, role: "status" },
      el("span", { class: "notice-mark", "aria-hidden": "true" }, "i"),
      el("p", {}, isSandbox ? (overview.agent_mode === "bedrock_configured"
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
    moduleCard("Reconciliation", "Inspect receipt matches, allocation proposals and policy outcomes.", "LIVE RUN DATA", "reconciliation"),
    moduleCard("Exceptions", "Review ambiguous matches, escalations and rejected workflow actions.", "LIVE RUN DATA", "exceptions"),
    moduleCard("Approvals", "Handle controller decisions with maker-checker separation.", "ROLE-GATED", "approvals"),
    moduleCard("Evidence Fabric", "Review run evidence and verify the local integrity chain.", "LOCAL HASH CHAIN", "evidence"),
    moduleCard("Readiness", "Track assessment completion and reviewer-approved reports.", "ASSESSMENT STATUS", "readiness"),
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
    return el("article", { class: "approval-card" }, el("div", {}, el("span", { class: "eyebrow" }, "PENDING CONTROLLER REVIEW"), el("h3", {}, run.receipt_id),
      el("p", {}, `${run.currency} ${(run.amount_minor / 100).toFixed(2)} · ${run.policy_decision?.reason_code || "Approval required"}`), openRunLink(run)),
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
  const overview = await api("/v1/agentops");
  main.replaceChildren(moduleFrame("ADMINISTRATION · AGENT REGISTRY", "Agents", "Registered specialists, their responsibilities and their permitted authority.",
    el("section", { class: "module-card-grid agent-registry-grid" }, overview.agents.map((agent, index) => el("article", { class: "module-panel" },
      el("span", { class: "module-card-status" }, `AGENT ${String(index + 1).padStart(2, "0")} · v${agent.version}`),
      el("h3", {}, agent.id.split(".").at(-1).replaceAll("_", " ")), el("p", {}, agent.purpose),
      el("div", { class: "permission-list" }, agent.authority.map((permission) => el("span", { class: "permission-chip" }, permission))))))));
};

routes.models = async () => {
  const overview = await api("/v1/agentops");
  const configured = overview.agent_mode === "bedrock_configured";
  main.replaceChildren(moduleFrame("ADMINISTRATION · MODEL ROUTING", "Models", "Model reasoning is advisory; deterministic policy controls action authority.",
    el("section", { class: "module-card-grid" }, moduleCard(configured ? "Amazon Bedrock" : "Deterministic reference mode",
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
  const kids = [findingsTable(items, adjust)];
  if (state.me.roles.includes("cloudseals_reviewer") && !published) kids.push(el("label", { for: reason.id }, "Reviewer reason"), reason,
    el("div", { class: "row" }, el("button", { onclick: decide("approve") }, "Approve & publish"), el("button", { class: "secondary", onclick: decide("request_clarification") }, "Request clarification"), el("button", { class: "danger", onclick: decide("reject") }, "Reject")));
  if (published && state.me.roles.some((x) => ["cloudseals_admin", "cloudseals_assessor"].includes(x))) kids.push(blueprintForm(ctx, r));
  return el("div", {}, kids);
}

function blueprintForm(ctx, r) {
  const f = el("form", { onsubmit: safe(async (e) => { e.preventDefault(); const d = new FormData(f);
    const bp = await api(`/v1/assessments/${ctx.aid}/poc-blueprints`, { method: "POST", idem: true, body: { report_id: r.report_id, workflow_pack_id: d.get("wp"), customer_security_signoff_ref: d.get("cs"), cloudseals_architect_signoff_ref: d.get("ca") } });
    toast(`Draft blueprint ${bp.blueprint_id.slice(0, 8)} created (runtime blocked)`); }) },
  el("h3", {}, "Draft POC blueprint"), el("p", { class: "help" }, "Draft only. Runtime activation and credentials need a separate approval."),
  el("label", { for: "wp" }, "Workflow pack ID"), el("input", { id: "wp", name: "wp", required: true }),
  el("label", { for: "cs" }, "Customer security sign-off ref"), el("input", { id: "cs", name: "cs" }),
  el("label", { for: "ca" }, "CloudSeals architect sign-off ref"), el("input", { id: "ca", name: "ca" }), el("p", {}, el("button", {}, "Create draft blueprint")));
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
  const { items } = await api("/v1/admin/activity");
  const rows = items.map((a) => el("tr", {}, el("td", {}, new Date(a.at * 1000).toLocaleString()), el("td", {}, a.sub), el("td", {}, a.action), el("td", {}, a.ref)));
  const content = items.length
    ? el("div", { class: "table-wrap" }, el("table", { class: "module-table" },
      el("thead", {}, el("tr", {}, ["When", "Who", "Action", "Reference"].map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows)))
    : el("p", { class: "empty-state" }, "No activity has been recorded.");
  main.replaceChildren(moduleFrame("CLOUDSEALS · AUDIT", "Activity", "Administrative and assessment events recorded by this environment.",
    el("section", { class: "module-panel" }, el("div", { class: "module-panel-heading" }, el("div", {}, el("span", { class: "eyebrow" }, "RECENT EVENTS"), el("h3", {}, `${items.length} events`))), content)));
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
