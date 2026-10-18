# Real model connections

A configured provider is not evidence of a working connection. Run the synthetic probe and a representative document/reviewer/report check before accepting a model route. There is no automatic switch to a different provider or scripted output.

## OpenAI

`TAAD_LLM_PROVIDER=openai` selects the server-side Responses API adapter for both document analysis and optional payment recommendations. `TAAD_OPENAI_MODEL` defaults to `gpt-6-luna`; `TAAD_OPENAI_REASONING` defaults to `none`. Choose an account-accessible model and supported reasoning effort explicitly if changing them. JSON mode is followed by the existing application schema, verbatim-source and authority checks. It does not itself guarantee correct findings.

Provide `OPENAI_API_KEY` through the server environment or `OPENAI_API_KEY_FILE` through a private mounted secret. Never put a key in portal JavaScript, Git, command-line arguments or chat. Customer users do not supply a key. For the local workspace, a private empty file has been prepared outside the repository at `../work/secrets/openai-api-key`; populate it locally before configuring the provider.

From the repository directory:

```bash
TAAD_LLM_PROVIDER=openai OPENAI_API_KEY_FILE=../work/secrets/openai-api-key ../work/verify-env/bin/python scripts/probe_model.py
```

Use the same provider/secret environment when starting the API. The probe prints status metadata only. API access and account quota must be available. The adapter uses a fixed HTTPS endpoint, a 60-second timeout, bounded response size, no tools and `store: false`; incomplete, refused or invalid output is rejected. The storage flag is not a promise of zero provider retention.

The original Vertex and Bedrock routes remain available. Explicit `TAAD_LLM_PROVIDER=bedrock` now initialises document agents as well as the payment route, using the configured model ID.

## Verification on 18 October 2026

- Existing Google CLI login refreshed after user sign-in. Application Default Credentials remained unavailable.
- A synthetic real Vertex call in `trustops-uat` returned HTTP 403 with a billing hold. Login alone did not restore model access.
- OpenAI transport, failure handling, secret loading and provider routing were verified with controlled test responses. No live OpenAI call has passed because no API key was configured during this check.
- The runtime's ERP connector remains `mock_sap`. Adding a model does not establish a live ERP integration, multi-instance storage safety or production readiness.

## Analysis failure and delivery behavior

Unavailable models return HTTP 503; unusable model analysis returns HTTP 502. Existing working analysis is preserved. A partly successful inventory updates only fully successful source documents and retains prior candidates for incomplete documents. Partial gap/roadmap batches also preserve prior working items. Reviewed items remain protected.

`GET /v1/report-library` returns customer-safe metadata and download routes for both published questionnaire reports and published document diagnostics. Drafts and other tenants' records stay hidden. Questionnaire exports support PDF/Word; document diagnostic exports currently support immutable HTML. Publication still requires a reviewer and source-digest checks.

Reference: [OpenAI structured output](https://developers.openai.com/api/docs/guides/structured-outputs), [current model guidance](https://developers.openai.com/api/docs/guides/latest-model).
