# TAAD customer call brief

## One-liner
TAAD is a bounded diagnosis module for TrustOps Core. Customers answer a versioned AI-architecture questionnaire. Swaska (a read-only interviewer) clarifies. Deterministic rules produce *candidate* findings. CloudSeals reviewers approve before the customer sees anything. A draft-only POC blueprint then hands off to TrustOps Core.

## Live demo (5 min): `make demo`
Shows: pinned registry hash, branching (bank vs health), Swaska ignoring prompt injection, submit/freeze, findings with citations, tenant isolation (404), reviewer approval, draft-only blueprint, emitted events.

## What is built and verified (local)
- Invitation-only onboarding (registration, engagement check, approval, single-use invitations, contributor assignments).
- Versioned questionnaire with branching, save/resume, optimistic locking, evidence upload with quarantine and scanning.
- Swaska interviewer (read-only, schema-validated, deterministic fallback; model adapter ready for Bedrock).
- Candidate findings with citations, reviewer adjustment, approve/reject/clarify, publish-only-approved, DOCX/PDF reports with provenance, preliminary reports visibly marked.
- Draft-only POC blueprint matching the TrustOps Core contract; events with the versioned envelope.
- Customer and CloudSeals admin portal (single-page, accessible, responsive).
- Production portal login uses Cognito OIDC authorization-code + PKCE; account and tenant roles are not selectable by the user. Seeded user selection is confined to local development.
- 89 automated tests plus lint and type checks: `make build`.
- AWS DEV infrastructure as code (VPC, ECS Fargate, Aurora, Cognito, S3/KMS, EventBridge/SQS, WAF, alarms, budget, GitHub OIDC). Formatting passes; full validate passed before the latest OIDC config additions, and repeat validate is blocked by registry DNS here.

## What is NOT done (say this plainly)
- Nothing is deployed. Terraform has not been planned/applied against AWS and the Docker image has not been built; expect a first-run iteration in the AWS account.
- Persistence is single-writer; diagnosis runs inline; invitations are not emailed; GuardDuty status logic is unit-tested but not verified in AWS; Bedrock path untested against the real service.
- Portal tested in Chromium only (8 Playwright tests); no Firefox/Safari or screen-reader pass. No penetration test or independent security review.
- Question wording, risk rules and regulatory mapping are not signed off (`engineering-seed-pending-domain-and-legal-review`).

## Likely customer questions
- **Does it decide legal applicability?** No. Findings are candidates for human review, with a disclaimer.
- **Can Swaska act on our systems?** No. It is read-only, with no tokens or execution.
- **Can another customer see our data?** No. Tenant comes from server-side membership, and cross-tenant IDs return 404.
- **Do answers change after submit?** No. They are frozen and digested.
- **When can we try it?** A guided demo works now. A hosted DEV tenant needs the AWS apply, a browser test pass and the signoffs in ENGINEERING_README.md. Agree timelines with engineering before committing.
