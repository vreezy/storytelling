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
    summary = ""
    for i in range(0, len(overflow), chunk_size):
        chunk = overflow[i:i + chunk_size]
        summary = await generate_summary(game["model_id"], chunk, summary)
        print(f"  summarize: chunk {i // chunk_size + 1} "
              f"({len(chunk)} messages) -> {len(summary)} chars")

    save_summary(game["id"], summary)
    print(f"  summarize: saved ({len(overflow)} messages condensed)")


# ── Registry — append future workflow modules here ────────────────────────────

MODULES = [
    ("summarize", run_summarize),
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

    print(f"Workflow: {len(games)} game(s), {len(MODULES)} module(s)")
    for game in games:
        conn = get_db()
        turns = [dict(r) for r in conn.execute(
            "SELECT * FROM turns WHERE game_id=? ORDER BY turn_index",
            (game["id"],),
        ).fetchall()]
        conn.close()

        print(f"Game {game['id']} — \"{game['title']}\" ({len(turns)} turns)")
        for name, run in MODULES:
            try:
                await run(game, turns, config)
            except Exception as exc:
                print(f"  {name}: FAILED — {exc}")

    print("Workflow finished.")


if __name__ == "__main__":
    asyncio.run(main())
