"""
Offline workflow engine.

Runs batch jobs over all games without the FastAPI server — for low-power
systems where live generation during play is turned off. Start it after a
game session and leave the computer:

    podman compose run --rm workflow

Each workflow module is a coroutine `async def run(game, turns, config)`
registered in MODULES below. To add a new offline job, put its business
logic in modules/<name>.py and register a runner function here.
"""

import asyncio
import json
import os

from migrations import get_db
from modules.player_intent import DEFAULT_PROMPT, generate_player_intent, save_player_intent
from modules.summarize import generate_summary, save_summary

STATIC_DIR = os.environ.get("STATIC_DIR", "/app")


def load_config() -> dict:
    with open(os.path.join(STATIC_DIR, "config.json"), encoding="utf-8") as f:
        return json.load(f)


# ── Workflow module: summarize ────────────────────────────────────────────────

async def run_summarize(game: dict, turns: list, config: dict):
    """Regenerate games.story_summary from scratch.

    Rebuilds the full message history, takes everything that has fallen out
    of the context window, and folds it chunk by chunk into a fresh rolling
    summary. Re-running is idempotent — the result replaces the old summary.
    """
    if not game.get("model_id"):
        print("  summarize: skipped (no model_id)")
        return

    messages = []
    if game.get("opening_text"):
        messages.append({"role": "assistant", "content": game["opening_text"]})
    for t in turns:
        if t["raw_input"]:
            messages.append({"role": "user", "content": t["raw_input"]})
        if t["response"]:
            messages.append({"role": "assistant", "content": t["response"]})

    max_messages = config.get("contextMaxMessages", 15)
    overflow = messages[:-max_messages] if len(messages) > max_messages else []
    if not overflow:
        print("  summarize: skipped (story still fits the context window)")
        return

    chunk_size = config.get("summarizeAfterMessages", 6)
    n_chunks = (len(overflow) + chunk_size - 1) // chunk_size
    print(f"  summarize: {len(overflow)} overflow messages → {n_chunks} chunk(s) to process")
    summary = ""
    for i in range(0, len(overflow), chunk_size):
        chunk = overflow[i:i + chunk_size]
        chunk_num = i // chunk_size + 1
        summary = await generate_summary(game["model_id"], chunk, summary)
        print(f"    chunk {chunk_num}/{n_chunks} ({len(chunk)} messages) → {len(summary)} chars")

    save_summary(game["id"], summary)
    print(f"  summarize: done")


# ── Workflow module: player intent ────────────────────────────────────────────

async def run_player_intent(game: dict, turns: list, config: dict):
    """Regenerate games.player_intent from all player inputs.

    Analyzes everything the player has typed in this game and saves the
    resulting narrator instruction. Re-running replaces the previous result.
    """
    if not game.get("model_id"):
        print("  player_intent: skipped (no model_id)")
        return

    user_inputs = [t["raw_input"] for t in turns if t["raw_input"]]
    if not user_inputs:
        print("  player_intent: skipped (no player inputs)")
        return

    print(f"  player_intent: {len(user_inputs)} player input(s) to analyze")
    intent_prompt = config.get("playerIntentPrompt") or DEFAULT_PROMPT
    intent = await generate_player_intent(game["model_id"], user_inputs, intent_prompt)
    save_player_intent(game["id"], intent)
    print(f"  player_intent: done")


# ── Registry — append future workflow modules here ────────────────────────────

MODULES = [
    ("summarize", run_summarize),
    ("player_intent", run_player_intent),
]


# ── Engine ────────────────────────────────────────────────────────────────────

async def main():
    config = load_config()

    conn = get_db()
    games = [dict(r) for r in conn.execute(
        """SELECT g.*, s.opening_text AS opening_text
           FROM games g LEFT JOIN scenarios s ON s.game_id = g.id
           ORDER BY g.id"""
    ).fetchall()]
    conn.close()

    print(f"Workflow: {len(games)} game(s), {len(MODULES)} module(s)\n")
    for game_idx, game in enumerate(games, 1):
        conn = get_db()
        turns = [dict(r) for r in conn.execute(
            "SELECT * FROM turns WHERE game_id=? ORDER BY turn_index",
            (game["id"],),
        ).fetchall()]
        conn.close()

        print(f"[{game_idx}/{len(games)}] Game {game['id']} — \"{game['title']}\" ({len(turns)} turns)")
        for mod_idx, (name, run) in enumerate(MODULES, 1):
            print(f"  [{mod_idx}/{len(MODULES)}] {name}")
            try:
                await run(game, turns, config)
            except Exception as exc:
                print(f"  {name}: FAILED — {exc}")
        print()

    print("Workflow finished.")


if __name__ == "__main__":
    asyncio.run(main())
