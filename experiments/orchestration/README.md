# TrustOps orchestration evaluation

This is an isolated, reproducible engineering spike. It is not connected to the portal, customer storage, approvals, report publication or deployment. Application runtime requirements remain unchanged.

## What runs

Three implementations run the same synthetic document through the application's real `use_cases.run_inventory` and `run_gap_analysis` validators:

1. LangGraph: explicit inventory, gap, human-review interrupt and draft-report nodes, with SQLite checkpoints.
2. CrewAI **Flows**: equivalent steps with native non-blocking human feedback and SQLite persistence. This is not a benchmark of autonomous CrewAI Crews or model delegation.
3. Hybrid: a bounded CrewAI analysis Flow inside one LangGraph node; LangGraph owns outer checkpoints and review.

`ControlledModel` is a test double with explicitly synthetic responses. No external model calls, API credentials, customer uploads or real reviewer approvals are used. Drafts cannot be published by this spike. Runtime traces describe actual framework steps; they are not fabricated AI activity.

For each engine, the comparison checks approve, reject, ungrounded quotation, provider outage, incorrect reviewer tenant, stale review digest, incorrect reviewer role and non-boolean approval input. It ends the initial process and resumes review from a new Python process, verifying that successful analysis calls are not repeated. It also checks that an invalid review can be corrected without losing the pending assessment. SQLite here demonstrates persistence on a local disk; it does not establish durability on ephemeral Cloud Run storage. Live adoption requires an approved durable checkpoint store and existing application authorization/idempotency/publication gates.

The reviewer payload in this spike is test input. The production API must authenticate and authorize a reviewer and derive their identity/tenant server-side. Never trust role or tenant fields supplied by a browser.

## Reproduce

Use Python 3.12 and an isolated environment outside the application environment:

```sh
python3.12 -m venv /tmp/trustops-orchestration-env
/tmp/trustops-orchestration-env/bin/python -m pip install -r experiments/orchestration/requirements.txt
/tmp/trustops-orchestration-env/bin/python -m experiments.orchestration.compare --output-dir /tmp/trustops-orchestration-results
```

Use a fresh output directory per comparison. Machine-readable results are saved to `comparison.json`, including versions, per-scenario assertions, model-test-double calls and framework-step events. The results do not measure AI accuracy, inference latency, model cost, production load, or the other two frameworks in the earlier shortlist.

The worker disables telemetry/tracing and relocates CrewAI's automatically initialized empty CLI credential store into the evaluation output directory. CrewAI 1.15.28 hardcodes this path independently of its ordinary storage setting; this test-only relocation avoids writing into the user's actual credential directory. No application or provider credentials are read. CrewAI step markers are captured in executed Flow methods; LangGraph node updates come from its stream API.

## Architecture recommendation to assess

Keep one outer workflow owner. LangGraph can own state transitions, failures, review and resume; a CrewAI unit can optionally perform a bounded specialist task inside a node. Do not let both frameworks separately own approval, publication, retries and persistent assessment state. A restart inside a hybrid analysis node may repeat that node's work unless its internal work is checkpointed/idempotent; the tested resume boundary is after analysis, at review.

Google ADK is an alternative outer framework. DeepSeek Harness can be evaluated as a separate assistant/plugin environment. Neither was executed by this comparison. Adding all four to the same request path is technically possible through adapters, but provides no demonstrated benefit here and introduces more lifecycle/state/permission boundaries.

Sources: [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [CrewAI Flows](https://docs.crewai.com/en/concepts/flows), [CrewAI human feedback](https://docs.crewai.com/en/learn/human-feedback-in-flows).
