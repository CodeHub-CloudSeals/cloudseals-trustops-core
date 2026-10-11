# GCP deployment (Cloud Run + Cloud SQL + Cloud Storage + Vertex AI + Cloud KMS)

`infra/gcp/setup.sh` provisions and deploys everything. It is idempotent: re-running reuses resources and never regenerates the DB password.

```bash
export PROJECT_ID=trustops-uat REGION=europe-west1
export GOOGLE_CLIENT_ID=<oauth client id> GOOGLE_SECRET=<Secret Manager name of the client secret>
export FIRST_ADMIN_EMAIL=you@cloudseals.co.uk
export LLM_PROVIDER=vertex          # leave empty for deterministic agents only
./infra/gcp/setup.sh
```

## One manual step
Add the printed redirect URI (`https://taad-api-<project-number>.<region>.run.app/portal/`) under **APIs & Services -> Credentials -> your OAuth client -> Authorised redirect URIs**. Google does not allow this through the CLI.

## What it creates
Artifact Registry repo, private versioned evidence bucket, Cloud SQL PostgreSQL 15 (backups, deletion protection), DB URL in Secret Manager, a Cloud KMS EC P-256 signing key, two least-privilege service accounts, then `cloudbuild.yaml`: **tests -> image -> push -> Cloud Run deploy -> /health smoke test**. Later releases: `gcloud builds submit --config cloudbuild.yaml --substitutions ...` or a trigger on `main`.

## How the pieces connect
| Concern | Implementation |
|---|---|
| Sign-in | Google OAuth code flow; the portal exchanges the code through `POST /v1/auth/token` (client secret stays server-side) and the API verifies the Google **ID token**. Roles/tenant come from server-side membership, never from the token. |
| First admin | `TAAD_FIRST_ADMIN_EMAIL`: the first *verified* Google login with that email becomes CloudSeals admin, once, only in `TAAD_ENV=dev`, only while no admin exists. Audited. |
| LLM | `TAAD_LLM_PROVIDER=vertex` -> Gemini via `google-genai` (service account, no keys). Output is JSON-only, token-capped, schema- and grounding-validated; any failure falls back or fails closed. |
| Evidence integrity | `TAAD_KMS_SIGNING_KEY_VERSION` -> every runtime evidence record is signed by Cloud KMS; if signing fails the action is not recorded. |
| Documents | GCS bucket `<project>-taad-evidence`; PDF/Word/text are read in memory for the inventory agent. |

## Constraints
- **One instance** (`min=max=1`): state is a single-writer SQL snapshot and the agent rate limiter is in memory.
- **No malware scanner on GCS** (AWS uses GuardDuty). Only byte-level checks run. Add one before accepting untrusted files in production.
- `APP_ENV=dev` (default) enables the sandbox workflow runtime and the first-admin bootstrap; `prod` disables both and needs the Core runtime integration listed in PROJECT_COMPLETION_STATUS.md.
- Google ID tokens last one hour; the portal sends users back to sign-in when one expires.
- Other OIDC providers: `AUTH_PROVIDER=oidc` plus the `OIDC_*` variables; use `infra/gcp/bootstrap-admin.sh <sub>` for the first admin.
