"""Provider-neutral text-only model clients. Agents never get tools or credentials; they send text and get text back.

Providers: `vertex` (Gemini on Vertex AI, GCP) and `bedrock` (AWS, kept in swaska.py / trustops_runtime.py).
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
