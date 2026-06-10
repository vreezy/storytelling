"""
Scene description business logic.

Generates a detailed visual snapshot of the current scene (characters,
clothing, poses, setting, lighting) intended as input for a text-to-image
model. Called by the POST /api/games/{id}/describe route in main.py.
The result is ephemeral — nothing is written to the database. No FastAPI
code in here — routes stay in main.py.
"""

import json
import os

import httpx

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")
STATIC_DIR  = os.environ.get("STATIC_DIR", "/app")

# Fallback when config.json is unreadable or lacks describePrompt.
DEFAULT_PROMPT = (
    "Do not continue the story. Instead, describe the current scene as one "
    "detailed visual snapshot for a text-to-image model. Describe every "
    "character present, without using any names: gender and apparent age, "
    "hair color and hairstyle, eye color, skin tone, body build and height, "
    "clothing in detail (colors, materials, condition), and their exact pose "
    "and position in the scene. Then describe the setting: indoor or outdoor, "
    "the room or landscape, visible furniture and objects, lighting (bright, "
    "dim, dark, time of day, light sources), dominant colors, weather and "
    "atmosphere. Write compact descriptive sentences in present tense, "
    "characters first, then the setting. Only what a camera would see - "
    "no names, no story, no dialogue, no sounds, no smells, no emotions."
)


def get_describe_prompt() -> str:
    try:
        with open(os.path.join(STATIC_DIR, "config.json"), encoding="utf-8") as f:
            return json.load(f).get("describePrompt") or DEFAULT_PROMPT
    except Exception:
        return DEFAULT_PROMPT


async def generate_description(model_id: str, messages: list, character: str,
                               describe_prompt: str) -> str:
    """Ask Ollama for a visual description of the scene in the given messages.

    messages: recent story context [{"role": "user"|"assistant", "content": str}, ...]
    character: optional protagonist context (may contain appearance details).
    """
    scene_text = "\n".join(
        f"{'Player' if m['role'] == 'user' else 'Story'}: {m['content']}"
        for m in messages
    )
    if character:
        scene_text = f"{character}\n\n{scene_text}"

    ollama_req = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": describe_prompt},
            {"role": "user", "content": scene_text},
        ],
        "stream": False,
        "options": {"temperature": 0.5, "num_predict": 350},
    }

    async with httpx.AsyncClient(timeout=None) as client:
        r = await client.post(f"{OLLAMA_HOST}/api/chat", json=ollama_req)
        data = r.json()
    return data.get("message", {}).get("content", "").strip()
