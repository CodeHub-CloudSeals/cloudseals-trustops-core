# CloudSeals TrustOps

> **Status:** live in the DEV environment profile at <https://trustops.cloudseals.com> (GCP project `trustops-uat`, Cloud Run, europe-west1). Not production-ready yet; see [Known limits](#known-limits).

TrustOps helps CloudSeals and its customers **find out how safely their AI systems are built and run, fix what is wrong, and then run AI workflows under control, with proof of every decision.**

It has two halves that share one web app, one API and one audit trail:

| Half | What it does | Who uses it |
|---|---|---|
| **TAAD** (Architecture Diagnosis) | Reads a customer's documents and questionnaire answers, lists their AI use cases, compares them with regulatory frameworks, scores governance maturity, plans the remediation and produces a report. Every AI-produced item is a *draft* until a CloudSeals reviewer validates it. | Customers (answer and upload), CloudSeals reviewers and architects (validate and deliver) |
| **TrustOps Core runtime** | Runs governed agent workflows (today: LedgerSight AR / Cash, a payment-matching workflow) where agents may only *recommend*, a deterministic policy gate decides, a *different* person must approve high-value actions, and every step is recorded in a tamper-evident, signed evidence chain. | Customer finance and risk teams |

Nothing the AI produces is ever saved as an answer, approval, finding or published report by itself.

---

## Contents
1. [What you can do in the product](#what-you-can-do-in-the-product)
2. [The agents](#the-agents)
3. [How the diagnostic pipeline works](#how-the-diagnostic-pipeline-works)
4. [Safety rules built into the code](#safety-rules-built-into-the-code)
5. [Architecture](#architecture)
6. [Repository layout](#repository-layout)
7. [Run it locally](#run-it-locally)
8. [Tests](#tests)
9. [Deploy to GCP](#deploy-to-gcp)
10. [Configuration](#configuration)
11. [Roles and access](#roles-and-access)
12. [Known limits](#known-limits)
13. [More documentation](#more-documentation)

---

## What you can do in the product

| Page | Purpose |
|---|---|
| **Command Center** | Customer home: assessments, workflow runs, approvals waiting. |
| **Diagnosis** | The versioned questionnaire (318 questions, adapts to industry and AI type), evidence upload, submit, reviewed reports. |
| **Use cases** (*Diagnostic studio*) | Documents → AI use cases → framework gaps → maturity → roadmap → architecture → report. Reviewers validate each step. |
| **Cases** (staff) | One case per customer engagement: assigned architects, linked assessments and documents, status history, activity. A case can only be *delivered* when a linked assessment has a FINAL report. |
| **TrustOps** | Governed workflows (LedgerSight AR / Cash) with the six-agent trace, policy decision, approval and sandbox execution. Hub strip links to every other tool. |
| **Agent Flow** | Press Run and watch the agents hand work to each other, step by step, with their real output. |
| **Approvals** | Customer controllers approve or reject high-value runs (maker-checker). |
| **Frameworks** | Read-only library: EU AI Act, ISO 42001, NIST AI RMF, SR 11-7, FDA SaMD (80 requirements, 183 controls, *pending legal review*). |
| **Administration** (staff) | Users, Customer workspaces (read-only view of any customer), Audit logs (filter, page, CSV export), Service health (live model/KMS/scanner probes), Registrations, Agents, Models, Policies. |

## The agents

17 agents. Ten are **advisory** (they suggest, a human decides), one interviews, six run the governed workflow.

| Group | Agents |
|---|---|
| **Interview** | `swaska.diagnostic_interviewer`: asks one clarifying question about a questionnaire item and suggests evidence. Read-only. |
| **Document work** | `swaska.evidence_extractor` (candidate answers from evidence), `trustops.inventory_agent` (AI use cases from PDF/Word/text, each backed by a verbatim quote). |
| **Analysis** | `trustops.gap_analysis_agent` (use cases × framework requirements), `swaska.findings_summarizer`, `trustops.maturity_scorer` (5 principles, 1–5), `trustops.roadmap_agent` (prioritised plan), `trustops.architecture_overlay` (current vs target architecture). |
| **Writing** | `swaska.poc_drafter` (scope notes for a POC blueprint), `trustops.report_writer` (optional executive narrative), `trustops.approval_summarizer` (summary for the approver). |
| **LedgerSight runtime (6)** | `ledgersight.intake`, `.match`, `.reconciliation`, `.cash_allocation`, `.exception`, `.audit`. Bounded workers; the policy gate, not the model, decides. |

Manifests (what each agent may and may not do) are in [taad_agent_manifests_v1.json](taad_agent_manifests_v1.json) and [taad_swaska_agent_manifest_v1.json](taad_swaska_agent_manifest_v1.json).

Every agent works **without a model** where that makes sense (deterministic fallback). The document-reading agents (inventory, gap, maturity, roadmap, overlay, narrative) need one and say so plainly if none is configured.

## How the diagnostic pipeline works

```
 customer documents ──► 1 Inventory ──► 2 Gap analysis ──► 3 Maturity ──► 4 Roadmap ──► 5 Report
 (PDF, Word, text)       AI use cases     vs 5 frameworks    5 principles    prioritised     HTML, validated
                         + quotes         + control IDs      + evidence      + owners        items only
                                                                              ▲
                                                          optional: architecture overlay (current vs target diagrams)

 Each step: model drafts (UNREVIEWED) ──► CloudSeals reviewer VALIDATES or REJECTS with a reason ──► next step unlocks
```

* A step is locked until the one before it has validated material.
* Re-running an agent replaces only its unreviewed output; validated items are kept.
* The report contains only validated items and is marked **DRAFT** until use cases, maturity and roadmap are all validated.
* Customers see their own use cases; gaps, maturity, roadmap and the report stay with CloudSeals until reviewed.

## Safety rules built into the code

These are enforced in code and covered by tests, not just stated in prompts.

* **Advisory only.** Agents have no tools that write answers, approvals, findings or reports; their tool allow-lists are checked.
* **Grounding.** A use case is dropped unless it quotes the document verbatim. A gap must cite a real requirement/control ID and a real use case. Roadmap items must reference real gaps. Architecture nodes without evidence are drawn as *unknown* (dashed).
* **No arithmetic from the model.** Overall maturity, roadmap totals, "critical gaps go in the first 90 days" and dependency cycles are computed or enforced in code. A maturity score of 3 or more with no cited evidence is capped at 2.
* **No compliance claims.** Text claiming "compliant", "verified" or "certified" is rejected or replaced.
* **Untrusted input.** Documents and tool output are wrapped as data; instruction-like text is flagged and never obeyed.
* **Maker-checker.** The person who starts a high-value workflow cannot approve it; only a customer controller can. Staff can *look* at a customer workspace but cannot act as the customer.
* **Signed evidence.** Each runtime evidence record is hash-chained and signed with Cloud KMS; if signing fails the action is not recorded.
* **Malware scanning.** With ClamAV configured every upload is scanned; if the scanner is down the upload is rejected.
* **Tenant isolation.** Another customer's resources look like they do not exist (404). Roles and tenant come from server-side membership, never from the token.
* **Web hardening.** Strict Content-Security-Policy (no inline scripts or styles), escaped output everywhere, CSV export neutralises spreadsheet formulas, rate-limited agent endpoints.

## Architecture

```
 Browser ──► Cloud Run (one container: FastAPI API + static portal)
               │   sign-in: Google ID token, verified server-side
               ├─► GCS state bucket      single JSON snapshot, optimistic locking, versioned
               ├─► GCS evidence bucket   uploaded documents, private
               ├─► Cloud KMS             signs runtime evidence records (EC P-256)
               ├─► Vertex AI (Gemini)    optional; any model failure degrades or fails closed
               └─► ClamAV sidecar        optional; malware scanning of uploads
```

* **API** [apps/assessment-api/app/main.py](apps/assessment-api/app/main.py), FastAPI, about 80 API endpoints. Pydantic validates every input.
* **Portal** [apps/portal-web](apps/portal-web): dependency-free ES modules, no framework, no build step. All dynamic text goes through `textContent`.
* **State** is a write-through snapshot (`persist.py`): GCS (current deployment), PostgreSQL or SQLite. It supports exactly one writer; see [Known limits](#known-limits).
* **Also supported:** AWS (Terraform in `infra/terraform`, Cognito sign-in, Bedrock, S3 + GuardDuty). See [docs/AWS_DEPLOYMENT.md](docs/AWS_DEPLOYMENT.md).

## Repository layout

```
apps/assessment-api/app/      the API
  main.py                     all endpoints and web hardening
  taad_agents.py              advisory agent registry, manifests, extraction/summaries
  use_cases.py                inventory + gap analysis agents, framework library, document text
  studio.py                   maturity, roadmap, architecture overlay, diagnostic report
  swaska.py / trustops_runtime.py   interviewer; governed six-agent workflow runtime
  llm.py  kms.py  scanner.py  Vertex client; Cloud KMS signer; ClamAV client
  security.py  persist.py  evidence.py  admin_bootstrap.py  store.py  seed.py
apps/portal-web/              the web app (index.html, app.js, styles.css)
packages/question-engine/     versioned question registry, branching, deterministic risk rules
packages/reporting/           questionnaire report composer (DOCX/PDF/JSON with provenance links)
packs/frameworks/             the five framework definitions (JSON)
packs/workflows/              governed workflow packs (ledgersight.ar_cash)
taad_*.json / .yaml           question registry, agent manifests, API and integration contracts
infra/gcp/                    setup.sh (one-command GCP deploy), bootstrap-admin.sh
infra/terraform/              AWS infrastructure
cloudbuild.yaml  Dockerfile   build, test, deploy pipeline and container image
tests/                        unit/API, security, contracts, e2e, browser (Playwright)
scripts/                      demo.py, run_agents.py
docs/                         deployment, security, runtime and goal documents
```

## Run it locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/playwright install chromium        # only for the browser tests

# seeded local mode: dev sign-in as demo users, no cloud services needed
TAAD_SEED=1 PYTHONPATH=packages/question-engine:packages/reporting:apps/assessment-api:. \
  .venv/bin/python -m uvicorn app.main:app --app-dir apps/assessment-api --port 8000
# open http://localhost:8000/portal/   (signs you in as a demo customer admin)
```

Demo users (`/v1/dev/users` in local mode): `admin@t-bank` (customer admin), `controller@t-bank` (customer controller), `architect@cloudseals` (CloudSeals admin + assessor), `reviewer@cloudseals` (reviewer). Switch user by setting `sessionStorage.taad_token` to a token from `/v1/dev/users`.

Without a model the document-reading agents report "model required". To see them work locally, run the browser-test server, which plugs in a scripted stand-in model: `python tests/browser/serve.py 8010`.

`make agents` runs the agents that need no model (interviewer, extractor, summarisers, drafter and the six workflow workers) end to end against the real code. `make demo` prints a narrated customer walkthrough.

## Tests

```bash
make test                       # 170 unit/API/security/contract tests (about 6 s)
make browser                    # 63 Playwright tests against a real server (about 50 s)
make lint typecheck             # ruff, mypy
DEPLOYED_URL=https://trustops.cloudseals.com \
  .venv/bin/python -m pytest tests/browser/test_deployed_smoke.py    # 18 checks against a live site
```

The browser suite drives every page as the relevant role, including the full reviewer pipeline to a downloaded FINAL report, maker-checker approvals, evidence upload, accessibility names on every page and layout at 390, 1440 and 2000 px. Signing in with Google cannot be automated, so the deployed smoke test covers everything reachable without a session, including that the sign-in button really starts a Google OAuth flow.

## Deploy to GCP

One idempotent script provisions buckets, the KMS key, service accounts and IAM, then runs Cloud Build (tests, image, push, deploy, health check). Full guide: [docs/GCP_DEPLOYMENT.md](docs/GCP_DEPLOYMENT.md).

```bash
export PROJECT_ID=trustops-uat REGION=europe-west1
export GOOGLE_CLIENT_ID=<oauth client id> GOOGLE_SECRET=<secret name in Secret Manager>
export FIRST_ADMIN_EMAIL=you@cloudseals.co.uk
export LLM_PROVIDER=vertex CLAMAV=true       # optional: Gemini and malware scanning
./infra/gcp/setup.sh
```

The first verified Google sign-in with `FIRST_ADMIN_EMAIL` becomes the **owner** (every CloudSeals role). Add everyone else under *Administration → Users*.

## Configuration

| Variable | Meaning |
|---|---|
| `TAAD_ENV` | `local`, `dev`, `staging`, `prod`. `local`/`dev` enable the sandbox workflow runtime; `prod` disables it and the API docs. |
| `TAAD_AUTH_MODE`, `TAAD_AUTH_PROVIDER` | `dev` (local demo tokens) or `oidc`; provider `google` for Google ID tokens. |
| `TAAD_GOOGLE_CLIENT_ID`, `TAAD_GOOGLE_CLIENT_SECRET`, `TAAD_PORTAL_REDIRECT_URI` | Google OAuth client and the exact redirect URI. |
| `TAAD_FIRST_ADMIN_EMAIL`, `TAAD_STAFF_EMAIL_DOMAINS` | One-time owner bootstrap; email domains allowed to hold CloudSeals roles (`;` separated). |
| `TAAD_STATE_GCS_URI` / `TAAD_DATABASE_URL` / `TAAD_DB` | Where state is stored: `gs://bucket/state.json`, a PostgreSQL URL, or a SQLite path. |
| `TAAD_OBJECT_BACKEND`, `TAAD_BUCKET_EVID` | Evidence storage (`gcs`, `s3`, or local disk). |
| `TAAD_LLM_PROVIDER`, `TAAD_VERTEX_MODEL`, `TAAD_VERTEX_LOCATION`, `GOOGLE_CLOUD_PROJECT` | Model (`vertex`; Bedrock via `TAAD_SWASKA_MODEL` and `TRUSTOPS_AGENT_MODEL_ID`). Unset = deterministic agents only. |
| `TAAD_KMS_SIGNING_KEY_VERSION` | Cloud KMS key version that signs runtime evidence. |
| `TAAD_CLAMD_HOST` (`TAAD_CLAMD_PORT`) | ClamAV daemon; when set, scanning is mandatory. |
| `TAAD_AGENT_CALLS_PER_MINUTE` | Per-user limit on agent endpoints (default 20). |

## Roles and access

| Role | Can |
|---|---|
| `cloudseals_admin` | Everything staff can do plus Users, Registrations, workspaces, audit. The environment *owner* holds all four CloudSeals roles. |
| `cloudseals_assessor` | Create cases and POC blueprints, run the runtime on a customer's behalf in the sandbox. |
| `cloudseals_reviewer` | Validate or reject every AI draft, publish or reject assessment reports. |
| `cloudseals_platform_ops`, `auditor_readonly` | Audit logs, service health, workspaces (read-only). |
| `customer_admin` / `architect` / `risk` / `contributor` | Answer questionnaires, upload evidence, start workflows, within assigned sections. |
| `customer_controller` | Approve or reject high-value workflow runs (never their own). |

There is deliberately **no "break-glass"** override of maker-checker: staff cannot approve in a customer's place.

## Known limits

* **Single instance.** State is one snapshot with a single writer and the rate limiter is in memory. Scaling out needs a normalised database (a private-network Cloud SQL, or Firestore) and a shared limiter.
* **Sandbox runtime only.** The workflow runtime uses a mock ERP connector and is disabled in `staging`/`prod`. Real connectors and the Core orchestrator are not built.
* **Model access.** Gemini needs the billing account in good standing. Until then the document-reading agents report that a model is required. The model path has been tested with scripted and fake models and the cloud KMS key, not yet with live Gemini.
* **Frameworks are marked `PENDING_LEGAL_REVIEW`.** They are CloudSeals working interpretations, not legal advice or a determination of applicability.
* **Malware scanning** is opt-in (`CLAMAV=true`). Without it only byte-level signature checks run.
* **Dev profile.** The live site runs `TAAD_ENV=dev` (sandbox runtime on, owner bootstrap allowed).

## More documentation

* [docs/UNIFIED_END_GOAL.md](docs/UNIFIED_END_GOAL.md): what was merged from the earlier TrustOps Diagnostic Studio and why.
* [docs/GCP_DEPLOYMENT.md](docs/GCP_DEPLOYMENT.md), [docs/AWS_DEPLOYMENT.md](docs/AWS_DEPLOYMENT.md): deployment guides.
* [docs/TRUSTOPS_CORE_RUNTIME.md](docs/TRUSTOPS_CORE_RUNTIME.md): the governed workflow runtime.
* [docs/SECURITY_AND_LIMITS.md](docs/SECURITY_AND_LIMITS.md): security model.
* [PROJECT_COMPLETION_STATUS.md](PROJECT_COMPLETION_STATUS.md): what is done, what is open.
* [ENGINEERING_README.md](ENGINEERING_README.md), [TAAD_END_GOAL.md](TAAD_END_GOAL.md): original TAAD design handoff.
