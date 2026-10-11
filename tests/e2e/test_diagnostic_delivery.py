import hashlib

import pytest
from app import main, persist

from tests.conftest import new_assessment
from tests.e2e.test_studio import DOC, Fake, gap, item, maturity_json, uc, upload


@pytest.fixture()
def reviewed(env, monkeypatch):
    c, h = env
    aid = new_assessment(c, h, 'admin@t-bank')
    upload(c, h, aid, DOC.encode())
    rev = 'reviewer@cloudseals'
    ok = {'status': 'validated', 'reason': 'Checked against source evidence'}
    root = f'/v1/assessments/{aid}'
    monkeypatch.setattr(main, 'SWASKA_CLIENT', Fake({'use_cases': [uc()]}))
    uid = c.post(root + '/inventory/run', headers=h('admin@t-bank'), json={}).json()['use_cases'][0]['use_case_id']
    c.patch(root + f'/inventory/use-cases/{uid}', headers=h(rev), json=ok)
    monkeypatch.setattr(main, 'SWASKA_CLIENT', Fake({'findings': [gap(severity='critical', evidence_use_case_ids=[uid])]}))
    gid = c.post(root + '/gap-analysis/run', headers=h(rev), json={'framework_id': 'eu_ai_act'}).json()['gaps'][0]['gap_id']
    c.patch(root + f'/gaps/{gid}', headers=h(rev), json=ok)
    refs = {p: [uid] for p in main.studio.PRINCIPLES}
    monkeypatch.setattr(main, 'SWASKA_CLIENT', Fake(maturity_json(evidence_refs=refs)))
    c.post(root + '/maturity/run', headers=h(rev))
    c.patch(root + '/maturity', headers=h(rev), json=ok)
    monkeypatch.setattr(main, 'SWASKA_CLIENT', Fake({'roadmap_items': [item('a', gap_ids_addressed=[gid])], 'executive_summary': 'Act now.'}))
    rid = c.post(root + '/roadmap/run', headers=h(rev)).json()['roadmap'][0]['item_id']
    c.patch(root + f'/roadmap/{rid}', headers=h(rev), json=ok)
    return c, h, aid, uid, gid, rid


def preview(c, h, aid):
    return c.get(f'/v1/assessments/{aid}/diagnostic-report?format=json', headers=h('reviewer@cloudseals')).json()


def publish(c, h, aid, *, sub='reviewer@cloudseals', digest=None, key='publish', reason='Final report and roadmap checked'):
    digest = digest or preview(c, h, aid)['source_digest']
    return c.post(f'/v1/assessments/{aid}/diagnostic-report/publish', headers=h(sub, **{'Idempotency-Key': key}),
                  json={'source_digest': digest, 'reason': reason})


def test_publication_requires_reviewer_and_is_idempotent_tenant_scoped_and_frozen(reviewed):
    c, h, aid, uid, gid, rid = reviewed
    root = f'/v1/assessments/{aid}'
    assert c.get(root + '/diagnostic-report', headers=h('admin@t-bank')).status_code == 403
    assert c.get(root + '/inventory', headers=h('admin@t-bank')).json()['delivery'] is None
    assert publish(c, h, aid, sub='admin@t-bank').status_code == 403
    main.STORE.users['architect@cloudseals']['roles'] = ['cloudseals_assessor']
    assert publish(c, h, aid, sub='architect@cloudseals').status_code == 403  # assessors preview; reviewers publish
    assert publish(c, h, aid, sub='admin@t-health').status_code == 404
    assert publish(c, h, aid, reason='   ').status_code == 422
    no_key = c.post(root + '/diagnostic-report/publish', headers=h('reviewer@cloudseals'),
                    json={'source_digest': preview(c, h, aid)['source_digest'], 'reason': 'Checked'})
    assert no_key.status_code == 400
    released = publish(c, h, aid)
    assert released.status_code == 200, released.text
    r = released.json()
    assert publish(c, h, aid).json() == r
    assert publish(c, h, aid, key='another-request').json() == r
    assert len(main.STORE.inventory[aid]['published_diagnostics']) == 1
    assert sum(a['action'] == 'report.diagnostic_published' for a in main.STORE.audit) == 1
    delivered = c.get(root + '/inventory', headers=h('admin@t-bank')).json()['delivery']
    assert delivered['snapshot']['maturity']['overall_score'] == 1.5
    assert delivered['snapshot']['roadmap'][0]['item_id'] == rid and 'html' not in delivered
    download = c.get(root + '/diagnostic-report?narrative=true', headers=h('admin@t-bank'))
    assert download.status_code == 200 and download.headers['x-report-version'] == '1'
    assert download.headers['x-content-digest'] == hashlib.sha256(download.content).hexdigest() == r['content_digest']
    assert 'FINAL' in download.text and 'Item a' in download.text
    seen_by_customer = c.get(root + '/diagnostic-report?format=json', headers=h('admin@t-bank')).json()['published']
    assert seen_by_customer == {k: v for k, v in r.items() if k not in ('published_by', 'publication_reason')}     # who published and why stay internal
    assert c.get(root + '/diagnostic-report', headers=h('admin@t-health')).status_code == 404
    assert c.get(root + '/diagnostic-report?report_id=missing', headers=h('admin@t-bank')).status_code == 404

    # Later review decisions change working material but never the customer's released version.
    rejected = {'status': 'rejected', 'reason': 'New evidence requires another review'}
    c.patch(root + f'/gaps/{gid}', headers=h('reviewer@cloudseals'), json=rejected)
    c.patch(root + f'/inventory/use-cases/{uid}', headers=h('reviewer@cloudseals'), json=rejected)
    assert c.get(root + '/diagnostic-report', headers=h('admin@t-bank')).content == download.content
    assert c.get(root + '/inventory', headers=h('admin@t-bank')).json()['delivery'] == delivered
    assert preview(c, h, aid)['status'] == 'DRAFT'


def test_stale_preview_and_uncovered_or_invalid_reviewed_work_block_publication(reviewed):
    c, h, aid, uid, gid, rid = reviewed
    root = f'/v1/assessments/{aid}'
    old_digest = preview(c, h, aid)['source_digest']
    # A review reason is part of the checked material, so even a concurrent review invalidates an old preview.
    c.patch(root + '/maturity', headers=h('reviewer@cloudseals'), json={'status': 'validated', 'reason': 'Reviewed again'})
    stale = publish(c, h, aid, digest=old_digest)
    assert stale.status_code == 409 and stale.json()['code'] == 'report_changed'
    inv = main.STORE.inventory[aid]
    inv['roadmap'][0]['gap_ids_addressed'] = []
    blocked = publish(c, h, aid)
    assert blocked.status_code == 409 and 'critical/high gaps' in blocked.json()['message']
    inv['roadmap'][0]['gap_ids_addressed'] = [gid]
    c.patch(root + f'/inventory/use-cases/{uid}', headers=h('reviewer@cloudseals'), json={'status': 'rejected', 'reason': 'No longer evidenced'})
    bad = publish(c, h, aid)
    assert bad.status_code == 409 and 'no longer validated' in bad.json()['message']
    assert main.STORE.inventory[aid]['published_diagnostics'] == []


def test_new_versions_and_published_html_survive_storage_reload(reviewed, tmp_path):
    c, h, aid, uid, gid, rid = reviewed
    one = publish(c, h, aid).json()
    root = f'/v1/assessments/{aid}'
    old_html = c.get(root + '/diagnostic-report', headers=h('admin@t-bank')).content
    c.patch(root + '/maturity', headers=h('reviewer@cloudseals'), json={'status': 'validated', 'reason': 'Follow-up review completed'})
    two = publish(c, h, aid, key='second-version').json()
    assert two['version'] == 2 and one['report_id'] != two['report_id']
    url = f'sqlite:///{tmp_path / "delivery.db"}'
    persist.save(main.STORE, url)
    main.STORE.inventory.clear()
    assert persist.load(main.STORE, url)
    assert c.get(root + '/diagnostic-report?format=json', headers=h('admin@t-bank')).json()['published']['version'] == 2
    assert c.get(root + '/diagnostic-report?report_id=' + one['report_id'], headers=h('admin@t-bank')).content == old_html
    other = new_assessment(c, h, 'admin@t-bank', key='another-assessment')
    assert c.get(f'/v1/assessments/{other}/diagnostic-report?report_id=' + one['report_id'], headers=h('admin@t-bank')).status_code == 404


def test_customers_never_see_who_reviewed_or_the_reviewers_internal_notes(reviewed):
    import json
    c, h, aid, uid, gid, rid = reviewed
    assert publish(c, h, aid).status_code == 200
    customer = c.get(f'/v1/assessments/{aid}/inventory', headers=h('admin@t-bank')).json()
    blob = json.dumps(customer)
    for leaked in ('reviewer@cloudseals', 'reviewed_by', 'review_reason', 'reviewed_at', 'notes_for_architect', 'Checked against source evidence'):
        assert leaked not in blob, leaked
    assert customer['delivery']['snapshot']['gaps'][0]['status'] == 'VALIDATED'          # the content itself is still delivered
    assert customer['use_cases'][0]['status'] == 'VALIDATED' and customer['delivery']['snapshot']['maturity']['overall_score'] == 1.5
    staff = json.dumps(c.get(f'/v1/assessments/{aid}/inventory', headers=h('reviewer@cloudseals')).json())
    assert 'reviewer@cloudseals' in staff and 'notes_for_architect' in staff                # reviewers keep the full record
