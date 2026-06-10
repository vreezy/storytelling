"""
Summarization business logic.

Condenses story messages into a rolling summary stored in games.story_summary.
Called by the POST /api/games/{id}/summarize route in main.py (live mode) and
by workflow.py (offline batch mode). No FastAPI code in here — routes stay
in main.py.
"""

import os

import httpx

from migrations import get_db

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")


async def generate_summary(model_id: str, messages: list, existing_summary: str = "") -> str:
    """Ask Ollama to condense the given story messages into 2–3 sentences.

    messages: [{"role": "user"|"assistant", "content": str}, ...]
    existing_summary: previous rolling summary to fold the new events into.
    """
    turns_text = "\n".join(
        f"{'Player' if m['role'] == 'user' else 'Story'}: {m['content']}"
        for m in messages
    )
    if existing_summary:
        turns_text = f"Previous summary: {existing_summary}\n\nNew events:\n{turns_text}"

    ollama_req = {
        "model": model_id,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Summarize these story events in 2–3 sentences, past tense. "
                    "Be specific: names, locations, key actions. No commentary."
                ),
            },
            {"role": "user", "content": turns_text},
        ],
        "stream": False,
        "options": {"temperature": 0.3, "num_predict": 120},
    }

    async with httpx.AsyncClient(timeout=None) as client:
        r = await client.post(f"{OLLAMA_HOST}/api/chat", json=ollama_req)
        data = r.json()
    return data.get("message", {}).get("content", "").strip()


def save_summary(game_id: int, summary: str):
    conn = get_db()
    conn.execute("UPDATE games SET story_summary=? WHERE id=?", (summary, game_id))
    conn.commit()
    conn.close()
