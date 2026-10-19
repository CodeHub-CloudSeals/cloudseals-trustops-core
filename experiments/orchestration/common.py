"""Synthetic orchestration evaluation; reuses the real TrustOps evidence validators.

Never imports the API's STORE, publishes a report, or contacts a model provider.
"""
import hashlib
import json
from pathlib import Path

from app import use_cases

DOCUMENT = 'The customer support chatbot answers account FAQs. Support owns the chatbot. It cannot change accounts.'
QUOTE = 'The customer support chatbot answers account FAQs.'


class ControlledModel:
    """Explicit test double, not an AI model. Shared by all evaluated engines."""

    def __init__(self, scenario, calls):
        self.scenario, self.calls = scenario, calls

    def complete(self, system, user, max_tokens=600):
        inventory = 'Inventory Agent' in system
        self.calls.append('inventory' if inventory else 'gaps')
        if self.scenario == 'unavailable':
            raise ConnectionError('Synthetic provider outage')
        if inventory:
            return json.dumps({'use_cases': [{
                'name': 'Support chatbot', 'description': 'Answers account FAQs.', 'business_owner': 'Support',
                'technical_owner': None, 'model_type': None, 'foundation_models_used': [],
                'decision_authority': 'advisory', 'data_sources': [], 'risk_tier': 'limited_risk',
                'risk_tier_rationale': 'Candidate transparency review needed.', 'extraction_confidence': 0.9,
                'source_quotes': ['Invented quotation absent from source.'] if self.scenario == 'ungrounded' else [QUOTE],
            }]})
        source = json.loads(user.split('<untrusted>', 1)[1].split('</untrusted>', 1)[0])
        return json.dumps({'findings': [{
            'framework_clause': 'Article_5', 'finding_title': 'Screening evidence needed',
            'finding_description': 'The supplied register does not document prohibition screening.',
            'severity': 'medium', 'recommendation_summary': 'Request screening records for reviewer assessment.',
            'estimated_effort_days': 3, 'suggested_timeline': '0-90',
            'evidence_use_case_ids': [source[0]['use_case_id']], 'evidence_quotes': [QUOTE],
        }]})


def inventory(scenario, calls):
    result = use_cases.run_inventory(ControlledModel(scenario, calls), [
        {'evidence_id': 'synthetic-e1', 'filename': 'synthetic-register.txt', 'text': DOCUMENT}])
    if result['status'] != 'completed' or not result['items']:
        raise ValueError('inventory_not_accepted')
    return result['items']


def gaps(items, scenario, calls):
    result = use_cases.run_gap_analysis(ControlledModel(scenario, calls), 'eu_ai_act', items)
    if result['status'] != 'completed' or not result['items']:
        raise ValueError('gaps_not_accepted')
    return result['items']


def digest(items, findings):
    return hashlib.sha256(json.dumps([items, findings], sort_keys=True).encode()).hexdigest()


def decision(raw, expected_digest):
    value = json.loads(raw) if isinstance(raw, str) else raw
    # Test-only boundary. The live product must authenticate the reviewer on the server.
    if not isinstance(value, dict) or value.get('role') != 'reviewer' or value.get('tenant') != 'synthetic-tenant' \
            or value.get('digest') != expected_digest or type(value.get('approved')) is not bool:
        raise ValueError('invalid_review_context')
    return value['approved']


def report(items, findings, approved):
    if not approved:
        return {'status': 'rejected', 'report': None}
    return {'status': 'reviewed_draft', 'report': {'notice': 'SYNTHETIC EVALUATION — NOT PUBLISHED',
            'use_case_count': len(items), 'gap_count': len(findings), 'digest': digest(items, findings)}}


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')
