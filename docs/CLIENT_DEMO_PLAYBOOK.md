# TrustOps MVP customer demo

## Scope

This walkthrough follows the CEO handoff's LedgerSight AR/Cash success demo. It demonstrates a bounded payment-matching workflow and the TAAD-to-Core boundary. It uses the local development tenant, fictional evidence and the `mock_sap` adapter. **It does not connect to a bank, use customer payment data, or write to an ERP.** The runtime is not production-ready.

## Start the local walkthrough

In the repository root:

```sh
TAAD_SEED=1 TAAD_ENV=local TAAD_AUTH_MODE=dev make dev
```

Open `http://127.0.0.1:8000/portal/`. Development sign-in selects the seeded `Demo Bank` workspace. Open **Assessments** to show the assessment entry point; use the assessment wizard to explain system details, evidence, questions, and report review. The prepared PDF/Word assessment is a **synthetic, questionnaire-rules report**; it is not an AI document-diagnosis report or a bank readiness opinion. The Core runtime is a separate, explicitly sandboxed POC under **LedgerSight POC**.

## 10–15 minute presenter sequence

1. **Frame the problem (1 min).** An operations team needs to match incoming cash receipts to open invoices while preserving human approval and an auditable decision record.
2. **Explain what the customer provides (2 min).** A receipt, candidate invoice records, remittance reference, and a customer-approved workflow policy. The included example records are fictional and marked synthetic.
3. **Run Exact match (3 min).** Select **Run exact-match scenario**. Show the six actual API trace steps, the policy decision, the proposed invoice allocation, and the input fingerprint. If the local model is not configured, describe the run as deterministic; do not call it a live AI-model result.
4. **Show the gate (2 min).** Select **Run ambiguous scenario**. Multiple exact candidates should escalate with no proposal. Then select **Run high-value scenario** and show that the initiator cannot approve it; a separate `customer_controller` must make the decision.
5. **Show a controlled sandbox action (2 min).** For an authorized exact match, prepare the action, show pre-commit evidence, then execute it through `mock_sap`. State plainly that this creates a mock acknowledgement only.
6. **Verify and close (2 min).** Verify the run evidence. Explain that local hash-chain integrity is not a production KMS signature. A bank pilot would require the bank's approved test environment, approved policy limits, connector adapter, and security sign-off.

Use different authorized identities for maker and controller. Do not approve a high-value workflow as the user who started it.

## Optional repeatable fixture preparation

With the server running in a second terminal:

```sh
.venv/bin/python scripts/prepare_client_demo.py \
  --base-url http://127.0.0.1:8000 \
  --output ../outputs/trustops-demo
```

The script refuses non-local URLs, creates fictional assessment evidence and report downloads, prepares matching/ambiguous/no-match/high-value examples through the real local API, checks tenant and maker-checker boundaries, and exercises idempotent run replay. Output files are local demo artifacts, not customer reports. The report is rules-based and questionnaire-backed; it does not claim automatic analysis of the uploaded sample text files.

## What the demo proves—and what it does not

It proves the current local flow can enforce the configured exact-match example policy, route ambiguity/high value to review, require maker-checker separation, gate mock execution behind PRE-COMMIT evidence, prevent a duplicate workflow run on idempotent replay, and verify the local evidence chain.

It does **not** prove a bank's implementation has a defect, inspect private bank systems, certify regulatory compliance, or demonstrate a real SAP/bank transaction. A customer pilot should start with one bank-owned test system, written scope/permission, read-only evidence access, customer-approved workflow policy, and agreed success measures.
