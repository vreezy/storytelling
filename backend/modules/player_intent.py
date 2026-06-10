"""
Player intent analysis business logic.

Analyzes everything the player has typed so far to work out what they want
from the story (goals, play style, preferred scenes) and produces a short
narrator instruction stored in games.player_intent. Called by the
POST /api/games/{id}/player-intent route in main.py (live mode) and by
workflow.py (offline batch mode). No FastAPI code in here — routes stay
in main.py.
"""

import json
import os

import httpx

from migrations import get_db

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")
STATIC_DIR  = os.environ.get("STATIC_DIR", "/app")

# Fallback when config.json is unreadable or lacks playerIntentPrompt.
DEFAULT_PROMPT = (
    "You analyze the player of an interactive text adventure. You are given "
    "every action and line of dialogue the player has entered so far, in order. "
    "Work out what the player wants from the story: their current goals, their "
    "play style, and the kinds of scenes they steer toward (combat, dialogue, "
    "exploration, romance, stealth, humor, ...). Base your analysis only on "
    "these inputs. Respond with 2-3 sentences of direct instruction to the "
    "narrator that start with 'The player', describing what the player is "
    "trying to achieve and what the narrator should offer more of. "
    "No commentary, no lists, no quoting the inputs."
)


def get_intent_prompt() -> str:
    try:
        with open(os.path.join(STATIC_DIR, "config.json"), encoding="utf-8") as f:
            return json.load(f).get("playerIntentPrompt") or DEFAULT_PROMPT
    except Exception:
        return DEFAULT_PROMPT


def fetch_user_inputs(game_id: int) -> list:
    conn = get_db()
    rows = conn.execute(
        """SELECT raw_input FROM turns
           WHERE game_id=? AND raw_input IS NOT NULL AND raw_input != ''
           ORDER BY turn_index""",
        (game_id,),
    ).fetchall()
    conn.close()
    return [r["raw_input"] for r in rows]


async def generate_player_intent(model_id: str, user_inputs: list, intent_prompt: str) -> str:
    """Ask Ollama what the player wants, based on all their inputs so far."""
    inputs_text = "\n".join(f"{i + 1}. {text}" for i, text in enumerate(user_inputs))

    ollama_req = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": intent_prompt},
            {"role": "user", "content": inputs_text},
        ],
        "stream": False,
        "options": {"temperature": 0.3, "num_predict": 120},
    }

    async with httpx.AsyncClient(timeout=None) as client:
        r = await client.post(f"{OLLAMA_HOST}/api/chat", json=ollama_req)
        data = r.json()
    return data.get("message", {}).get("content", "").strip()


def save_player_intent(game_id: int, intent: str):
    conn = get_db()
    conn.execute("UPDATE games SET player_intent=? WHERE id=?", (intent, game_id))
    conn.commit()
    conn.close()
