import io
import json

import pytest
from app import main, security


@pytest.fixture
def google(monkeypatch, env):
    claims = {"sub": "123", "email": "naveen.m@cloudseals.co.uk", "email_verified": True}
    import google.oauth2.id_token as idt
    monkeypatch.setattr(idt, "verify_oauth2_token", lambda token, req, audience=None: (
        claims if token == "good" and audience == "client-1" else (_ for _ in ()).throw(ValueError("bad token"))))
    monkeypatch.setattr(security, "AUTH_MODE", "oidc")
    monkeypatch.setattr(security, "AUTH_PROVIDER", "google")
    monkeypatch.setattr(main, "AUTH_MODE", "oidc")
    monkeypatch.setattr(main, "AUTH_PROVIDER", "google")
    monkeypatch.setattr(main, "ENV", "dev")
    monkeypatch.setenv("TAAD_GOOGLE_CLIENT_ID", "client-1")
    monkeypatch.setenv("TAAD_FIRST_ADMIN_EMAIL", "naveen.m@cloudseals.co.uk")
    main.STORE.users.clear()   # the seeded dev users include admins; start from an empty directory
    return env[0], claims


def me(c, token="good"):
    return c.get("/v1/me", headers={"Authorization": f"Bearer {token}"})


def test_invalid_google_token_is_rejected(google):
    c, _ = google
    assert me(c, "forged").status_code == 401


def test_first_admin_bootstrap_by_verified_email_is_one_time(google):
    c, claims = google
    r = me(c)
    assert r.status_code == 200 and "cloudseals_admin" in r.json()["roles"]
    assert main.STORE.admin_bootstrap["email"] == "naveen.m@cloudseals.co.uk"
    assert any(a["action"] == "admin.bootstrap" for a in main.STORE.audit)
    # a different verified Google user does not become admin, even with the right token shape
    claims.update(sub="999", email="someone@else.com")
    assert me(c).status_code == 401


def test_unverified_email_or_wrong_env_never_bootstraps(google, monkeypatch):
    c, claims = google
    claims["email_verified"] = False
    assert me(c).status_code == 401
    claims["email_verified"] = True
    monkeypatch.setattr(main, "ENV", "prod")
    assert me(c).status_code == 401
    assert not main.STORE.users


def test_portal_config_uses_google_and_same_origin_token_exchange(google, monkeypatch):
    c, _ = google
    monkeypatch.setenv("TAAD_PORTAL_REDIRECT_URI", "https://app.example.com/portal/")
    cfg = c.get("/portal/config.json").json()["oidc"]
    assert cfg["provider"] == "google" and cfg["token_url"] == "/v1/auth/token" and cfg["client_id"] == "client-1"
    assert cfg["authorize_url"].startswith("https://accounts.google.com/")


def test_token_exchange_only_serves_our_client_and_returns_id_token(google, monkeypatch):
    c, _ = google
    monkeypatch.setenv("TAAD_PORTAL_REDIRECT_URI", "https://app.example.com/portal/")
    monkeypatch.setenv("TAAD_GOOGLE_CLIENT_SECRET", "s3cret")
    base = {"grant_type": "authorization_code", "code": "c", "code_verifier": "v", "client_id": "client-1",
            "redirect_uri": "https://app.example.com/portal/"}
    assert c.post("/v1/auth/token", data={**base, "client_id": "attacker"}).status_code == 400
    assert c.post("/v1/auth/token", data={**base, "redirect_uri": "https://evil.example/"}).status_code == 400
    sent = {}

    class Resp(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout=0):
        sent["body"] = req.data.decode()
        return Resp(json.dumps({"id_token": "good", "access_token": "opaque", "expires_in": 3599}).encode())
    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    r = c.post("/v1/auth/token", data=base)
    assert r.status_code == 200 and r.json()["access_token"] == "good"      # the ID token, never Google's opaque access token
    assert "client_secret=s3cret" in sent["body"]


def test_token_exchange_is_off_without_google_provider(env):
    assert env[0].post("/v1/auth/token", data={}).status_code == 404
