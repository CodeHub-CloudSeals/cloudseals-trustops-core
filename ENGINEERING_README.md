# CloudSeals TrustOps TAAD | Engineering handoff v1.0

This handoff specifies a **new bounded module**, Architecture Diagnosis Workstation (TAAD), deployed as an application module but integrated into the existing TrustOps Core. Swaska is the controlled assessment interview and extraction agent; it is not the policy/authority engine.

## Files

- `02_TAAD_Architecture_Diagnosis_Workstation_TDD_v1.0.docx` (design baseline: `01_TrustOps_Core_Original_Design_v1.0.docx`) — authoritative design + architecture/sequence/AWS, service boundaries, security and acceptance gates.
- `03_TAAD_Master_Question_Control_Catalog_v1.0.xlsx` — editable 318-question source, seven industry packs, 66 controls, 18 initial risk rules and EU crosswalk.
- `taad_question_control_registry_v1.0.0.json` — **machine import** of versioned catalog. Pin its SHA256 at activation; do not edit live assessments in place.
- `taad_catalog_sha256.txt` — registry integrity checksum.
- `taad_swaska_agent_manifest_v1.json` — bounded and explicitly read-only AI interviewer.
- `taad_assessment_api_v1.yaml` — FastAPI/typed frontend OpenAPI target contract.
- `taad_integration_contracts_v1.json` — versioned events and handoff to TrustOps Core.
- `CODEX_EXECUTION_PLAN.md` — incremental build gates for Codex.

## Product boundary

Customer Portal and Admin Portal are separate role views on one shared TAAD backend and tenant/identity service. TAAD creates **candidate findings**, human-reviewed reports and **draft-only** POC blueprints. TrustOps Core owns agent execution, policy enforcement, authority, Evidence Fabric and activation approvals.

## Review/signoff before customer production use

1. Technical architecture (CloudSeals Engineering / CISO).
2. Assessment methodology and risk rules (Trust Architect and risk specialist).
3. Question catalogue wording and industry pack (sector subject-matter owners).
4. Regulatory content mapping and changing obligations (legal/compliance owner).
5. Tenant retention, data processor agreements, upload safety, security assessment.

The deliverables are **build specifications and importable catalogues**, not a completed or running AWS application. A working AWS deployment requires implementing the services and infrastructure described.

## Running it

```
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
make build      # lint, mypy, 78 tests, registry validation
make demo       # narrated end-to-end run
make browser    # Playwright UI tests (needs: .venv/bin/playwright install chromium)
TAAD_SEED=1 make dev   # http://localhost:8000/portal/ (dev users), /docs for the API
make tf-validate
```

Code map: `packages/question-engine` (registry, branching, risk), `packages/reporting` (DOCX/PDF), `apps/assessment-api`, `apps/portal-web`, `infra/terraform`, `db/migrations`, `tests/`.

## Verification status (2026-10-08)

- `make build` passes: ruff, mypy, 78 tests (contract, security, e2e, adversarial), `validate_registry.py` (318 questions, 66 controls, 18 risk rules, 7 industry packs, 17 regulatory mappings).
- Registry SHA256 matches `taad_catalog_sha256.txt`; the API refuses to start on a mismatch.
- Terraform dev/staging/prod: `fmt` and `validate` pass. Not planned or applied. Docker image not built.
- Registry status is `engineering-seed-pending-domain-and-legal-review`: content is not customer-final until the signoffs above are complete.
- Limits: see `docs/AWS_DEPLOYMENT.md` and `docs/SECURITY_AND_LIMITS.md`.

For the current workspace reproduction, environment blockers, and outstanding completion gates, see `PROJECT_COMPLETION_STATUS.md`. The product end state is summarized in `TAAD_END_GOAL.md`.
