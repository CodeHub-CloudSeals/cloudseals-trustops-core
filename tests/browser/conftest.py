import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def base_url(tmp_path_factory):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    env = {**os.environ, "TAAD_SEED": "1", "TAAD_ENV": "local", "TAAD_AUTH_MODE": "dev",
           "TAAD_OBJECT_ROOT": str(tmp_path_factory.mktemp("objs")), "TAAD_DB": str(tmp_path_factory.mktemp("db") / "t.db"),
           "PYTHONPATH": os.pathsep.join(str(ROOT / p) for p in ("packages/question-engine", "packages/reporting", "apps/assessment-api", "."))}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", "apps/assessment-api", "--port", str(port)],
                            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}"
    for _ in range(60):
        try:
            urllib.request.urlopen(url + "/health")
            break
        except Exception:
            time.sleep(0.25)
    else:
        proc.kill()
        raise RuntimeError("server did not start")
    yield url
    proc.terminate()


@pytest.fixture()
def tokens(base_url):
    import json
    users = json.load(urllib.request.urlopen(base_url + "/v1/dev/users"))["items"]
    return {u["sub"]: u["token"] for u in users}


@pytest.fixture()
def api(base_url, tokens):
    import json
    import urllib.request as ur
    import uuid

    def call(sub, method, path, body=None, headers=None):
        h = {"Authorization": f"Bearer {tokens[sub]}", "Content-Type": "application/json", "Idempotency-Key": str(uuid.uuid4()), **(headers or {})}
        req = ur.Request(base_url + path, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
        try:
            with ur.urlopen(req) as r:
                return json.loads(r.read() or b"{}")
        except ur.HTTPError as e:
            raise AssertionError(f"{method} {path} -> {e.code} {e.read()[:200]}") from None
    return call


def login(page, base_url, sub):
    page.goto(base_url + "/portal/")
    page.evaluate("sessionStorage.clear()")
    page.goto(base_url + "/portal/")
    page.get_by_role("button", name=f"{sub} (").click()
    page.wait_for_selector("nav[aria-label=Primary]")
