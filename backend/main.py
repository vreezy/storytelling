"""
StoryTelling — FastAPI backend
Serves the frontend at / and the REST API at /api/...
Ollama is expected at OLLAMA_HOST (default: http://host.docker.internal:11434)
"""

import json
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from migrations import get_db, init_db
from modules.describe import generate_description, get_describe_generation, get_describe_prompt
from modules.player_intent import (
    fetch_user_inputs, generate_player_intent, get_intent_prompt, save_player_intent,
)
from modules.summarize import generate_summary, save_summary

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")
STATIC_DIR  = os.environ.get("STATIC_DIR",  "/app")


# ── App lifecycle ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(lifespan=lifespan, title="StoryTelling Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Shared query helper ────────────────────────────────────────────────────────

# Scenario columns follow the Character Card V2 spec. Aliases avoid clashes
# with games columns (description, system_prompt).
_GAME_SELECT = """
    SELECT g.*,
           s.name                      AS scenario_name,
           s.icon                      AS scenario_icon,
           s.creator_notes             AS creator_notes,
           s.description               AS card_description,
           s.personality               AS personality,
           s.scenario                  AS scenario,
           s.first_mes                 AS first_mes,
           s.mes_example               AS mes_example,
           s.system_prompt             AS card_system_prompt,
           s.post_history_instructions AS post_history_instructions,
           s.alternate_greetings       AS alternate_greetings,
           s.tags                      AS tags,
           s.creator                   AS creator,
           s.character_version         AS character_version
    FROM games g
    LEFT JOIN scenarios s ON s.game_id = g.id
"""


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA_HOST}/api/tags")
            ollama_ok = r.status_code == 200
    except Exception:
        ollama_ok = False

    try:
        conn = get_db()
        conn.execute("SELECT 1")
        conn.close()
        db_ok = True
    except Exception:
        db_ok = False

    return {"ollama": "ok" if ollama_ok else "error", "db": "ok" if db_ok else "error"}


# ── Models ────────────────────────────────────────────────────────────────────

@app.get("/api/models")
async def list_models():
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{OLLAMA_HOST}/api/tags")
        if r.status_code != 200:
            raise HTTPException(502, "Ollama unreachable")
        return r.json()


@app.post("/api/models/pull")
async def pull_model(request: Request):
    body = await request.json()
    model_id = body.get("model_id", "").strip()
    if not model_id:
        raise HTTPException(400, "model_id required")

    async def stream():
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST",
                f"{OLLAMA_HOST}/api/pull",
                json={"name": model_id, "stream": True},
            ) as r:
                async for line in r.aiter_lines():
                    if line:
                        yield line + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.delete("/api/models/{model_id:path}")
async def delete_model(model_id: str):
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.request(
            "DELETE",
            f"{OLLAMA_HOST}/api/delete",
            json={"name": model_id},
        )
        if r.status_code not in (200, 404):
            raise HTTPException(502, f"Ollama error: {r.text}")
    return {"ok": True}


# ── Games ─────────────────────────────────────────────────────────────────────

@app.get("/api/games")
async def list_games():
    conn = get_db()
    rows = conn.execute(
        _GAME_SELECT + " ORDER BY g.last_played_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/games")
async def create_game(request: Request):
    body = await request.json()
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO games (title, description, scenario_id, model_id, system_prompt,
                              summarize_enabled, player_intent_enabled)
           VALUES (?,?,?,?,?,?,?)""",
        (
            body.get("title", "Untitled Adventure"),
            body.get("description"),
            body.get("scenario_id"),
            body.get("model_id"),
            body.get("system_prompt"),
            1 if body.get("summarize_enabled", 1) else 0,
            1 if body.get("player_intent_enabled", 1) else 0,
        ),
    )
    conn.commit()
    game_id = cur.lastrowid
    conn.execute(
        """INSERT INTO scenarios (game_id, name, icon, creator_notes, description,
                                  personality, scenario, first_mes, mes_example,
                                  system_prompt, post_history_instructions,
                                  alternate_greetings, tags, creator, character_version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            game_id,
            body.get("scenario_name", ""),
            body.get("scenario_icon", "📖"),
            body.get("creator_notes", ""),
            body.get("card_description"),
            body.get("personality"),
            body.get("scenario"),
            body.get("first_mes"),
            body.get("mes_example"),
            body.get("card_system_prompt"),
            body.get("post_history_instructions"),
            json.dumps(body.get("alternate_greetings", []), ensure_ascii=False),
            json.dumps(body.get("tags", []), ensure_ascii=False),
            body.get("creator", ""),
            body.get("character_version", ""),
        ),
    )
    conn.commit()
    row = conn.execute(_GAME_SELECT + " WHERE g.id=?", (game_id,)).fetchone()
    conn.close()
    return dict(row)


@app.get("/api/games/{game_id}")
async def get_game(game_id: int):
    conn = get_db()
    game = conn.execute(_GAME_SELECT + " WHERE g.id=?", (game_id,)).fetchone()
    if not game:
        conn.close()
        raise HTTPException(404, "Game not found")
    turns = conn.execute(
        "SELECT * FROM turns WHERE game_id=? ORDER BY turn_index", (game_id,)
    ).fetchall()
    conn.close()
    return {**dict(game), "turns": [dict(t) for t in turns]}


@app.put("/api/games/{game_id}")
async def update_game(game_id: int, request: Request):
    body = await request.json()

    game_fields     = ["title", "description", "num_predict", "system_prompt",
                       "story_summary", "summarize_enabled", "player_intent_enabled"]
    scenario_fields = ["scenario_name", "scenario_icon", "creator_notes", "card_description",
                       "personality", "scenario", "first_mes", "mes_example",
                       "card_system_prompt", "post_history_instructions",
                       "alternate_greetings", "tags", "creator", "character_version"]

    game_updates     = {k: body[k] for k in game_fields     if k in body}
    scenario_updates = {k: body[k] for k in scenario_fields if k in body}

    conn = get_db()

    if game_updates:
        cols = ", ".join(f"{k}=?" for k in game_updates)
        vals = list(game_updates.values()) + [game_id]
        conn.execute(f"UPDATE games SET {cols} WHERE id=?", vals)
        conn.commit()

    if scenario_updates:
        # Map API field names to Card V2 column names; list fields stored as JSON
        col_map = {
            "scenario_name":             "name",
            "scenario_icon":             "icon",
            "creator_notes":             "creator_notes",
            "card_description":          "description",
            "personality":               "personality",
            "scenario":                  "scenario",
            "first_mes":                 "first_mes",
            "mes_example":               "mes_example",
            "card_system_prompt":        "system_prompt",
            "post_history_instructions": "post_history_instructions",
            "alternate_greetings":       "alternate_greetings",
            "tags":                      "tags",
            "creator":                   "creator",
            "character_version":         "character_version",
        }
        for k in ("alternate_greetings", "tags"):
            if k in scenario_updates and not isinstance(scenario_updates[k], str):
                scenario_updates[k] = json.dumps(scenario_updates[k], ensure_ascii=False)
        conn.execute(
            "INSERT OR IGNORE INTO scenarios (game_id) VALUES (?)", (game_id,)
        )
        cols = ", ".join(f"{col_map[k]}=?" for k in scenario_updates)
        vals = list(scenario_updates.values()) + [game_id]
        conn.execute(f"UPDATE scenarios SET {cols} WHERE game_id=?", vals)
        conn.commit()

    row = conn.execute(_GAME_SELECT + " WHERE g.id=?", (game_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, "Game not found")
    return dict(row)


@app.delete("/api/games/{game_id}")
async def delete_game(game_id: int):
    conn = get_db()
    conn.execute("DELETE FROM games WHERE id=?", (game_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── Scenario export / import ──────────────────────────────────────────────────

def _json_or_default(text, default):
    try:
        return json.loads(text) if text else default
    except (json.JSONDecodeError, TypeError):
        return default


@app.get("/api/games/{game_id}/scenario")
async def export_game_scenario(game_id: int):
    """Export the game's scenario as a Character Card V2 JSON document."""
    conn = get_db()
    game = conn.execute(_GAME_SELECT + " WHERE g.id=?", (game_id,)).fetchone()
    if not game:
        conn.close()
        raise HTTPException(404, "Game not found")
    character = conn.execute(
        "SELECT * FROM characters WHERE game_id=?", (game_id,)
    ).fetchone()
    cards = conn.execute(
        "SELECT * FROM world_cards WHERE game_id=? ORDER BY sort_order, id", (game_id,)
    ).fetchall()
    conn.close()

    game = dict(game)

    entries = []
    for i, c in enumerate(cards):
        triggers = c["triggers"] or ""
        entries.append({
            "keys":            [t.strip() for t in triggers.split(",") if t.strip()],
            "content":         c["description"] or "",
            "extensions":      {"type": c["type"]},
            "enabled":         bool(c["active"]),
            "insertion_order": i,
            "name":            c["name"],
        })

    storytelling_ext = {"icon": game.get("scenario_icon") or "📖"}
    if character:
        mc = {"name": character["name"]}
        if character["class"]:
            mc["class"] = character["class"]
        if character["description"]:
            mc["description"] = character["description"]
        storytelling_ext["mainCharacters"] = [mc]

    return {
        "spec":         "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name":                      game.get("scenario_name") or game.get("title", ""),
            "description":               game.get("card_description") or "",
            "personality":               game.get("personality") or "",
            "scenario":                  game.get("scenario") or "",
            "first_mes":                 game.get("first_mes") or "",
            "mes_example":               game.get("mes_example") or "",
            "creator_notes":             game.get("creator_notes") or "",
            "system_prompt":             game.get("card_system_prompt") or "",
            "post_history_instructions": game.get("post_history_instructions") or "",
            "alternate_greetings":       _json_or_default(game.get("alternate_greetings"), []),
            "character_book":            {"entries": entries},
            "tags":                      _json_or_default(game.get("tags"), []),
            "creator":                   game.get("creator") or "",
            "character_version":         game.get("character_version") or "",
            "extensions":                {"storytelling": storytelling_ext},
        },
    }


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", name.strip().lower()).strip("-")
    return slug or "imported"


@app.post("/api/scenarios/import")
async def import_scenario(request: Request):
    """Import a Character Card V2 JSON document as a new scenario file."""
    body = await request.json()

    errors = []
    if body.get("spec") != "chara_card_v2":
        errors.append('"spec" must be "chara_card_v2" (V3 and other formats are not supported)')
    data = body.get("data") or {}
    if not data.get("name"):
        errors.append('missing "data.name"')
    book = data.get("character_book") or {}
    for i, entry in enumerate(book.get("entries", [])):
        if not isinstance(entry.get("content", ""), str) or not entry.get("content"):
            errors.append(f'character_book.entries[{i}] missing "content"')
        if not isinstance(entry.get("keys", []), list):
            errors.append(f'character_book.entries[{i}] "keys" must be a list')
    if errors:
        raise HTTPException(400, f"Validation failed: {'; '.join(errors)}")

    sc_id = body.get("id") or _slugify(data["name"])
    if not re.match(r"^[a-z0-9_-]+$", sc_id):
        sc_id = _slugify(sc_id)
    body.pop("id", None)  # id is derived from the filename, not stored in the card

    scenarios_dir = os.path.join(STATIC_DIR, "scenarios")
    with open(os.path.join(scenarios_dir, f"{sc_id}.json"), "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)

    index_path = os.path.join(scenarios_dir, "index.json")
    with open(index_path, encoding="utf-8") as f:
        index = json.load(f)
    ids = index.get("scenarios", [])
    if sc_id not in ids:
        ids.append(sc_id)
        index["scenarios"] = ids
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)

    return {"id": sc_id, **body}


# ── Summarize (business logic in modules/summarize.py) ───────────────────────

@app.post("/api/games/{game_id}/summarize")
async def summarize_game(game_id: int, request: Request):
    body = await request.json()
    messages_to_summarize = body.get("messages", [])
    existing_summary      = body.get("existing_summary", "")

    conn = get_db()
    game = conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    conn.close()
    if not game:
        raise HTTPException(404, "Game not found")

    summary = await generate_summary(
        dict(game)["model_id"], messages_to_summarize, existing_summary
    )
    save_summary(game_id, summary)
    return {"summary": summary}


# ── Player intent (business logic in modules/player_intent.py) ───────────────

@app.post("/api/games/{game_id}/player-intent")
async def analyze_player_intent(game_id: int):
    conn = get_db()
    game = conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    conn.close()
    if not game:
        raise HTTPException(404, "Game not found")

    user_inputs = fetch_user_inputs(game_id)
    if not user_inputs:
        return {"player_intent": ""}

    intent = await generate_player_intent(
        dict(game)["model_id"], user_inputs, get_intent_prompt()
    )
    save_player_intent(game_id, intent)
    return {"player_intent": intent}


# ── Scene description (business logic in modules/describe.py) ────────────────

@app.post("/api/games/{game_id}/describe")
async def describe_scene(game_id: int, request: Request):
    body = await request.json()
    messages  = body.get("messages", [])
    character = body.get("character", "")

    conn = get_db()
    game = conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    conn.close()
    if not game:
        raise HTTPException(404, "Game not found")
    if not messages:
        raise HTTPException(400, "messages required")

    description = await generate_description(
        dict(game)["model_id"], messages, character, get_describe_prompt(), get_describe_generation()
    )
    return {"description": description}


# ── Turns ─────────────────────────────────────────────────────────────────────

@app.post("/api/games/{game_id}/turns")
async def generate_turn(game_id: int, request: Request):
    body = await request.json()

    conn = get_db()
    row = conn.execute(
        "SELECT COALESCE(MAX(turn_index)+1, 0) AS next_idx FROM turns WHERE game_id=?",
        (game_id,),
    ).fetchone()
    next_idx = row["next_idx"]
    conn.close()

    model_id       = body.get("model_id", "")
    messages       = body.get("messages", [])
    action_type    = body.get("action_type")
    raw_input      = body.get("raw_input")
    temperature    = body.get("temperature", 0.75)
    num_predict    = body.get("num_predict", 200)
    repeat_penalty = body.get("repeat_penalty", 1.1)
    num_ctx        = body.get("num_ctx", 4096)
    num_gpu        = body.get("num_gpu", 99)
    num_batch      = body.get("num_batch", 512)

    ollama_req = {
        "model":      model_id,
        "messages":   messages,
        "stream":     True,
        "keep_alive": -1,
        "options": {
            "temperature":    temperature,
            "num_predict":    num_predict,
            "repeat_penalty": repeat_penalty,
            "num_ctx":        num_ctx,
            "num_gpu":        num_gpu,
            "num_batch":      num_batch,
        },
    }
    full_prompt = json.dumps(messages, ensure_ascii=False, indent=2)
    started_at  = datetime.now(timezone.utc).isoformat()

    async def stream():
        response_text     = ""
        prompt_tokens     = 0
        completion_tokens = 0
        last_chunk        = None
        error_msg         = None

        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_HOST}/api/chat",
                    json=ollama_req,
                ) as r:
                    async for line in r.aiter_lines():
                        if not line:
                            continue
                        chunk = json.loads(line)
                        token = chunk.get("message", {}).get("content", "")
                        if token:
                            response_text += token
                            yield json.dumps({"type": "token", "content": token}) + "\n"
                        if chunk.get("done"):
                            last_chunk = chunk

            if last_chunk is None:
                raise RuntimeError("Ollama closed stream without done=true")

            finished_at       = datetime.now(timezone.utc).isoformat()
            prompt_tokens     = last_chunk.get("prompt_eval_count", 0)
            completion_tokens = last_chunk.get("eval_count", 0)
            total_tokens      = prompt_tokens + completion_tokens
            t_start           = datetime.fromisoformat(started_at)
            t_end             = datetime.fromisoformat(finished_at)
            duration_ms       = int((t_end - t_start).total_seconds() * 1000)

            db = get_db()
            cur = db.execute(
                """INSERT INTO turns (
                    game_id, turn_index, action_type, raw_input,
                    model_id, full_prompt, ollama_request,
                    temperature, num_predict, repeat_penalty,
                    response, ollama_response,
                    prompt_tokens, completion_tokens, total_tokens,
                    started_at, finished_at, duration_ms
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    game_id, next_idx, action_type, raw_input,
                    model_id, full_prompt, json.dumps(ollama_req),
                    temperature, num_predict, repeat_penalty,
                    response_text, json.dumps(last_chunk),
                    prompt_tokens, completion_tokens, total_tokens,
                    started_at, finished_at, duration_ms,
                ),
            )
            turn_id = cur.lastrowid

            db.execute(
                "UPDATE games SET last_played_at=? WHERE id=?",
                (finished_at, game_id),
            )

            avg_tps = round(completion_tokens * 1000 / max(duration_ms, 1), 2)
            db.execute(
                """INSERT INTO model_stats
                    (model_id, total_turns, total_prompt_tok, total_compl_tok,
                     total_duration_ms, avg_tok_per_sec, last_used_at)
                   VALUES (?,1,?,?,?,?,?)
                   ON CONFLICT(model_id) DO UPDATE SET
                    total_turns       = total_turns + 1,
                    total_prompt_tok  = total_prompt_tok  + excluded.total_prompt_tok,
                    total_compl_tok   = total_compl_tok   + excluded.total_compl_tok,
                    total_duration_ms = total_duration_ms + excluded.total_duration_ms,
                    avg_tok_per_sec   = CASE
                        WHEN (total_duration_ms + excluded.total_duration_ms) > 0
                        THEN (total_compl_tok + excluded.total_compl_tok) * 1000.0
                             / (total_duration_ms + excluded.total_duration_ms)
                        ELSE 0 END,
                    last_used_at = excluded.last_used_at""",
                (model_id, prompt_tokens, completion_tokens, duration_ms, avg_tps, finished_at),
            )
            db.commit()
            db.close()

            yield json.dumps({
                "type":              "done",
                "turn_id":           turn_id,
                "prompt_tokens":     prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens":      total_tokens,
                "duration_ms":       duration_ms,
            }) + "\n"

        except Exception as exc:
            error_msg = str(exc)
            try:
                db = get_db()
                db.execute(
                    """INSERT INTO turns (game_id, turn_index, action_type, raw_input,
                           model_id, full_prompt, ollama_request, started_at, error)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (game_id, next_idx, action_type, raw_input,
                     model_id, full_prompt, json.dumps(ollama_req), started_at, error_msg),
                )
                db.commit()
                db.close()
            except Exception:
                pass
            yield json.dumps({"type": "error", "message": error_msg}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.put("/api/games/{game_id}/turns/{turn_id}")
async def update_turn(game_id: int, turn_id: int, request: Request):
    body = await request.json()
    allowed = ["raw_input", "response"]
    updates = {k: body[k] for k in allowed if k in body}
    conn = get_db()
    if updates:
        cols = ", ".join(f"{k}=?" for k in updates)
        vals = list(updates.values()) + [turn_id, game_id]
        conn.execute(f"UPDATE turns SET {cols} WHERE id=? AND game_id=?", vals)
        conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/games/{game_id}/turns/last")
async def undo_last_turn(game_id: int):
    conn = get_db()
    last = conn.execute(
        "SELECT id FROM turns WHERE game_id=? ORDER BY turn_index DESC LIMIT 1",
        (game_id,),
    ).fetchone()
    if last:
        conn.execute("DELETE FROM turns WHERE id=?", (last["id"],))
        conn.commit()
    conn.close()
    return {"ok": True}


# ── Characters ────────────────────────────────────────────────────────────────

@app.get("/api/games/{game_id}/character")
async def get_character(game_id: int):
    conn = get_db()
    row = conn.execute("SELECT * FROM characters WHERE game_id=?", (game_id,)).fetchone()
    conn.close()
    return dict(row) if row else {}


@app.put("/api/games/{game_id}/character")
async def upsert_character(game_id: int, request: Request):
    body = await request.json()
    now  = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    existing = conn.execute(
        "SELECT id FROM characters WHERE game_id=?", (game_id,)
    ).fetchone()
    stats_json = json.dumps(body["stats"]) if body.get("stats") else None
    if existing:
        conn.execute(
            """UPDATE characters
               SET name=?, description=?, class=?, stats=?, notes=?, updated_at=?
               WHERE game_id=?""",
            (body.get("name"), body.get("description"), body.get("class"),
             stats_json, body.get("notes"), now, game_id),
        )
    else:
        conn.execute(
            """INSERT INTO characters (game_id, name, description, class, stats, notes)
               VALUES (?,?,?,?,?,?)""",
            (game_id, body.get("name", "Hero"), body.get("description"),
             body.get("class"), stats_json, body.get("notes")),
        )
    conn.commit()
    row = conn.execute("SELECT * FROM characters WHERE game_id=?", (game_id,)).fetchone()
    conn.close()
    return dict(row)


# ── World Cards ───────────────────────────────────────────────────────────────

@app.get("/api/games/{game_id}/cards")
async def list_cards(game_id: int):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM world_cards WHERE game_id=? ORDER BY sort_order, id", (game_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/games/{game_id}/cards")
async def create_card(game_id: int, request: Request):
    body = await request.json()
    conn = get_db()
    cur  = conn.execute(
        """INSERT INTO world_cards (game_id, type, name, description, active, sort_order, triggers)
           VALUES (?,?,?,?,1,?,?)""",
        (game_id, body.get("type", "location"), body.get("name", ""),
         body.get("description"), body.get("sort_order", 0), body.get("triggers")),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM world_cards WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


@app.put("/api/games/{game_id}/cards/{card_id}")
async def update_card(game_id: int, card_id: int, request: Request):
    body = await request.json()
    now  = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    conn.execute(
        """UPDATE world_cards
           SET type=?, name=?, description=?, active=?, sort_order=?, triggers=?, updated_at=?
           WHERE id=? AND game_id=?""",
        (body.get("type", "location"), body.get("name"), body.get("description"),
         1 if body.get("active", True) else 0,
         body.get("sort_order", 0), body.get("triggers"), now, card_id, game_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM world_cards WHERE id=?", (card_id,)).fetchone()
    conn.close()
    return dict(row) if row else {}


@app.delete("/api/games/{game_id}/cards/{card_id}")
async def delete_card(game_id: int, card_id: int):
    conn = get_db()
    conn.execute("DELETE FROM world_cards WHERE id=? AND game_id=?", (card_id, game_id))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── Bookmarks ─────────────────────────────────────────────────────────────────

@app.get("/api/games/{game_id}/bookmarks")
async def list_bookmarks(game_id: int):
    conn = get_db()
    rows = conn.execute(
        """SELECT b.*, t.turn_index
           FROM bookmarks b JOIN turns t ON b.turn_id = t.id
           WHERE b.game_id=? ORDER BY t.turn_index""",
        (game_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/games/{game_id}/bookmarks")
async def create_bookmark(game_id: int, request: Request):
    body = await request.json()
    conn = get_db()
    cur  = conn.execute(
        "INSERT INTO bookmarks (game_id, turn_id, label) VALUES (?,?,?)",
        (game_id, body.get("turn_id"), body.get("label")),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM bookmarks WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


@app.delete("/api/games/{game_id}/bookmarks/{bm_id}")
async def delete_bookmark(game_id: int, bm_id: int):
    conn = get_db()
    conn.execute("DELETE FROM bookmarks WHERE id=? AND game_id=?", (bm_id, game_id))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── Stats ─────────────────────────────────────────────────────────────────────

@app.get("/api/stats")
async def get_stats():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM model_stats ORDER BY total_turns DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── Static files (must be last — catches everything not matched above) ─────────
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
