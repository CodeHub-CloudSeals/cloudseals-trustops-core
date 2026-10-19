"""Local engineering rehearsal only: actual capture -> dev reviewer -> published report.

This uses local-only seeded identities, never production authentication or customer approval.
"""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--url', default='http://127.0.0.1:8018')
    p.add_argument('--capture', required=True)
    p.add_argument('--output-dir', required=True)
    args = p.parse_args()
    u = urlsplit(args.url)
    if u.hostname != '127.0.0.1' or u.scheme != 'http' or u.path or u.username:
        p.error('This engineering rehearsal only accepts a loopback local dev service')

    def call(path, method='GET', body=None, token=None, raw=False, idem=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if idem:
            headers['Idempotency-Key'] = idem
        payload = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        with urlopen(Request(args.url + path, data=payload, method=method, headers=headers), timeout=30) as r:
            data = r.read()
        return data if raw else json.loads(data)

    tokens = {x['sub']: x['token'] for x in call('/v1/dev/users')['items']}
    customer, reviewer = tokens['admin@t-bank'], tokens['reviewer@cloudseals']
    capture = Path(args.capture).read_bytes()
    sha = hashlib.sha256(capture).hexdigest()
    a = call('/v1/assessments', 'POST', {'ai_system_name': 'Support portal — application evidence review',
             'industry': 'banking', 'questionnaire_version': '1.0.0'}, customer, idem='rea-delivery-' + sha)
    aid = a['assessment_id']
    grant = call(f'/v1/assessments/{aid}/evidence/upload-url', 'POST', {'filename': 'rea-trustops-capture.json',
                 'content_type': 'application/json', 'file_size_bytes': len(capture), 'claimed_sha256': sha}, customer)
    assert call(grant['upload_url'], 'PUT', capture, customer)['state'] == 'clean'
    base = f'/v1/assessments/{aid}/application-evidence'
    run = call(base, 'POST', {'evidence_id': grant['evidence_id']}, customer)
    url = f"{base}/{run['run_id']}"
    if run['status'] == 'awaiting_review':
        run = call(url + '/review', 'POST', {'decision': 'validated', 'source_digest': run['source_digest'],
                   'reason': 'Local engineering rehearsal: checked the actual owned-app REA capture and explicit scope limits. No customer sign-off.'}, reviewer)
    preview = call(url + '/report?preview=true', token=reviewer, raw=True)
    run = call(url + '/publish', 'POST', {'source_digest': run['source_digest'],
               'reason': 'Release technical observations for the local engineering rehearsal; backend controls remain unverified.'}, reviewer)
    report = call(url + '/report', token=customer, raw=True)
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'application-evidence-preview.html').write_bytes(preview)
    (out / 'application-evidence-report.html').write_bytes(report)
    (out / 'delivery.json').write_text(json.dumps({'assessment_id': aid, 'run_id': run['run_id'],
        'url': args.url + '/portal/#/assessment/' + aid, 'capture': run['capture'],
        'events': run['events'], 'releases': run['published'], 'verification': 'Local dev-role engineering rehearsal; not customer approval.'}, indent=2))
    print(args.url + '/portal/#/assessment/' + aid)
    print('Published HTML SHA-256:', hashlib.sha256(report).hexdigest())


if __name__ == '__main__':
    main()
