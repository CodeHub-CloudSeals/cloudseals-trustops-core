"""Provider-neutral text-only model clients. Agents never get tools or credentials; they send text and get text back.

Providers: `openai` (Responses API), `vertex` (Gemini on Vertex AI) and `bedrock` (AWS adapters).
Select with TAAD_LLM_PROVIDER=vertex plus TAAD_VERTEX_MODEL / TAAD_VERTEX_LOCATION / GOOGLE_CLOUD_PROJECT.
"""
from __future__ import annotations

import os
from typing import Any

DEFAULT_VERTEX_MODEL = "gemini-2.5-flash"


class VertexModelClient:
    """Gemini via the google-genai SDK in Vertex mode (uses the Cloud Run service account; no API keys)."""

    def __init__(self, model_id: str | None = None, project: str | None = None, location: str | None = None,
                 client: Any = None) -> None:
        self.model_id = model_id or os.environ.get("TAAD_VERTEX_MODEL", DEFAULT_VERTEX_MODEL)
        if client is None:
            from google import genai  # lazy: optional dependency
            from google.genai import types
            client = genai.Client(vertexai=True, project=project or os.environ["GOOGLE_CLOUD_PROJECT"],
                                  location=location or os.environ.get("TAAD_VERTEX_LOCATION", "europe-west1"),
                                  http_options=types.HttpOptions(timeout=60_000))
        self.client = client

    def complete(self, system: str, user: str, max_tokens: int = 600) -> str:
        from google.genai import types
        cfg: dict[str, Any] = {"system_instruction": system, "temperature": 0, "max_output_tokens": max_tokens,
                               "response_mime_type": "application/json"}
        if "flash" in self.model_id:  # 2.5 "thinking" tokens would otherwise eat the output budget and truncate the JSON
            cfg["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        response = self.client.models.generate_content(model=self.model_id, contents=user,
                                                       config=types.GenerateContentConfig(**cfg))
        text = getattr(response, "text", None)
        if not text:
            raise ValueError("model response did not contain text")
        return text


def provider() -> str:
    """Active provider name, or '' when no model is configured (deterministic mode)."""
    explicit = os.environ.get("TAAD_LLM_PROVIDER", "").strip().lower()
    if explicit:
        return explicit
    if os.environ.get("TAAD_SWASKA_MODEL") == "bedrock" or os.environ.get("TRUSTOPS_AGENT_MODEL_ID", "").strip():
        return "bedrock"
    return ""


def vertex_client() -> VertexModelClient | None:
    return VertexModelClient() if provider() == "vertex" else None


class OpenAIModelClient:
    """Text-only Responses API adapter. Keys stay on the server; agents receive no tools or credentials."""

    def __init__(self, model_id: str | None = None, api_key: str | None = None, opener: Any = None) -> None:
        from pathlib import Path
        from urllib.request import HTTPRedirectHandler, build_opener

        self.model_id = model_id or os.environ.get("TAAD_OPENAI_MODEL", "gpt-6-luna")
        self.reasoning = os.environ.get("TAAD_OPENAI_REASONING", "none")
        key = api_key or os.environ.get("OPENAI_API_KEY", "")
        if not key and os.environ.get("OPENAI_API_KEY_FILE"):
            with Path(os.environ["OPENAI_API_KEY_FILE"]).open() as secret:
                key = secret.read(4097)
        self._key = key.strip()
        if not self._key or len(self._key) > 4096 or any(c in self._key for c in "\r\n"):
            raise ValueError("Configure a valid server-side OPENAI_API_KEY or OPENAI_API_KEY_FILE")

        class NoRedirect(HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None  # Never forward the server credential to a redirected destination.

        self._opener = opener or build_opener(NoRedirect())

    def complete(self, system: str, user: str, max_tokens: int = 600) -> str:
        import json
        from urllib.error import HTTPError
        from urllib.request import Request

        if not 1 <= max_tokens <= 16000:
            raise ValueError("Output token budget must be between 1 and 16000")
        payload = {"model": self.model_id, "store": False, "instructions": system + "\nReturn one JSON object only.",
                   "input": user, "max_output_tokens": max_tokens, "reasoning": {"effort": self.reasoning},
                   "text": {"format": {"type": "json_object"}}}
        request = Request("https://api.openai.com/v1/responses", method="POST", data=json.dumps(payload).encode(),
                          headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=60) as response:
                raw = response.read(2_000_001)
        except HTTPError as exc:
            code = exc.code
            exc.close()
            raise RuntimeError(f"OpenAI request failed (HTTP {code}); check server credentials, model access and account quota") from None
        if len(raw) > 2_000_000:
            raise ValueError("OpenAI response exceeded the permitted size")
        result = json.loads(raw)
        if result.get("status") != "completed":
            raise ValueError("OpenAI response did not complete; no analysis was accepted")
        parts = []
        for item in result.get("output", []):
            if item.get("type") != "message":
                continue
            for block in item.get("content", []):
                if block.get("type") == "refusal":
                    raise ValueError("OpenAI declined this request; no analysis was accepted")
                if block.get("type") == "output_text" and isinstance(block.get("text"), str):
                    parts.append(block["text"])
        text = "".join(parts)
        if not isinstance(json.loads(text), dict):
            raise ValueError("OpenAI did not return a JSON object")
        return text


def configured_model_id() -> str | None:
    active = provider()
    if active == "openai":
        return os.environ.get("TAAD_OPENAI_MODEL", "gpt-6-luna")
    if active == "vertex":
        return os.environ.get("TAAD_VERTEX_MODEL", DEFAULT_VERTEX_MODEL)
    if active == "bedrock":
        return os.environ.get("TRUSTOPS_AGENT_MODEL_ID") or os.environ.get("TAAD_BEDROCK_MODEL_ID")
    return None
