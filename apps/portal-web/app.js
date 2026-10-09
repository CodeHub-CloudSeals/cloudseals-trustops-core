// TAAD portal: dependency-free ES module. All dynamic text goes through textContent (no innerHTML).
const $ = (s, r = document) => r.querySelector(s);
const main = $("#main"), nav = $("#nav"), who = $("#who");
const state = { token: sessionStorage.getItem("taad_token"), me: null, cfg: { mode: "oidc", oidc: {} } };

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
  const card = el("section", { class: "card" }, el("h2", {}, "Sign in"));
  if (state.cfg.mode === "oidc") {
    const o = state.cfg.oidc;
    const ready = [o.authorize_url, o.token_url, o.client_id, o.redirect_uri].every(Boolean);
    card.append(el("p", {}, "Sign in with your organisation account."),
      el("button", { disabled: !ready, onclick: safe(oidcLogin) }, "Continue with secure sign-in"),
      ready ? "" : el("p", { class: "help" }, "Organisation sign-in is not configured. Contact your CloudSeals administrator."));
  } else {
    card.append(el("p", { class: "help" }, "Local development only: choose a seeded user."));
    const users = await fetch("/v1/dev/users").then((r) => r.ok ? r.json() : { items: [] });
    if (!users.items.length) card.append(el("p", {}, "No dev users. Start the API with TAAD_SEED=1."));
    for (const u of users.items) card.append(el("div", {}, el("button", { class: "secondary", onclick: () => { state.token = u.token; sessionStorage.setItem("taad_token", u.token); boot(); } }, `${u.sub} (${u.roles.join(", ")})`)));
  }
  main.replaceChildren(card);
}

// ---------- routing ----------
const routes = {};
function go(hash) { location.hash = hash; }
async function render() {
  if (!state.token) return loginView();
  if (!state.me) { try { state.me = await api("/v1/me"); } catch { return logout(); } }
  const staff = state.me.is_staff;
  const links = staff ? [["#/admin", "Dashboard"], ["#/queue", "Review queue"], ["#/registrations", "Registrations"], ["#/activity", "Activity"], ["#/assessments", "Assessments"]]
    : [["#/assessments", "Assessments"], ["#/team", "Team"]];
  nav.replaceChildren(...links.map(([h, t]) => el("a", { class: "btn secondary", href: h }, t)));
  who.replaceChildren(`${state.me.sub} `, el("button", { class: "secondary", onclick: logout }, "Sign out"));
  const [, name, arg] = (location.hash || (staff ? "#/admin" : "#/assessments")).split("/");
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
  const rows = items.map((a) => el("tr", {}, el("td", {}, el("a", { href: `#/assessment/${a.assessment_id}` }, a.ai_system_name)), el("td", {}, a.industry), el("td", {}, el("span", { class: "tag" }, a.status)), el("td", {}, a.questionnaire_version)));
  const form = el("form", { class: "card", onsubmit: safe(async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const a = await api("/v1/assessments", { method: "POST", idem: true, body: { ai_system_name: f.get("name"), industry: f.get("industry"), questionnaire_version: "1.0.0" } });
    go(`#/assessment/${a.assessment_id}`);
  }) }, el("h3", {}, "New assessment"),
  el("label", { for: "nm" }, "AI system name"), el("input", { id: "nm", name: "name", required: true, maxlength: 200 }),
  el("label", { for: "ind" }, "Industry"), el("select", { id: "ind", name: "industry" }, ["banking", "investment", "insurance", "healthcare", "logistics", "industrial", "government", "other"].map((i) => el("option", { value: i }, i))),
  el("p", {}, el("button", {}, "Create assessment")));
  main.replaceChildren(el("h2", {}, "Assessments"), el("div", { class: "card" }, rows.length ? el("table", {}, el("thead", {}, el("tr", {}, ["System", "Industry", "Status", "Questionnaire"].map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows)) : el("p", {}, "No assessments yet.")), canCreate ? form : "");
};

routes.assessment = async (aid) => {
  const a = await api(`/v1/assessments/${aid}`);
  const ctx = { aid, a, scopeType: "org", scopeId: "org", section: null, answers: {}, evidence: [] };
  const wrap = el("div", {});
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
      el("h2", {}, ctx.a.ai_system_name, " ", el("span", { class: "tag" }, ctx.a.status)),
      el("div", { class: "card" }, el("label", { for: "pg" }, `Required answers: ${p.required_answered} of ${p.required_total}`), el("progress", { id: "pg", max: p.required_total || 1, value: p.required_answered })),
      scopeBar(ctx, draw),
      el("div", { class: "layout" },
        el("nav", { class: "sections", "aria-label": "Sections" }, sections.map((s) => el("button", { "aria-current": s === ctx.section, onclick: () => { ctx.section = s; draw(); } }, s))),
        el("div", {}, qs.filter((q) => q.section === ctx.section).map((q) => questionCard(ctx, q, frozen, draw)))),
      evidencePanel(ctx, draw),
      !frozen && !state.me.is_staff ? submitPanel(ctx, draw) : "",
      await reportsPanel(ctx, draw));
  };
  await draw();
};

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
  const ask = el("button", { class: "secondary", type: "button", onclick: safe(async () => {
    const t = await api(`/v1/assessments/${ctx.aid}/swaska/turns`, { method: "POST", body: { scope_id: ctx.scopeId, user_message: "Please clarify this question.", parent_question_id: q.question_id } });
    swaskaOut.replaceChildren(el("strong", {}, "Swaska: "), t.clarification_text, t.needs_evidence ? ` Suggested evidence: ${t.evidence_type}.` : "", ` (${t.uncertainty})`);
  }) }, "Ask Swaska");
  return el("div", { class: "card" },
    el("label", { for: id }, q.question, el("span", { class: "tag" }, q.required === "yes" ? "Required" : "Conditional"), el("span", { class: "tag" }, q.question_id)),
    q.guidance ? el("div", { class: "help" }, q.guidance) : "", input,
    el("div", { class: "row" }, el("label", { for: `${id}-u` }, unknown, " Unknown"), q.evidence_request ? el("span", { class: "help" }, `Evidence: ${q.evidence_request}`) : ""),
    ctx.evidence.some((e) => e.state === "clean") ? ev : "", status, el("div", {}, ask), swaskaOut);
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
  main.replaceChildren(el("h2", {}, "Team"), el("section", { class: "card" }, el("h3", {}, "Invite a colleague"), el("label", { for: "role" }, "Role"), sel,
    el("p", {}, el("button", { onclick: safe(async () => { const r = await api("/v1/tenant/invitations", { method: "POST", body: { role: sel.value } }); out.textContent = r.invitation_token ? `Invitation token (dev only): ${r.invitation_token}` : "Invitation sent."; }) }, "Create invitation")), out),
  el("section", { class: "card" }, el("h3", {}, "Accept an invitation"), el("label", { for: "tok" }, "Invitation token"), el("input", { id: "tok" }),
    el("p", {}, el("button", { class: "secondary", onclick: safe(async () => { await api("/v1/invitations/accept", { method: "POST", body: { token: $("#tok").value } }); state.me = null; toast("Joined"); render(); }) }, "Accept"))));
};

// ---------- staff ----------
routes.admin = async () => {
  const m = await api("/v1/admin/metrics");
  const labels = { registrations: "Registrations", assessments: "Assessments", submitted: "Submitted", review_queue: "In review queue", published_reports: "Published reports", poc_blueprints: "POC blueprints" };
  main.replaceChildren(el("h2", {}, "Portfolio"), el("div", { class: "grid" }, Object.entries(labels).map(([k, l]) => el("div", { class: "card" }, el("div", { class: "metric" }, String(m[k])), el("div", {}, l)))));
};
routes.queue = async () => {
  const { items } = await api("/v1/admin/review-queue");
  main.replaceChildren(el("h2", {}, "Review queue"), el("div", { class: "card" }, items.length ? el("table", {}, el("thead", {}, el("tr", {}, ["Assessment", "Findings", "Status", ""].map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, items.map((i) => el("tr", {}, el("td", {}, i.assessment_id.slice(0, 8)), el("td", {}, String(i.finding_count)), el("td", {}, i.status), el("td", {}, el("a", { href: `#/assessment/${i.assessment_id}` }, "Open")))))) : el("p", {}, "Nothing waiting for review.")));
};
routes.registrations = async () => {
  const { items } = await api("/v1/admin/registrations");
  const act = (r, d) => safe(async () => { const x = await api(`/v1/admin/registrations/${r.registration_id}/decision`, { method: "POST", body: { decision: d, reason: "Portal decision" } }); toast(x.invitation_token ? `Approved. Dev invitation token: ${x.invitation_token}` : `Registration ${x.status}`); render(); });
  main.replaceChildren(el("h2", {}, "Registrations"), el("div", { class: "card" }, items.length ? el("table", {}, el("thead", {}, el("tr", {}, ["Organisation", "Email", "Engagement", "Status", ""].map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, items.map((r) => el("tr", {}, el("td", {}, r.organisation_name), el("td", {}, r.work_email), el("td", {}, r.engagement_verified ? "Verified" : "Not verified"), el("td", {}, r.status),
      el("td", {}, r.status === "pending_approval" ? el("div", { class: "row" }, el("button", { disabled: !r.engagement_verified, onclick: act(r, "approve") }, "Approve"), el("button", { class: "secondary", onclick: act(r, "reject") }, "Reject")) : ""))))) : el("p", {}, "No registrations.")));
};
routes.activity = async () => {
  const { items } = await api("/v1/admin/activity");
  main.replaceChildren(el("h2", {}, "Activity"), el("div", { class: "card" }, el("table", {}, el("thead", {}, el("tr", {}, ["When", "Who", "Action", "Reference"].map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, items.map((a) => el("tr", {}, el("td", {}, new Date(a.at * 1000).toLocaleString()), el("td", {}, a.sub), el("td", {}, a.action), el("td", {}, a.ref)))))));
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
