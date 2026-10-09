# AWS DEV deployment runbook

Status: Terraform formatting passes. Dev/staging/prod validation passed before the latest Cognito runtime-config changes; a repeat validation could not resolve `registry.terraform.io` from this environment. **It has never been planned or applied against a real AWS account** (no credentials were available). Expect a first-plan iteration.

## Prerequisites (once, by a human)
1. AWS account, region `eu-west-2` (change `region` for other residency).
2. S3 state bucket and DynamoDB lock table; copy `environments/dev/backend.hcl.example` to `backend.hcl`.
3. Edit `environments/dev/dev.tfvars` (portal URL, Cognito domain prefix, alarm email, GitHub repo). Staging and prod require `certificate_arn`.
4. Bootstrap the GitHub OIDC roles: first apply locally with an admin profile, then set repository variables `TAAD_DEV_PLAN_ROLE_ARN`, `TAAD_DEV_APPLY_ROLE_ARN`, `TAAD_DEV_URL`. Set `apply_policy_arns` to a scoped policy, not AdministratorAccess, and configure required reviewers on the GitHub Environment `dev`.

## Deploy
```
terraform -chdir=infra/terraform/environments/dev init -backend-config=backend.hcl
terraform -chdir=infra/terraform/environments/dev plan -var-file=dev.tfvars     # REVIEW before apply
terraform -chdir=infra/terraform/environments/dev apply -var-file=dev.tfvars
docker build -t taad:<tag> . && docker push <ecr_repository_url>:<tag>           # then set image_tag and re-apply
```
The API generates `/portal/config.json` from the Cognito Terraform outputs injected into the task environment. The checked-in static config is fail-closed (`mode: oidc`); only a local environment explicitly running `TAAD_ENV=local` and `TAAD_AUTH_MODE=dev` can expose the seeded-user chooser. The deployed portal uses real Cognito authorization-code + PKCE, MFA-enabled invitation-only accounts, and server-side tenant membership. Sign out also redirects through Cognito logout. This pool currently uses CloudSeals-managed Cognito accounts; customer-IdP SAML/OIDC federation is not configured.

## Smoke tests after apply
- `GET /health` returns `question_count: 318` (the `deploy-dev` workflow does this).
- Cognito: create and verify a CloudSeals operator in the invitation-only user pool, run the one-time bootstrap (see below), and complete real Cognito sign-in/MFA at `/portal/`. Add customer accounts only after engagement approval and tenant membership assignment.
- Upload a small valid text file: the local signature/content checks run first; in AWS it remains `scanning` until GuardDuty adds `GuardDutyMalwareScanStatus=NO_THREATS_FOUND`. Refresh the evidence list to read the asynchronous result. `THREATS_FOUND` becomes infected; unsupported, denied, failed, or missing results never become citable.
- Confirm cross-tenant 404s with two tenants (the automated suite already covers this logic).

## First CloudSeals admin
Create the operator in the dev Cognito pool and confirm the account with a verified email. From an approved operator session, execute the one-time bootstrap in the API task:
```
python -m app.admin_bootstrap --cognito-username '<exact Cognito username>'
```
The utility checks Cognito status/email verification, refuses non-dev or non-OIDC environments and ephemeral storage, writes a durable bootstrap marker, and refuses a second admin bootstrap. Its task role has only `cognito-idp:AdminGetUser` on this user pool. Confirm the intended operator and retain the task/audit evidence as part of hosted UAT.

## Known limits (be explicit with customers)
- Persistence is a **single-writer snapshot** (`state` table, optimistic version). Run exactly one API task. `db/migrations/002_normalised_schema_DRAFT.sql` is the untested design for multi-task scale-out with Postgres Row Level Security.
- Diagnosis runs inline in the API on submit. SQS, EventBridge Pipe and Step Functions are provisioned as a **placeholder pipeline**.
- GuardDuty Malware Protection is attached to the quarantine bucket with post-scan object tagging enabled. The API reads `GuardDutyMalwareScanStatus` on upload and evidence-list refresh; only `NO_THREATS_FOUND` promotes the object. There is no event-driven status callback yet, so clients must refresh while `scanning`.
- SES is permissioned but invitations are only written to an in-memory outbox; no email is sent.
- Bedrock Swaska is wired and permission-scoped, but was only tested with a fake model client.
- Customer sign-in is real Cognito authentication, but all user creation is invitation-only and CloudSeals-managed; enterprise SAML/OIDC federation is a separate integration requiring customer IdP metadata and review.
- AWS Backup beyond Aurora automated backups, multi-region DR and WAF tuning are not done.
- Cost: dev runs NAT gateway, ALB, Aurora Serverless v2 (min 0.5 ACU), WAF; budget alarm defaults to USD 300/month. Destroy dev when idle.
