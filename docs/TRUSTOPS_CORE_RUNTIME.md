# TrustOps Core execution runtime

## Implemented in this workspace

The LedgerSight AR/Cash workflow now has six bounded agents from the TrustOps design: Intake, Match, Reconciliation, Cash Allocation, Exception, and Audit. They run as deterministic reference agents over allowlisted receipt, invoice, and remittance fields. They do not call an LLM, call external tools, hold credentials, or connect to ERP. The responses are recorded as an agent trace with the input digest.

The workflow currently supports a strict exact-match path. A unique reference + amount + currency match can be prepared. Multiple candidates or no exact candidate escalate. A match at or above the example pack threshold (100,000 minor units) requires a different tenant member with the dedicated `customer_controller` role to approve it. Risk users and the workflow initiator cannot approve it. The threshold is illustrative and must be replaced by customer-approved pack configuration before UAT.

The execution sequence is enforced by the API:

1. `POST /v1/workflows/ledgersight.ar_cash/runs` runs all six agents and deterministic policy.
2. `POST /v1/approvals/{run_id}/decision` records approve/reject for high-value proposals; the initiator cannot approve their own proposal.
3. `POST /v1/execution/prepare` creates a prepared proposal, appends local PRE-COMMIT evidence, then issues a one-time 60-second token bound to tenant, actor, run, and proposal digest.
4. `POST /v1/execution/execute` validates that token and calls only the deterministic `mock_sap` adapter. It is idempotent by run and request key.
5. `POST /v1/evidence/{run_id}/verify` verifies the tenant's local evidence hash chain.

All routes are tenant-scoped and role-gated. The runtime is available only with `TAAD_ENV=local` or `dev` and `TRUSTOPS_RUNTIME_MODE=sandbox`; it returns unavailable in staging/prod. The short-lived token is never persisted in the application idempotency record. For non-local token signing, `TRUSTOPS_ACTION_TOKEN_SECRET` must be set; production should use a dedicated KMS asymmetric signer instead.

## Not production-ready yet

This implementation provides an executable sandbox path, not a production TrustOps Core deployment. It must not be described as connected to SAP or as using production agents. The original Core design says Core is an existing system; its source repository and deployed service are not included in this TAAD handoff. The current code is therefore a reference runtime integrated into the TAAD API for local/dev testing.

Before production use, engineering must:

- Move the runtime into the independently deployed TrustOps Core/orchestrator and separate agent worker tasks. Use durable Step Functions/SQS execution, retry, timeout, cancellation, and DLQ recovery instead of inline API execution.
- Replace in-memory/snapshot state with normalized transactional storage, unique action/idempotency constraints, row-level tenant isolation, and concurrency-safe approval/token consumption.
- Replace the illustrative threshold and exact-match rules with an approved versioned Workflow Pack, Controller role, authority matrix, currency-aware limits, risk rules, and customer sign-off.
- Add a model gateway for the reasoning agents (Match and Reconciliation) with strict structured output, prompt/template versioning, source grounding, budget/time limits, adversarial evaluation, and deterministic fallback. Model output must never grant authority.
- Implement real source-system adapters in a separate Execution Gateway task role. Store no connector credentials in agents. Add sandbox/UAT before production and verify connector idempotency semantics against the source system.
- Replace the local SHA-256 evidence chain with canonical versioned records, KMS/HSM asymmetric signatures, durable immutable storage/Object Lock where configured, and an independently deployed verification API. Current verification explicitly reports `production_signature: false`.
- Run hosted integration, golden-path and adversarial tests (exact, ambiguous, high-value, duplicate, prompt injection, token replay/expiry, tenant crossover, PRE-COMMIT failure, connector timeout/retry, COMMIT failure), restore/recovery drills, penetration testing, and operational acceptance.

The original requirement remains: probabilistic agents may recommend or prepare only; deterministic policy and explicit human authority govern consequential actions; failed evidence PRE-COMMIT blocks execution.
