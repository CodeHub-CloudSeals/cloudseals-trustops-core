# TAAD project completion status

**Status: not complete; not deployed.** The customer-call rehearsal and local engineering foundation are ready. A six-agent deterministic LedgerSight sandbox runtime is now implemented, but AWS DEV deployment, hosted UAT, and the production release gates in `TAAD_END_GOAL.md` remain open.

## Completed in this workspace

- Copied the handoff into `outputs/taad-project/`; the supplied Downloads copy remains untouched.
- Fixed the portal answer-save behavior so progress and submit eligibility update after each save; the earlier manual browser check completed a 3-question flow and unlocked Submit at 3/3.
- Replaced the deprecated FastAPI startup event with a lifespan handler.
- Added fail-closed GuardDuty status handling: only `NO_THREATS_FOUND` promotes an AWS object to citable evidence; threat results become infected, and failed/unsupported/denied scans are rejected. The API reads the tag on upload and evidence-list refresh. This follows [AWS's documented scan-result tags](https://docs.aws.amazon.com/guardduty/latest/ug/monitoring-malware-protection-s3-scans-gdu.html).
- Wired the deployed portal to runtime Cognito settings: production mode fails closed to OIDC, authorization-code + PKCE, and Cognito logout; local seeded-user login is available only for explicitly local/dev mode. The API exposes only the configured Cognito URLs, and CSP allows the configured token endpoint origin. Cognito MFA and invitation-only user creation are defined in Terraform.
- Added a one-time Cognito first-admin bootstrap command. It requires dev + OIDC + durable DB, confirms the Cognito account/email, records an immutable bootstrap marker, and refuses a second bootstrap. Terraform scopes `AdminGetUser` to the pool.
- Implemented the six LedgerSight runtime agents (Intake, Match, Reconciliation, Cash Allocation, Exception, Audit) as deterministic, bounded local/dev sandbox workers; added policy escalation, maker-checker approval, payload-bound short-lived action tokens, idempotent mock SAP execution, and local evidence PRE-COMMIT/COMMIT hash-chain verification. The runtime is deliberately disabled in staging/prod and has no real ERP connector.
- Applied the supplied CloudSeals SVG logo to the engineering portal and call demo; the demo `/logo.svg` endpoint returned HTTP 200 with `image/svg+xml`.
- Reconciled the local registry checks: 318 questions, 66 controls, 18 risk rules; registry validation passes.
- Created `TAAD_END_GOAL.md` and the deployment/call checklist.

## Verification just completed

- Python 3.12.14 environment created in this working copy from `requirements-dev.txt`.
- `ruff check .`: pass.
- `mypy --ignore-missing-imports packages/question-engine/question_engine packages/reporting/reporting`: pass.
- Backend, contract, adversarial, security, persistence, auth-config, integration, and TrustOps runtime tests: **93 passed**.
- Registry validation: pass; bank and healthcare branch fixtures pass.
- Terraform 1.16.5 formatting passes. Dev, staging, and prod configurations validated before the latest OIDC environment additions; revalidation after those additions could not reach `registry.terraform.io` because DNS resolution failed in the shell environment. The official archive checksum matched HashiCorp's published SHA-256 list; see [HashiCorp's archive verification guide](https://developer.hashicorp.com/terraform/tutorials/cli/verify-archive).
- Browser suite: 8 tests could not start because Chromium terminates with macOS `MachPortRendezvousServer` permission denied. The test fixture can bind localhost now; the remaining failure is browser-process launch. The previous manual UI check did pass.
- Demo Lambda ZIP and project ZIP have been rebuilt; the Lambda handler's logo route was directly tested.

## Still open before the project can be called complete

1. **AWS DEV deploy and hosted UAT:** AWS CLI, Docker engine, AWS profile/credentials and AWS account configuration are absent here. Terraform `validate` is not a real-account plan. The actual project deployment, cost review, apply, image push, hosted health/browser checks and cleanup rehearsal have not happened.
2. **Owner-supplied deployment values:** approved AWS account/profile and region, valid portal URL/domain, alert email, GitHub repository for OIDC and remote-state bucket/lock table. Never paste AWS secrets into chat.
3. **Run first-admin bootstrap in AWS:** code and scoped policy exist, but the bootstrap has not been executed against a real Cognito pool/database or verified in hosted UAT.
4. **Invitation delivery:** SES is permissioned in the design, but tenant invitations are not sent. The outbox is persisted with the current snapshot, but no SES dispatcher/retry/delivery verification exists.
5. **Durable async workflows:** assessment diagnosis and the new LedgerSight runtime still run inline. SQS, EventBridge Pipe and Step Functions exist as scaffolding; there is no production worker, status/retry/DLQ recovery flow.
6. **Multi-writer database safety:** current persistence is a single-writer whole-state snapshot. Do not scale beyond one API task. The normalized schema/RLS migration remains draft and untested.
7. **Real model and evidence UAT:** Bedrock is only tested with a fake model client; the six runtime agents are deterministic reference agents, not live model workers. GuardDuty tag logic passes mocked tests but has not been tested in the target AWS account. The runtime evidence chain is local SHA-256 only; KMS signing and immutable storage are not wired. Data/residency and adversarial review remain open.
8. **Release acceptance:** reconcile the 316/318 narrative count in the TDD; obtain engineering/CISO, risk/methodology, sector, legal/privacy and retention sign-offs; complete independent penetration/security review, restore/recovery exercise, and agreed cross-browser/accessibility testing.
9. **TrustOps Core production integration:** the six-agent sandbox is embedded in the TAAD API because the existing Core repository/service is not part of this handoff. Move it behind the Core orchestrator and separate worker, replace the illustrative value threshold with approved tenant Workflow Pack policy, integrate the real approval/authority service, KMS-signed Evidence Fabric and a separately scoped real connector gateway. See `docs/TRUSTOPS_CORE_RUNTIME.md`.

The AWS target creates cost-bearing resources including NAT, ALB, Aurora Serverless and WAF; the default budget alarm is USD 300/month. A real plan must be reviewed before apply. **No plan or apply against AWS has run.** Production readiness is not established.
