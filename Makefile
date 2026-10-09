PY=.venv/bin/python
export PYTHONPATH=packages/question-engine:packages/reporting:apps/assessment-api:.

.PHONY: dev seed test lint typecheck build demo
dev:       ; $(PY) -m uvicorn app.main:app --app-dir apps/assessment-api --reload --port 8000
seed:      ; $(PY) scripts/seed.py
test:      ; $(PY) -m pytest -q --ignore=tests/browser
browser:   ; $(PY) -m pytest -q tests/browser
lint:      ; .venv/bin/ruff check .
typecheck: ; .venv/bin/mypy --ignore-missing-imports packages/question-engine/question_engine packages/reporting/reporting
build:     lint typecheck test ; $(PY) validate_registry.py
demo:      ; $(PY) scripts/demo.py

.PHONY: tf-validate image
tf-validate:
	@for e in dev staging prod; do (cd infra/terraform/environments/$$e && terraform init -backend=false -input=false >/dev/null && terraform validate) || exit 1; done
image:     ; docker build -t taad:local .

.PHONY: openapi
openapi:   ; $(PY) -c "import json;from app.main import app;print(json.dumps(app.openapi(),indent=1))" > docs/openapi.generated.json
