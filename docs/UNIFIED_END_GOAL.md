# End goal: one TrustOps platform on GCP

Merge what is worth keeping from **TrustOps Diagnostic Studio** (`cs-trustops-studio`, nine Cloud Run microservices in `trustops-uat`) into **TAAD / TrustOps Core** (this repo) and run it as one governed, deployable service.

## What each system is good at
| Studio (consultant tool) | TAAD (this repo) |
|---|---|
| Reads customer documents with Gemini, extracts AI use cases with verbatim quotes | Customer questionnaire, deterministic risk rules, reviewer approval, POC blueprint |
| Gap analysis against 5 frameworks (80 requirements/controls) | Maker-checker governed workflow runtime, tenant isolation, role gates |
| KMS-signed evidence records | Local hash-chained evidence |
| Google Workspace sign-in | Generic OIDC |

## Done means
1. **Runs on GCP**: Cloud Run + Cloud SQL + GCS + Secret Manager + Vertex AI (Gemini) + Cloud KMS, deployed by `cloudbuild.yaml`, in project `trustops-uat`.
2. **Google sign-in** (existing Studio OAuth client); one-time first-admin bootstrap by verified email.
3. **Gemini behind every agent** via one `llm` module, with the deterministic fallback and output validation we already have. No model configured -> still works.
4. **New agents (advisory, nothing auto-saved as an answer or approval):**
   - *Use-case inventory*: PDF/DOCX/text evidence -> candidate AI use cases; every quote must exist verbatim in the document.
   - *Framework gap analyst*: validated use cases x framework requirements -> candidate gaps citing real requirement/control IDs.
5. **Reviewer gate**: use cases and gaps stay `UNREVIEWED` until a CloudSeals reviewer validates them.
6. **KMS-signed evidence**: runtime evidence records are signed by Cloud KMS; signing failure blocks the action (fail closed).
7. **Framework library**: the five Studio framework definitions as read-only reference data, labelled "pending legal review".
8. **UI**: Google login, Use cases page, Frameworks page, Agent Flow with all agents (live animation), consistent polish.
9. **Verified**: tests green, container layout test, deployed `/health`, portal served from Cloud Run, Gemini call proven from the deployed service.

## Also ported (phase 2)
- **Maturity scorer** (5 TrustOps principles): scores bounded 1-5, the overall score is computed here, a score of 3+ without cited evidence is capped at 2.
- **Roadmap agent**: critical gaps are forced into the first 90 days, dependencies are checked for cycles, totals are computed here, uncovered critical/high gaps are reported.
- **Diagnostic report**: deterministic HTML (every string escaped) from reviewer-validated material only, `DRAFT` until use cases, maturity and roadmap are validated; optional AI-drafted narrative.
- **Studio page** (`#/use-cases`): 5-step pipeline with reviewer gates; **TrustOps hub** strip lists workflow packs and tools.

## Deliberately not in this pass
Architecture-overlay agent, Firestore, the Next.js UI. The old nine services keep running untouched until you decide to retire them.
