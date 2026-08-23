"""
Shared Ollama chat helper for the business-logic modules.

Wraps POST /api/chat (non-streaming) with proper error handling: HTTP
errors and Ollama-level {"error": ...} responses raise RuntimeError
instead of silently returning an empty string — callers must not mistake
a failed request for a valid empty answer.
"""

import os

import httpx

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")


async def chat(model_id: str, messages: list, options: dict) -> str:
    """Send a non-streaming chat request to Ollama and return the reply text."""
    req = {
        "model":    model_id,
        "messages": messages,
        "stream":   False,
        "options":  options,
    }
    async with httpx.AsyncClient(timeout=None) as client:
        r = await client.post(f"{OLLAMA_HOST}/api/chat", json=req)
    if r.status_code >= 400:
        try:
            detail = r.json().get("error", r.text)
        except ValueError:
            detail = r.text
        raise RuntimeError(f"Ollama HTTP {r.status_code}: {detail}")
    data = r.json()
    if data.get("error"):
        raise RuntimeError(f"Ollama error: {data['error']}")
    return data.get("message", {}).get("content", "").strip()
