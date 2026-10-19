"""One process invocation; the comparison driver restarts this between review and resume."""
import argparse
import json
import os
import sys
from pathlib import Path

# Evaluation performs no network/model/telemetry calls.
os.environ['OTEL_SDK_DISABLED'] = 'true'
os.environ['CREWAI_TELEMETRY_ENABLED'] = 'false'
os.environ['CREWAI_TRACING_ENABLED'] = 'false'
os.environ['CREWAI_TESTING'] = 'true'
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'apps' / 'assessment-api'))

from experiments.orchestration import common


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', choices=['langgraph', 'crewai', 'hybrid'], required=True)
    parser.add_argument('--scenario', required=True)
    parser.add_argument('--db', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--review')
    args = parser.parse_args()
    if args.engine in ('crewai', 'hybrid'):
        # CrewAI's CLI imports a hardcoded per-user credential directory even for a keyless Flow.
        # Confine its empty test credential store to this evaluation's authorized output directory.
        from crewai_core.token_manager import TokenManager
        credential_dir = Path(args.db).parent / 'test-credentials'
        credential_dir.mkdir(mode=0o700, exist_ok=True)
        TokenManager._get_secure_storage_path = staticmethod(lambda: credential_dir)
    if args.engine == 'crewai':
        from experiments.orchestration.crewai_adapter import run
    else:
        from experiments.orchestration.langgraph_adapter import run
    calls = []
    try:
        state, events = run(args.db, args.scenario, calls, json.loads(args.review) if args.review else None,
                            hybrid=args.engine == 'hybrid')
        result = {'state': state, 'events': events, 'model_calls': calls, 'error': None}
    except Exception as exc:
        result = {'state': {}, 'events': [], 'model_calls': calls, 'error': type(exc).__name__ + ':' + str(exc)}
    common.write_json(args.output, result)


if __name__ == '__main__':
    main()
