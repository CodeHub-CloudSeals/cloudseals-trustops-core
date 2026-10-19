## Website domain input — 19 October 2026

- Website inspection now accepts domain names such as `www.cloudseals.com` and automatically adds HTTPS before submitting. Explicit HTTP(S) links continue to work. The backend applies the same default for direct API callers; unsupported schemes and public-address protections remain unchanged.
- Removed native `type=url` validation that rejected a bare domain before the form submit handler ran. The field retains URL keyboard/autocomplete hints, and displays the normalized address on submission. Added an example and an automatic-HTTPS hint.
- Verification: 29 focused backend cases and three browser scenarios passed, including domain-only form submission, permission validation, attachment persistence, explicit schemes and invalid schemes. Lint, syntax and whitespace checks passed.

## Website URL inspection — 19 October 2026

- Assessment pages expose Website URL and Inspect website, with explicit ownership/permission confirmation. An actual anonymous public HTTP page inspection produces a capture; the UI uploads it through normal evidence safety checks and attaches it to the reviewer-gated LangGraph workflow.
- HTTP evidence is identified separately from REA browser captures. Observations include returned HTML element count, page title/status, script references and selected response headers. No JavaScript, login, chatbot interaction, forms or vulnerability probes are executed. The original HTML is hashed and discarded, queries/fragments and cookies are excluded; failed or oversized inspections produce no success capture/report.
- Every destination/redirect is DNS checked and pinned to a public IP; private/local/metadata/multicast destinations, nonweb schemes, embedded credentials and nonstandard ports are blocked. TLS verification stays enabled; response size, redirect count, socket/deadline budgets and existing per-user request limits apply.
- Verification: 260 backend tests and 85 browser tests passed; separate actual REA capture delivery still passes. Real HTTP inspection of example.org succeeded. A real UI inspection of the owned TrustOps public portal produced 23 HTML elements, one script reference and one recorded request, attached for review in a separate local verification assessment. Existing assessment answers were preserved.
- Released `trustops-ui-00050-mot` at 100% traffic; previous `trustops-ui-00048-zuj` remains available for rollback. Verified the actual revision image digests, model/document startup readiness, unchanged private snapshot generation and public portal asset hashes. Model/auth/storage and warm-instance configuration were preserved. All 20 hosted smoke checks passed, including anonymous inspection denial and the new URL form assets.

## Assessment-only customer workspace — 19 October 2026

This supersedes the workflow-team visibility/customer-navigation choices recorded below.

- Customer navigation now offers four primary pages: Overview, Assessments, Assessment process and Reports. Assessment-related specialists, frameworks and team membership live under Resources. Staff retain role-scoped review and administration tools.
- Removed finance/payment prototype screens, bulk agent execution, duplicate report tabs, finance examples and unrelated operational registries from the portal implementation. Old bookmarks redirect to Overview; backend endpoints, stored records and the complete platform agent registry are preserved.
- Assessment process reads actual evidence, questionnaire and publication status for the selected assessment. The team directory shows only seven assessment specialists and two relevant assistants; registration/configuration is separate from execution.
- Sample guidance and advanced assessment setup are optional disclosures. Mobile navigation wraps so destinations remain reachable without horizontal menu scrolling.
- Verification: 82 local browser scenarios passed across the suite and its corrected read-only workspace assertion; the opt-in actual REA capture upload → reviewer validation → publication → customer report download test also passed. JavaScript syntax, focused lint and diff whitespace checks passed. Seven focused desktop/mobile checks also passed after the final mobile-navigation adjustment.

- Released `trustops-ui-00048-zuj` at 100% traffic, with `trustops-ui-00046-kov` retained for rollback. The startup gates passed; private snapshot generation was unchanged from backup through promotion. Public `index.html`, JavaScript and CSS hashes match tested source. Existing model, authentication, object storage and warm-instance settings were preserved. All 18 post-cutover hosted smoke checks passed.

## Workflow-page team visibility — 19 October 2026

- The workflow page now shows all 17 registered specialists above the execution controls, grouped into seven assessment specialists, four assistants and six payment workers. Previously the full team was visible only on the Agents directory; the workflow page showed only its selected flow.
- Flow tabs now say seven/nine steps, distinguishing the selected workflow from the registered-team total. The roster is backed by `/v1/agents` and does not fabricate execution status or run unrelated agents.
- Verified 12 directory/workflow scenarios, including desktop/mobile visibility; two focused screenshot checks passed. Refreshed the user's existing local TrustOps tab and observed all 17 names. Saved the workflow screenshot in `../outputs/ui-cleanup/workflow-team-1440.png`.
- Released the static portal update on `trustops-ui-00046-kov` at 100% traffic, retaining `trustops-ui-00044-raw` for rollback. Real-model/document startup passed. State generation was unchanged between private backup and cutover. Public JavaScript/CSS hashes match tested source, and all 18 post-cutover hosted smoke checks passed. Backend/model configuration was reused unchanged.

## Customer UI cleanup — 19 October 2026

- Simplified the main menu to Overview, Assessments, Agent workflow, Reports & results, Approvals and Agents. References/team tools sit under Resources; staff see only relevant review/administration links. Removed duplicate approvals/history navigation, empty ROI/readiness and redundant technical registry links from the main menu, plus planned-pack cards and the customer-facing presenter guide. Existing functional routes remain available to their permitted users.
- Added a backend-derived agent directory: seven assessment specialists (including the previously missing interviewer), four supporting assistants and six payment workers. All 17 unique identifiers match existing manifests. Configuration/availability labels are separate from execution results. The application-evidence workflow is described separately and is not counted as an AI agent.
- Empty optional application capture now starts collapsed; existing captures open for review/download. Desktop/mobile layout and first-load favicon errors were corrected. Case-management navigation follows the permitted case roles.
- Verification: 243 backend tests; 67 browser checks in the full suite plus three focused directory/role checks; a separate actual REA capture upload/review/publication/download check. Lint, JavaScript syntax and diff whitespace checks passed. One earlier audit-test timing race was fixed by waiting for its filtered response/list.
- Released `trustops-ui-00044-raw` at 100% traffic after real-model/document startup passed. Retained `trustops-ui-00040-nir` for rollback; source state generation was unchanged from private backup through standby startup/cutover. Model/auth/storage/scanner configuration and the one warm service instance were preserved. All 18 hosted post-release smoke scenarios passed, including three retries after client read timeouts; the retried API requests returned HTTP 401 with 4–6 ms server latency.

## TrustOps UAT release — 19 October 2026

- Released the core reliability/evidence updates at https://trustops.cloudseals.com/portal/. Cloud Run revision `trustops-ui-00040-nir` receives 100% of normal traffic; prior revision `trustops-ui-00036-xr9` is retained for rollback. A private local state backup was taken before cutover. No recent write requests were present in the preceding hour's old-revision request logs.
- Active model: self-hosted Ollama/Qwen3 4B in the existing Google Cloud service. No external model API key is required. The model port remains private; existing Google sign-in, state/object storage and malware-scanner settings were preserved.
- Corrected payment matching instructions and constrained per-call identifiers. Stricter real-model acceptance `57ba65b5-45da-4382-81a8-a3d694b6e731` passed: the positive fixture must select its supplied invoice and reach ALLOW; a generic escalation no longer counts as a pass.
- Verification: 242 backend tests, 65 local browser tests, separate actual-capture desktop/mobile delivery test, 18 tagged hosted smoke checks and 18 public-domain post-release smoke checks passed. The API image build also ran backend tests/lint. Real model document/gap/maturity/roadmap/report acceptance used synthetic inputs; reviewer states in that isolated model test were explicit engineering fixtures.
- Service minimum set to one warm instance for demo availability; the revision maximum remains one and concurrency one. Idle Google Cloud charges apply. CPU inference is slow: the measured inventory/gap/maturity/roadmap calls took approximately 55/145/126/93 seconds in the isolated test. A warm instance does not remove analysis latency.
- Remaining boundaries: authenticated hosted customer/reviewer UAT, broader model-quality/adversarial review, framework legal sign-off, production release controls and a real ERP adapter. Payment execution still uses `mock_sap`; this release does not establish production readiness. Lead-generation work has not started.

## Hosted model verification — 19 October 2026

- Cloud Build `63fd7604-5e69-49b9-b93b-e83a80987e5e` completed 11 real Qwen3 calls on synthetic inputs: document extraction, framework gaps, maturity, roadmap, HTML rendering and six bounded payment recommendations. The original acceptance allowed conservative escalation, so this is connectivity/pipeline evidence, not a payment-quality acceptance.
- The exact-match payment fixture was unnecessarily escalated. Added an explicit matching task, per-call allowlisted identifiers and a stricter positive-case acceptance that requires the correct invoice and ALLOW. Its stricter cloud retest passed; see the release entry above.
- Cloud Run `trustops-ui-00039-kur` passed the real-model/document startup gate. Seventeen hosted API/security smoke checks passed; the sign-in browser check passed on retry after a transient network change. Google account sign-in and authenticated hosted customer UAT remain unverified.
- At this verification point traffic remained on the prior revision; the later UAT cutover is recorded above. No lead outreach or real ERP writes occurred.

## Core reliability verification — 18 October 2026

- Bound new document analyses to the uploaded source SHA-256. Changed bytes are rejected before inference and existing analysis is preserved. Diagnostic publication rechecks source availability/integrity and binds preview digests to source metadata.
- Added server-owned structured-output schemas for self-hosted inventory, framework, maturity, roadmap and six payment-agent calls; independent grounding, policy and review checks remain mandatory.
- Local verification: 242 backend tests and 65 browser tests passed; 19 opt-in browser checks were skipped. A separate real-capture desktop/mobile evidence-review-publication-download test passed on the refreshed local server. Lint, package type checks, dependency consistency and registry checks passed.
- The first self-hosted revision failed startup; the corrected revision passed. See the newer hosted verification entry above for pipeline and payment-quality results. Lead-generation work has not started.

## Application evidence delivery update — 18 October 2026

- Added the optional client-side REA collector and assessment evidence panel. A real owned-app CDP capture recorded 35 DOM nodes, one script and three HTTP requests.
- Integrated a LangGraph workflow with durable JSON checkpoints in the existing single-writer inventory snapshot; reviewer validation/rejection and publication remain explicit, role-gated operations.
- Published HTML technical reports preserve source references, unknowns and next actions; customer downloads are immutable and appear in the report library. No model inference or automatic compliance conclusions are used for metadata analysis.
- Verification: 237 backend tests, nine focused feature scenarios, and one actual-capture desktop/mobile browser delivery test passed. Completed the local development-role rehearsal; this is not customer sign-off or hosted production UAT. The new feature is not deployed to the public domain. See docs/APPLICATION_EVIDENCE.md.

## Backend verification update — 18 October 2026

- Added server-side OpenAI Responses support for document and payment model calls; credentials are not exposed to the portal. Live activation remains pending an API key and successful synthetic/document verification.
- Fixed analysis failures that could return success and clear previous unreviewed candidates. Unavailable/failed analyses now return 503/502 and preserve saved work. Partial inventory batches replace only fully successful documents.
- Added the tenant-scoped report library for published questionnaire and document-analysis results. UI analysis actions recover after errors so users can retry.
- Backend/security/contract suite: 209 tests passed. Existing Google login now refreshes, but a new real Vertex call still returns HTTP 403 billing hold. The live OpenAI/document pipeline and real ERP integration are not verified. See docs/MODEL_CONNECTIONS.md.

# TAAD project completion status

## Customer diagnostic delivery milestone (2026-10-11)

- Added explicit reviewer/admin publication of a diagnostic report and improvement roadmap to the customer's portal, with a required final review reason and a preview digest check.
- Released versions preserve the reviewed material and exact HTML in the existing durable inventory state. Later review changes affect only working material; customers can download published versions. Duplicate publication is idempotent.
- Publication checks clean source evidence, reviewed references/dependencies and roadmap coverage for critical/high gaps. A staff case cannot be marked delivered until a linked report is published.
- Verified locally: 173 backend/security/contract tests, lint, existing package type checks and registry validation. A synthetic sample completed the pipeline with the test-only scripted model; it does not demonstrate live Gemini analysis or a real customer sign-off.
- A fresh synthetic Vertex probe on 2026-10-11 still returned HTTP 403, `Lightning dunning decision is deny`. Cloud billing must be restored by the account owner before real model-backed document analysis can be accepted. No billing/payment settings were changed.


**Status: live at https://trustops.cloudseals.com (GCP `trustops-uat`, Cloud Run service `trustops-ui`, europe-west1) in the DEV environment profile, using the verified self-hosted model route. Not production-ready: authenticated hosted UAT, broader model-quality review, multi-writer storage, real ERP and framework legal review remain open. Vertex remains unavailable as an alternate provider.** The customer-call rehearsal and local engineering foundation are ready. A six-agent deterministic LedgerSight sandbox runtime is now implemented, but AWS DEV deployment, hosted UAT, and the production release gates in `TAAD_END_GOAL.md` remain open.

## Completed in this workspace

- Copied the handoff into `outputs/taad-project/`; the supplied Downloads copy remains untouched.
- Fixed the portal answer-save behavior so progress and submit eligibility update after each save; the earlier manual browser check completed a 3-question flow and unlocked Submit at 3/3.
- Replaced the deprecated FastAPI startup event with a lifespan handler.
- Added fail-closed GuardDuty status handling: only `NO_THREATS_FOUND` promotes an AWS object to citable evidence; threat results become infected, and failed/unsupported/denied scans are rejected. The API reads the tag on upload and evidence-list refresh. This follows [AWS's documented scan-result tags](https://docs.aws.amazon.com/guardduty/latest/ug/monitoring-malware-protection-s3-scans-gdu.html).
- Wired the deployed portal to runtime Cognito settings: production mode fails closed to OIDC, authorization-code + PKCE, and Cognito logout; local seeded-user login is available only for explicitly local/dev mode. The API exposes only the configured Cognito URLs, and CSP allows the configured token endpoint origin. Cognito MFA and invitation-only user creation are defined in Terraform.
- Added a one-time Cognito first-admin bootstrap command. It requires dev + OIDC + durable DB, confirms the Cognito account/email, records an immutable bootstrap marker, and refuses a second bootstrap. Terraform scopes `AdminGetUser` to the pool.
- Implemented the six LedgerSight runtime agents (Intake, Match, Reconciliation, Cash Allocation, Exception, Audit) as deterministic, bounded local/dev sandbox workers; added policy escalation, maker-checker approval, payload-bound short-lived action tokens, idempotent mock SAP execution, and local evidence PRE-COMMIT/COMMIT hash-chain verification. The runtime is deliberately disabled in staging/prod and has no real ERP connector.
- Added four bounded advisory agents (Evidence Extractor, Findings Summarizer, POC Drafter, Approval Summarizer; manifests in `taad_agent_manifests_v1.json`, code in `app/taad_agents.py`, endpoints `/v1/agents`, `/agents/extraction`, `/agents/findings-summary`, `/draft-notes`, `/runs/{id}/approval-summary`). Deterministic first; optional model output is schema- and grounding-checked with fallback. Read-only: nothing is persisted as an answer, finding or approval. Portal buttons added (evidence panel, reviewer panel, blueprint form, approvals, Administration → Agents); rate-limited per user.
- Added the authenticated TrustOps portal page: it lists all six agents, clearly labels the sandbox boundary, accepts a sample/editable workflow payload, shows tenant-scoped recent runs and per-agent traces, and exposes role-gated approval, prepare, mock-execute, and evidence-verification actions.
- Expanded the portal to a handoff-aligned workspace: Command Center, Diagnosis, Reconciliation, Exceptions, Approvals, Evidence, Readiness, Shadow ROI, plus administration views for Integrations, Datasets, Workflows, Agents, Models, Policies, Authority, Approval Matrix, AgentOps and Tenant Settings. Existing API-backed views show live tenant data; capabilities without a supporting backend remain visibly read-only or not configured, with no fabricated ROI, telemetry, production connectors or regulatory-compliance claims.
- Applied the supplied CloudSeals SVG logo to the engineering portal and call demo; the demo `/logo.svg` endpoint returned HTTP 200 with `image/svg+xml`.
- Reconciled the local registry checks: 318 questions, 66 controls, 18 risk rules; registry validation passes.
- Created `TAAD_END_GOAL.md` and the deployment/call checklist.

## Verification just completed

- Python 3.12.14 environment created in this working copy from `requirements-dev.txt`.
- `ruff check .`: pass.
- `mypy --ignore-missing-imports packages/question-engine/question_engine packages/reporting/reporting`: pass.
- Backend, contract, adversarial, security, persistence, auth-config, integration, and TrustOps runtime tests: **98 passed** (`pytest --ignore=tests/browser`).
- Registry validation: pass; bank and healthcare branch fixtures pass.
- Terraform 1.16.5 formatting passes. Dev, staging, and prod configurations validated before the latest OIDC environment additions; revalidation after those additions could not reach `registry.terraform.io` because DNS resolution failed in the shell environment. The official archive checksum matched HashiCorp's published SHA-256 list; see [HashiCorp's archive verification guide](https://developer.hashicorp.com/terraform/tutorials/cli/verify-archive).
- Manual browser verification: opened the local customer workspace directly; verified Command Center, Reconciliation, Exceptions, Approvals, Evidence verification and Readiness views, and the existing six-agent sandbox trace. The browser is on the Command Center.
- Manual browser verification: Command Center, Reconciliation, Exceptions, Approvals, Evidence verification and Readiness views load in the local customer workspace; the direct local entry flow remains login-screen free. Browser coverage now includes the expanded customer and administration routes.
- Automated browser suite: unable to start in this sandbox because its fixture cannot bind an ephemeral localhost socket (`PermissionError: Operation not permitted`). Browser tests now cover local direct entry, customer operations modules, public registration, and admin registry views; manual in-app-browser checks verified the customer modules.
- Demo Lambda ZIP and project ZIP have been rebuilt; the Lambda handler's logo route was directly tested.

## Still open before the project can be called complete

1. **AWS DEV deploy and hosted UAT:** AWS CLI, Docker engine, AWS profile/credentials and AWS account configuration are absent here. Terraform `validate` is not a real-account plan. The actual project deployment, cost review, apply, image push, hosted health/browser checks and cleanup rehearsal have not happened.
2. **Owner-supplied deployment values:** approved AWS account/profile and region, valid portal URL/domain, alert email, GitHub repository for OIDC and remote-state bucket/lock table. Never paste AWS secrets into chat.
3. **Run first-admin bootstrap in AWS:** code and scoped policy exist, but the bootstrap has not been executed against a real Cognito pool/database or verified in hosted UAT.
4. **Invitation delivery:** SES is permissioned in the design, but tenant invitations are not sent. The outbox is persisted with the current snapshot, but no SES dispatcher/retry/delivery verification exists.
5. **Durable async workflows:** assessment diagnosis and the new LedgerSight runtime still run inline. SQS, EventBridge Pipe and Step Functions exist as scaffolding; there is no production worker, status/retry/DLQ recovery flow.
6. **Multi-writer database safety:** current persistence is a single-writer whole-state snapshot. Do not scale beyond one API task. The normalized schema/RLS migration remains draft and untested.
7. **Real model and evidence UAT:** Six Bedrock-backed specialist calls are now implemented with structured schemas, allowlisted input, deterministic policy authority, and fail-closed handling. They have only been tested with a fake model client; no Bedrock model ID/account has been configured or verified. GuardDuty tag logic passes mocked tests but has not been tested in the target AWS account. The runtime evidence chain is local SHA-256 only; KMS signing and immutable storage are not wired. Data/residency and adversarial review remain open.
8. **Release acceptance:** reconcile the 316/318 narrative count in the TDD; obtain engineering/CISO, risk/methodology, sector, legal/privacy and retention sign-offs; complete independent penetration/security review, restore/recovery exercise, and agreed cross-browser/accessibility testing.
9. **TrustOps Core production integration:** the six-agent sandbox is embedded in the TAAD API because the existing Core repository/service is not part of this handoff. Move it behind the Core orchestrator and separate worker, replace the illustrative value threshold with approved tenant Workflow Pack policy, integrate the real approval/authority service, KMS-signed Evidence Fabric and a separately scoped real connector gateway. See `docs/TRUSTOPS_CORE_RUNTIME.md`.

The AWS target creates cost-bearing resources including NAT, ALB, Aurora Serverless and WAF; the default budget alarm is USD 300/month. A real plan must be reviewed before apply. **No plan or apply against AWS has run.** Production readiness is not established.

- **GCP (Oct 2026):** `taad-api` on Cloud Run (`min=max=1`), state in GCS (Cloud SQL blocked by org policy `sql.restrictPublicIp`), evidence in GCS, Cloud KMS signing key, Google sign-in, Vertex AI client (not yet usable: project billing returns `Lightning dunning decision is deny`). Added from TrustOps Diagnostic Studio: AI use-case inventory agent, framework gap-analysis agent, 5-framework reference library (pending legal review). See `docs/UNIFIED_END_GOAL.md` and `docs/GCP_DEPLOYMENT.md`.

- **Verification (Oct 2026):** 170 unit/API tests, 63 Playwright browser tests (every page, the full reviewer pipeline, approvals, downloads, accessibility names, layout at 390/1440/2000 px), 18 deployed-site smoke tests including a real redirect to Google sign-in, and the real Cloud KMS key's signature verified with the app's verifier. Not verified: real Gemini calls (billing), Google sign-in end to end (cannot be automated), live ClamAV scanning (opt-in).
