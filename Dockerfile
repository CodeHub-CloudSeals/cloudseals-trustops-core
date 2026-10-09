FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/packages/question-engine:/app/packages/reporting:/app/apps/assessment-api \
    TAAD_ENV=prod TAAD_AUTH_MODE=oidc
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --no-create-home taad
COPY packages packages
COPY apps apps
COPY taad_question_control_registry_v1.0.0.json taad_catalog_sha256.txt taad_swaska_agent_manifest_v1.json ./
# The portal config is replaced at deploy time with the Cognito endpoints.
USER 10001
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["uvicorn", "app.main:app", "--app-dir", "apps/assessment-api", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--no-server-header"]
