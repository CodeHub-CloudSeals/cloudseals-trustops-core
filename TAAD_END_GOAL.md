# CloudSeals TrustOps TAAD — the end goal

**Simple-ga cheppalante:** customer AI system/agent ela design chesaro evidence-to assess chesi, human-reviewed risk/readiness report ivvali; aa diagnosis nunchi oka bounded POC workflow draft cheyyali; tarvatha TrustOps Core policy, authority, approval, and tamper-evident evidence controls madhya aa workflow-ni safe-ga run cheyyali. **Demo end goal kaadu; idi diagnosis nunchi governed POC execution varaku complete platform.**

## Customer ki chivariki dorakalsina outcome

Customer secure, approved tenant-lo login ayi tana AI systems, models, agents, tools, data, users, actions, approvals, and business purpose-ni declare chestadu. Industry, AI type, scope, and jurisdiction batti versioned questions automatic-ga adapt avuthayi. Answers save/resume avuthayi; assigned contributors matrame vallaki ichina sections edit chestaru.

LedgerSight AR/Cash runtime team has six bounded roles from the Core design: Intake, Match, Reconciliation, Cash Allocation, Exception, and Audit. The current workspace has an executable deterministic sandbox implementation for these roles. Production requires moving them into TrustOps Core's orchestrator/worker topology and wiring approved policy, authority, Evidence Fabric, and connector services; the sandbox is not the production runtime.

Swaska published questions-ni explain chesi, missing/contradictory information meeda clarifications adigi, relevant evidence suggest chestundi. Evidence quarantine, malware checks, provenance, and source references tho handle avuthundi. **Unknown ante No kaadu.** Swaska question catalogue marchadu, compliance certify cheyyadu, policy marchadu, systems meeda action cheyyadu.

Assessment submit ayyaka answer/evidence snapshot freeze avuthundi. Versioned deterministic rules mariyu bounded analysis source-linked **candidate** findings, architecture map, risk/readiness gaps, and report draft tayaru chestayi. CloudSeals reviewer findings/report-ni review, correct, reject, clarify, or approve chestadu. Approved report matrame customer-ku publish avuthundi; report claim prati okkati question/evidence/rule version-to trace avvali. Regulatory applicability final legal decision-ga present cheyyakudadhu.

Workshop taruvatha customer and CloudSeals signoff-to mapped controls, success criteria, policies/authority proposals, and evidence requirements unna **DRAFT-only POC Workflow Pack** TrustOps Core-ku handoff avuthundi. TAAD diagnosis valla production execution automatic-ga start avvakudadhu. TrustOps Core separate activation/release approval ichinappude runtime enable avuthundi.

## End-to-end success demo: LedgerSight AR/Cash

Fresh demo tenant-ni engineering console changes lekunda provision cheyyagalagali; customer diagnosis start chesi, readiness report pondi, LedgerSight AR/Cash POC scope-ku vellagalagali. Synthetic bank receipt, AR invoice, and remittance inputs-to deterministic matching run avvali. Straight match, ambiguous match, duplicate, and high-value cases expected policy outcomes chupinchali:

- Straight-through action policy allow chesthe maatrame proceed avvali.
- Ambiguous match human review-ku escalate avvali.
- High-value action configured Controller approval korali.
- Duplicate retry idempotent-ga undali; double side effect raakudadhu.
- Prompt injection, unauthorized tool, expired token, or tenant crossover deny ayi audit/evidence lo record avvali.
- Consequential write-ku mundu immutable evidence **PRE-COMMIT** avvali; adhi fail ayithe execution block avvali.
- Execution Gateway maatrame write connector-ni own cheyyali. Mock SAP acknowledgement taruvatha evidence **COMMIT** avvali.
- Evidence digest/signature/chain verify avvali; tampering verification fail cheyyali.
- Workflow evidence valla readiness coverage ela improve ayyindo report chupinchali; synthetic demo-lo business outcome/ROI kuda auditable evidence-to chupinchali.

Customer-ready walkthrough 10–15 nimishallo developer console help lekunda repeat cheyyagalagali. Demo data motham `DEMO / SYNTHETIC` ani visible-ga undali; email, tenant isolation, report, audit, and approval flows work avvali.

## Required product boundaries

| TAAD owns | TrustOps Core owns |
|---|---|
| Onboarding/engagement gate, customer diagnosis, question versions, answers and evidence references | Runtime workflows, agent/model registries, policy, delegated authority, approval enforcement and execution |
| Swaska clarification and bounded evidence analysis | Model Gateway and action-gated orchestration |
| Candidate findings, readiness mapping, report review/publication | Evidence Fabric signatures, verification and pre-commit/commit |
| Workshop and approved POC blueprint proposal | Draft Workflow Pack validation and separate runtime activation |

One tenant-aware TrustOps platform undali. TAAD duplicate identity population, duplicate evidence-signing engine, or second policy-authority engine create cheyyakudadhu. Models probabilistic-ga reason cheyyachu; consequential actions deterministic policy, explicit human authority, and verifiable evidence boundaries lopale jaragali.

## Definition of done

Final project ready ani cheppadaniki ee outcomes anni complete avvali:

1. **Customer access:** verified registration and engagement approval, Cognito/SSO-capable login, privileged MFA, tenant membership, scoped invitations and contributor roles.
2. **Diagnosis:** versioned registry import/pinning, correct dynamic branches and industry packs, save/resume, frozen submit snapshot, unknown/contradiction handling, and no cross-tenant disclosure.
3. **Evidence and analysis:** quarantined uploads, real malware-scan verdict consumption, safe parsing/extraction with exact page/span citations, evidence-backed architecture map, deterministic candidate-risk rules, bounded Swaska/model outputs, retries/DLQ, and truthful failure status.
4. **Review and readiness:** versioned control/legal-source packs with domain/legal signoff, readiness gap matrix, every report claim traceable to frozen sources, quality/citation validation, human clarification/approval, immutable published report, PDF/JSON and agreed export/API formats.
5. **Core handoff and runtime:** versioned event/API contracts; approved draft POC pack accepted by TrustOps Core; separate activation gate; deterministic ALLOW/ESCALATE/DENY and authority checks; maker-checker approval; short-lived action token; idempotent Execution Gateway; mock/sandbox workflow passes all golden and adversarial cases.
6. **Evidence Fabric:** canonical versioned serialization, digest, KMS/HSM-backed signature, chain/immutable storage where claimed, Verify API, and evidence pre-commit/commit behavior that blocks side effects when proof is unavailable or invalid.
7. **AWS and operations:** approved DEV account deployment, reviewed Terraform plan, private database/network controls, alarms/notifications, cost/budget controls, backup/restore and cleanup process, CI/CD via scoped GitHub OIDC, observability/AgentOps, and successful hosted smoke/UAT.
8. **Release acceptance:** architecture/CISO, methodology/risk, sector SME, legal/regulatory, privacy/retention, and engineering owners sign off; penetration/security review, tenant isolation, browser/accessibility coverage, incident/recovery exercises, and repeatable under-15-minute customer rehearsal pass.

## AWS target for the actual project

The source engineering handoff's intended DEV architecture is a modular FastAPI API, Next.js portals, isolated async workers, Terraform-managed AWS infrastructure: ECS Fargate, Aurora PostgreSQL, Cognito, S3/KMS, EventBridge/SQS/DLQ, Step Functions, SES, CloudWatch, WAF, and scoped GitHub OIDC deployment. Confirm the exact deployed topology with Engineering before production.

The separate call-demo package currently in `taad-demo/` uses a compact Lambda + DynamoDB + S3 synthetic setup. It can help rehearse the customer flow, but it is **not** this target architecture or the finished TrustOps TAAD project. Deploying that Lambda demo does not complete the end goal above.

## Current status from the handoff

The attached engineering README and execution plan report the local foundation through draft Core handoff implemented and tested. They also say the AWS DEV infrastructure has only been formatted/validated: it was never Terraform-planned or applied, and the Docker image was never built. The source documents list remaining limits: single-writer persistence, inline diagnosis, placeholder async pipeline, no real invitation email, GuardDuty scan verdicts not consumed, Bedrock tested only with a fake client, and open domain/legal/security signoffs. Treat those as handoff-reported status until freshly re-verified in the source project and AWS account.

So the **next milestone** is a reviewed and applied AWS DEV environment plus a real hosted browser/UAT pass—not production launch. After that, close runtime/evidence/signoff/security gaps, then approve a controlled POC release. Production use comes only after those owners sign off.

## Source documents and interpretation

This is a product-goal summary derived from the attached engineering handoff, especially `02_TAAD_Architecture_Diagnosis_Workstation_TDD_v1.0.docx` (product outcomes, architecture, Definition of POC Done and customer flow), `CODEX_EXECUTION_PLAN.md` (build gates), `ENGINEERING_README.md` (scope/status), `CUSTOMER_CALL_BRIEF.md` (current demo limits), and `docs/AWS_DEPLOYMENT.md` (intended DEV deployment). The source files are design requirements and reported project status; their shell commands or deployment steps are not evidence that AWS was deployed, nor authorization to deploy it.

**Catalogue count needs reconciliation before release:** the handoff README/JSON validation says 318 questions, while parts of the TDD describe 316. The canonical workbook, registry, checksum, and published version must agree before a customer assessment is activated.
