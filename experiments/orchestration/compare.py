"""Reproducible, model-free acceptance comparison. All report outputs are synthetic drafts."""
import argparse
import importlib.metadata
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    out = Path(args.output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    env = dict(os.environ, OTEL_SDK_DISABLED='true', CREWAI_TELEMETRY_ENABLED='false',
               CREWAI_TRACING_ENABLED='false', CREWAI_TESTING='true', XDG_DATA_HOME=str(out / 'data'),
               CREWAI_STORAGE_DIR=str(out / 'crewai'))
    for engine in ('langgraph', 'crewai', 'hybrid'):
        for scenario in ('approved', 'rejected', 'ungrounded', 'unavailable', 'wrong_tenant', 'stale_digest', 'wrong_role', 'invalid_boolean'):
            db = out / f'{engine}-{scenario}.sqlite'
            result_path = out / f'{engine}-{scenario}.json'
            if db.exists():
                raise FileExistsError('Use a fresh output directory for each comparison')

            def call(review=None, engine=engine, scenario=scenario, db=db, result_path=result_path):
                cmd = [sys.executable, '-m', 'experiments.orchestration.worker', '--engine', engine,
                       '--scenario', scenario, '--db', str(db), '--output', str(result_path)]
                if review:
                    cmd += ['--review', json.dumps(review)]
                p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=90)
                if p.returncode:
                    raise RuntimeError(f'{engine} process failed: {p.stderr[-1500:]}')
                return json.loads(result_path.read_text())

            first = call()
            if scenario in ('ungrounded', 'unavailable'):
                checks = {'fails_closed': bool(first['error']), 'inventory_validator_was_exercised': first['model_calls'] == ['inventory'],
                          'no_report': not first['state'].get('report')}
                second = None
            else:
                checks = {'pauses_before_report': first['state'].get('status') == 'awaiting_review' and not first['state'].get('report'),
                          'both_product_validators_were_exercised': first['model_calls'] == ['inventory', 'gaps']}
                if checks['pauses_before_report']:
                    review = {'approved': scenario != 'rejected', 'role': 'reviewer', 'tenant': 'synthetic-tenant',
                              'digest': first['state']['review_digest']}
                    if scenario == 'wrong_tenant':
                        review['tenant'] = 'another-tenant'
                    if scenario == 'stale_digest':
                        review['digest'] = 'stale'
                    if scenario == 'wrong_role':
                        review['role'] = 'customer'
                    if scenario == 'invalid_boolean':
                        review['approved'] = 'false'
                    second = call(review)
                    checks['does_not_repeat_model_calls_after_restart'] = second['model_calls'] == []
                    if scenario in ('wrong_tenant', 'stale_digest', 'wrong_role', 'invalid_boolean'):
                        checks['invalid_review_blocked'] = bool(second['error']) and not second['state'].get('report')
                        corrected = call({'approved': True, 'role': 'reviewer', 'tenant': 'synthetic-tenant',
                                          'digest': first['state']['review_digest']})
                        checks['corrected_review_still_resumes'] = not corrected['error'] and corrected['state'].get('status') == 'reviewed_draft'
                        checks['correction_does_not_repeat_analysis'] = corrected['model_calls'] == []
                    else:
                        checks['resumes_after_process_restart'] = not second['error']
                        checks['expected_report_state'] = (second['state'].get('status') ==
                                                           ('rejected' if scenario == 'rejected' else 'reviewed_draft'))
                        checks['publication_never_happened'] = second['state'].get('status') != 'published'
                else:
                    second = None
            rows.append({'engine': engine, 'scenario': scenario, 'passed': all(checks.values()), 'checks': checks,
                         'initial': first, 'resumed_in_new_process': second})
            print(engine, scenario, 'PASS' if all(checks.values()) else 'FAIL', flush=True)
    result = {'scope': 'Synthetic workflow/control tests only; no real model accuracy, latency, cost or production UAT.',
              'versions': {p: importlib.metadata.version(p) for p in ('langgraph', 'langgraph-checkpoint-sqlite', 'crewai')},
              'results': rows}
    approved_reports = [row['resumed_in_new_process']['state'].get('report') for row in rows
                        if row['scenario'] == 'approved' and row['resumed_in_new_process']]
    result['equivalent_approved_reports'] = len(approved_reports) == 3 and all(r == approved_reports[0] for r in approved_reports)
    (out / 'comparison.json').write_text(json.dumps(result, indent=2) + '\n')
    if not all(row['passed'] for row in rows) or not result['equivalent_approved_reports']:
        sys.exit(1)


if __name__ == '__main__':
    main()
