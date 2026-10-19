# TrustOps agent orchestration decision — 18 October 2026

## Recommendation

Use **LangGraph as the first candidate for TrustOps' outer workflow**. Retain the existing bounded model adapters, evidence validators, role checks, deterministic policies and report-publication gates. This is an engineering-fit recommendation, not a model-quality or production-performance ranking.

A reproducible comparison is in `experiments/orchestration`. It executes LangGraph, CrewAI Flows, and a LangGraph + CrewAI Flow hybrid against identical synthetic inputs and controlled model replies. It reuses the application's actual inventory and gap-analysis validators. The main API environment and live service do not depend on these experimental libraries.

## What the comparison establishes

Completed local run: **24/24 scenarios passed**, eight for each implementation. All three produced equivalent approved synthetic drafts. Versions: LangGraph 1.2.16, langgraph-checkpoint-sqlite 3.1.2, CrewAI 1.15.28. Machine-readable evidence is saved outside the repository at `../outputs/orchestration-evaluation-2026-10-18/comparison.json`. The existing backend suite also passed 228 tests; lint and dependency checks passed.

- Reviewer pause and process-restart resume can work with either framework and with a hybrid.
- Provider failure and invented quotations can fail closed when the existing validators remain authoritative.
- Tenant, reviewer-role, boolean-decision and source-digest checks must be explicit application gates; a framework does not establish the user's identity.
- Successfully completed analysis need not repeat when resuming from the tested review boundary.
- All implementations can produce an equivalent synthetic draft from equivalent controlled inputs. This is an equivalence assertion, not evidence of equal real-model quality.

The comparison does not establish real inference quality, real document/report UAT, production throughput/cost, Cloud Run durability, live ERP integration, autonomous Crew collaboration, automatic retry semantics, or readiness of the other shortlisted frameworks. SQLite results demonstrate local persistent state only. The current GCS snapshot application's single-writer constraint remains unresolved by adding an orchestrator.

## Why LangGraph first

TrustOps has an explicit customer journey: details, upload, questions/analysis, review and published reports. The existing system already has model clients and strict validators. LangGraph's explicit nodes, checkpoint state and review interrupts fit a controlled workflow without requiring an additional autonomous agent loop for each existing function. CrewAI Flows also supports these controls; the experiment does not show it is incapable or less reliable.

## Where CrewAI could add value

A bounded Crew may be useful for a future specialist task: several agents research supplied sources, challenge a draft and propose a consolidated summary. First measure whether that improves grounded findings over a single bounded model call. This comparison uses **Flows**, not autonomous Crews, and therefore does not demonstrate a benefit from role-based collaboration.

If that benefit is shown, run the Crew inside one LangGraph node, with an explicit input/output schema, allowed sources, timeout and call budget. Let LangGraph remain responsible for the outer review and resume boundary. Avoid duplicate approval, retry and publication ownership. A crash inside a hybrid node may repeat internal work; add inner checkpoints or idempotency if that work has side effects.

## Can all four be combined?

Technically, adapters and service boundaries can connect LangGraph, CrewAI, Google ADK and DeepSeek Harness. There is no evidence from this comparison that using all four improves TrustOps. It adds separate event, state, error and permission models to maintain.

| Component | Recommended role |
| --- | --- |
| LangGraph | Candidate outer workflow owner |
| CrewAI | Optional bounded specialist collaboration, after an incremental-benefit evaluation |
| Google ADK | Alternative outer framework; potentially a separately deployed agent service when a concrete Google integration requires it |
| DeepSeek Harness | Separate assistant/plugin experiment when a concrete use case requires its capabilities |

Hosting on Google Cloud does not require Google ADK. None of these frameworks supplies model inference by itself. API-key needs depend on the model route; a privately hosted model can avoid an external model-provider key, while still consuming hosting resources.

## Before live adoption

Choose an approved persistent checkpoint backend that survives container replacement; map authenticated tenant/assessment IDs to runs server-side; retain existing source-digest and publication checks; verify idempotency during restart/retry; stream actual execution events into the portal; and run representative documents against the real deployed model. Do not use this isolated evaluation's reviewer-payload fixture as production authorization.

References: [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview), [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [CrewAI Flows](https://docs.crewai.com/en/concepts/flows), [CrewAI human feedback](https://docs.crewai.com/en/learn/human-feedback-in-flows), [Google ADK](https://adk.dev/), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
