import { createOfficeWorld } from "./office-world.js";

// Presentation only: status and output come from the existing workflow calls.
// The office never grants approval or executes an agent on its own.
export function createAgentOffice(el) {
  const root = el("section", { class: "agent-office", "aria-label": "AI agents office" });
  let selected = null;
  let snapshot;
  let preview = false;
  let expanded = false;
  root.addEventListener("keydown", e => { if (e.key === "Escape" && expanded) { expanded = false; paint(); } });
  const world = createOfficeWorld(el, i => { selected = i; paint(); });
  const states = { waiting: "Waiting", running: "Running", done: "Completed", skipped: "Skipped", failed: "Failed" };
  function paint() {
    const { nodes, flow, current, running } = snapshot;
    root.classList.toggle("is-immersive", expanded);
    const picked = nodes[selected ?? (current >= 0 ? current : 0)];
    world.update({ ...snapshot, selected: selected ?? (current >= 0 ? current : 0), preview });
    const occupied = nodes.filter(n => n.state === "running").length;
    const complete = nodes.filter(n => n.state === "done").length;
    const blocked = nodes.filter(n => ["failed", "skipped"].includes(n.state)).length;
    const inspector = el("aside", { class: "office-inspector", "aria-label": "Selected agent details" },
      el("div", { class: "office-inspector-heading" }, el("span", { class: "eyebrow" }, "AGENT DETAILS"), el("span", { class: `office-state state-${picked.state}` }, states[picked.state])),
      el("h3", {}, picked.name), el("p", { class: "help" }, picked.does),
      el("div", { class: "office-task" }, el("h4", {}, "Current task"), el("p", {}, picked.state === "running" ? "Request in progress. Waiting for its response." : picked.state === "waiting" ? "Not started in this view." : picked.state === "skipped" ? "This step was not executed." : picked.state === "failed" ? "The request did not complete successfully." : "Step finished. Inspect the returned output below.")),
      el("div", { class: "office-output" }, el("h4", {}, "Returned output"), picked.lines.length ? el("ul", {}, picked.lines.map(line => el("li", {}, line))) : el("p", { class: "help" }, "No output yet. Results appear when the request finishes.")),
      picked.ms !== null ? el("p", { class: "office-timing" }, `Observed request time: ${(picked.ms / 1000).toFixed(1)} s · includes display pacing`) : "",
      el("details", { class: "office-technical" }, el("summary", {}, "Agent identifier"), el("code", {}, picked.id)),
      el("div", { class: "office-approval" }, el("span", { "aria-hidden": "true" }, "◇"), el("div", {}, el("strong", {}, "Human review stays in control"), el("p", {}, "An animation cannot approve a finding or authorise an action. Reviewers use the existing approval workflow."))));
    root.replaceChildren(
      el("div", { class: "office-topline" }, el("div", {}, el("span", { class: "eyebrow" }, "CLOUDSEALS · OPERATIONS FLOOR"), el("h3", {}, "Your AI team, at a glance")),
        el("span", { class: `office-connection${running ? " is-active" : ""}` }, el("i", {}), running ? (flow === "payment" ? "Workflow playback" : "Requests in progress") : nodes.some(n => n.state !== "waiting") ? "Run finished" : "Ready to run")),
      el("div", { class: "office-stats" }, [[nodes.length, "Specialist agents"], [occupied, flow === "payment" ? "Highlighted step" : "Running request"], [complete, "Completed steps"], [blocked, "Skipped / failed"]].map(([value, label]) => el("div", {}, el("strong", {}, String(value)), el("span", {}, label)))),
      el("div", { class: "office-world-toolbar" },
        el("span", { class: "eyebrow" }, preview ? "ANIMATION PREVIEW · NO AGENTS EXECUTED" : "ISOMETRIC TEAM OFFICE"),
        el("div", { class: "row" },
          el("button", { type: "button", class: "secondary", disabled: running, "aria-pressed": String(preview), onclick: () => { preview = !preview; paint(); } }, preview ? "Stop animation preview" : "Preview office animation"),
          el("button", { type: "button", class: "secondary", "aria-pressed": String(expanded), onclick: () => { expanded = !expanded; paint(); } }, expanded ? "Exit office focus" : "Focus office"),
          el("button", { type: "button", class: "secondary", "aria-label": "Zoom office in", onclick: () => world.zoom(.1) }, "+"),
          el("button", { type: "button", class: "secondary", "aria-label": "Zoom office out", onclick: () => world.zoom(-.1) }, "−"))),
      el("div", { class: "office-workspace" }, world.element, inspector),
      el("p", { class: "office-disclosure" }, flow === "payment" ? "WORKFLOW PLAYBACK · The server returns one completed payment trace. Desks replay those results in order; they do not stream intermediate server activity. No real ERP is changed." : "REQUEST STATUS · Each desk follows a separate backend call. Running means the request is pending; outputs come from its response. Missing permissions or prerequisites are shown as skipped. This view does not expose private model reasoning."));
  }
  return { element: root, update(data) { if (snapshot?.flow !== data.flow) selected = null; snapshot = data; if (data.running) preview = false; paint(); } };
}
