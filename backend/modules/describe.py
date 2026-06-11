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
    "Do not continue the story. Instead, create a very detailed visual "
    "snapshot of the current scene for a text-to-image model. Always use "
    "this exact structure and order: "
    "CAMERA: one line - shot type (wide shot, medium shot, or close-up), "
    "camera angle (eye level, low angle, high angle, or over-the-shoulder), "
    "and what the frame focuses on. "
    "CHARACTERS: for every character present, in order of importance: gender "
    "and apparent age, hair color and hairstyle, eye color, skin tone, body "
    "build and height, clothing in detail (colors, materials, condition), "
    "and their exact pose, facial expression, and position in the frame. "
    "SETTING: indoor or outdoor, the room or landscape, visible furniture "
    "and objects, weather. "
    "LIGHTING: brightness, time of day, light sources, dominant colors, "
    "atmosphere. "
    "TAGS: one single line of 20-30 comma-separated booru-style tags "
    "summarizing the whole scene (example: wide shot, eye level, 1girl, "
    "long red hair, leather armor, tavern interior, fireplace, dim lighting, "
    "night). "
    "Write CAMERA through LIGHTING as compact descriptive prose in present "
    "tense. Only what a camera would see - no story, no dialogue, no sounds, "
    "no smells, no inner thoughts. Be specific and concrete; never use vague "
    "words like beautiful or mysterious."
)

# Fallback generation parameters when config.json lacks describeGeneration.
DEFAULT_GENERATION = {
    "maxNewTokens": 600,
    "temperature": 0.2,
    "repetitionPenalty": 1.1,
    "numCtx": 4096,
    "numGpu": 99,
    "numBatch": 512,
}


def _load_config() -> dict:
    try:
        with open(os.path.join(STATIC_DIR, "config.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def get_describe_prompt() -> str:
    return _load_config().get("describePrompt") or DEFAULT_PROMPT


def get_describe_generation() -> dict:
    return {**DEFAULT_GENERATION, **_load_config().get("describeGeneration", {})}


async def generate_description(model_id: str, messages: list, character: str,
                               describe_prompt: str, generation: dict | None = None) -> str:
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

    gen = {**DEFAULT_GENERATION, **(generation or {})}
    ollama_req = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": describe_prompt},
            {"role": "user", "content": scene_text},
        ],
        "stream": False,
        "options": {
            "temperature":    gen["temperature"],
            "num_predict":    gen["maxNewTokens"],
            "repeat_penalty": gen["repetitionPenalty"],
            "num_ctx":        gen["numCtx"],
            "num_gpu":        gen["numGpu"],
            "num_batch":      gen["numBatch"],
        },
    }

    async with httpx.AsyncClient(timeout=None) as client:
        r = await client.post(f"{OLLAMA_HOST}/api/chat", json=ollama_req)
        data = r.json()
    return data.get("message", {}).get("content", "").strip()
