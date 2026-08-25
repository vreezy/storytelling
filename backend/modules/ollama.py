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


async def unload_others(model_id: str):
    """Unload every loaded model except model_id.

    Ollama's free-memory accounting overcommits on unified-memory GPUs (GTT),
    so a second resident model silently corrupts generation instead of being
    evicted. Called before each turn so the active model always has the full
    device memory to itself. Failures are ignored — worst case the old
    behavior (both models resident) applies.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{OLLAMA_HOST}/api/ps")
            loaded = [m["name"] for m in r.json().get("models", [])]
            for name in loaded:
                if name != model_id:
                    await client.post(
                        f"{OLLAMA_HOST}/api/generate",
                        json={"model": name, "keep_alive": 0},
                    )
    except Exception:
        pass


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
