# Codex build execution sequence for TrustOps TAAD

Read the Word technical design and import the JSON question registry; do not hardcode 318 questions into JSX. Preserve the existing TrustOps Core contracts.

## Repo organisation

```text
apps/portal-web/              Next.js customer/admin portals
apps/assessment-api/          FastAPI modular backend
workers/diagnosis/            deterministic scoring + assessment jobs
workers/swaska/               bounded interview, extraction, draft agents
packages/question-engine/     versioned schemas, branching DSL, validators
packages/trustops-contracts/  idempotent event/API payloads
packages/reporting/           report templates + provenance checks
packs/industry/               sector overlays imported from catalog
infra/terraform/modules/      networking, ecs, db, s3, cognito, jobs, events
infra/terraform/environments/ dev, staging, prod (prod not first)
tests/contracts/ tests/security/ tests/e2e/ tests/adversarial/
```

## Build gates / task prompts

**Gate 1 — Registry contract and repeatable local dev**
Create schema migrations, JSON-import/versioning pipeline, branching interpreter (no eval), sample bank/health/logistics tenants, API health and CI. Tests: stable IDs, no dangling control refs, branching fixtures and tenant isolation.

**Gate 2 — Registration and customer portal**
Cognito integration, invitation/engagement approval gate, verified tenant membership, assessment wizard with save/resume/assignments, uploads to quarantine, accessibility and mobile. Test owner/contributor permissions.

**Gate 3 — Swaska and intelligent analysis**
Implement the bounded Swaska interviewer and controlled evidence extraction. Structured outputs only; no direct database writes without schema validation. Deterministic risk rules produce candidates with citations, confidence and unknown handling; reviewer adjusts findings.

**Gate 4 — Report + admin operations**
Versioned report composer (DOCX/PDF), exact question/rule/regulatory versions, reviewer approve/reject/request clarification, admin metrics and activity. Publish only approved reports; provide an explicitly preliminary customer report only if configured and visibly marked.

**Gate 5 — TrustOps Core handoff**
Issue `taad.poc.blueprint_approved.v1` only after the customer security and CloudSeals architect approvals; create DRAFT workflow pack, agent/authority/policy and evidence config. Block all real execution/credential provisioning until separate runtime approval.

**Gate 6 — AWS DEV deployment + UAT**
Use Terraform, ECS Fargate, Aurora Postgres, Cognito, EventBridge, SQS/DLQ, Step Functions, S3/KMS, SES, CloudWatch, WAF. GitHub Actions OIDC. `terraform plan` reviewed before apply. Confirm cost controls, backup, access boundaries, automated smoke and adversarial tests.

## Non-negotiable execution rules

- Report factual certainty and legal applicability must never be inferred from a mere checked answer.
- Questionnaire versions freeze at assessment activation; answers and report inputs freeze at submission.
- Question ID stable; changes are versioned. All report claims link to answer and evidence references.
- Uploaded documents are untrusted inputs. Defend against prompt injection; virus-scan/quarantine.
- Swaska cannot invent stable question IDs or publish reports. Clarification proposals stay linked to existing questions.
- One customer tenant cannot access another tenant's data/metadata, including filenames or object existence.
- No real external writes or production IAM credential provisioning in the diagnosis path.
- Favor an independently deployable modular API with separate async workers over many tiny microservices for initial POC.
- Every gate requires lint, type checks, unit/integration/adversarial tests, run locally, fix failures, commit, and update docs.

## Developer commands (target interfaces, not yet implemented)

`make dev` / `make seed` / `make test` / `make build`

`terraform -chdir=infra/terraform/environments/dev init`

`terraform -chdir=infra/terraform/environments/dev plan -var-file=dev.tfvars`

`terraform -chdir=infra/terraform/environments/dev apply -var-file=dev.tfvars`

The presence of this execution plan does **not** mean an application or Terraform deployment is already implemented.

## Implementation status (2026-10-08)

| Gate | State | Verified by |
|---|---|---|
| 1 Registry, branching, API, CI | Done | contract tests, `validate_registry.py`, CI workflow |
| 2 Registration, invitations, portal, uploads, assignments | Done (8 Chromium Playwright tests) | onboarding, security, evidence tests; `make browser` (Playwright) |
| 3 Swaska + deterministic risk rules + reviewer adjustment | Done (Bedrock path tested with fake client only) | adversarial + swaska tests |
| 4 Reports (DOCX/PDF), review, admin ops | Done | report tests, rendered PDF inspected |
| 5 TrustOps hand-off (draft blueprint) | Done | contract tests |
| 6 AWS DEV (Terraform, Docker, OIDC deploy workflow) | Written and `terraform validate`d; **never planned/applied; Docker image never built** | `make tf-validate` |

Not committed: this folder is not a git repository. Known limits are in `docs/AWS_DEPLOYMENT.md` and `docs/SECURITY_AND_LIMITS.md`.
