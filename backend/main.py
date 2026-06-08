"""
StoryTelling — FastAPI backend
Serves the frontend at / and the REST API at /api/...
Ollama is expected at OLLAMA_HOST (default: http://host.docker.internal:11434)
"""

import json
import os
import re
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

DATABASE_PATH = os.environ.get("DATABASE_PATH", "/app/data/dungeon.db")
OLLAMA_HOST   = os.environ.get("OLLAMA_HOST",   "http://host.docker.internal:11434")
STATIC_DIR    = os.environ.get("STATIC_DIR",    "/app")


# ── Database ──────────────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
    schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
    with open(schema_path) as f:
        schema = f.read()
    conn = get_db()
    conn.executescript(schema)

    # ── Column-level migrations for existing databases ────────────────────────
    cols = {r[1] for r in conn.execute("PRAGMA table_info(games)").fetchall()}
    if "num_predict" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN num_predict INTEGER NOT NULL DEFAULT 150")
        conn.commit()
    if "custom_prompt" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN custom_prompt TEXT")
        conn.commit()
    if "story_summary" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN story_summary TEXT")
        conn.commit()

    card_cols = {r[1] for r in conn.execute("PRAGMA table_info(world_cards)").fetchall()}
    if "triggers" not in card_cols:
        conn.execute("ALTER TABLE world_cards ADD COLUMN triggers TEXT")
        conn.commit()

    # ── scenarios table (new installs get it from schema.sql) ─────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS scenarios (
            game_id         INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
            name            TEXT NOT NULL DEFAULT '',
            icon            TEXT NOT NULL DEFAULT '📖',
            description     TEXT NOT NULL DEFAULT '',
            scenario_prompt TEXT,
            opening_text    TEXT
        )
    """)
    conn.commit()

    # ── Migrate scenario_prompt / opening_text out of games (old DBs) ─────────
    if "scenario_prompt" in cols:
        conn.execute("""
            INSERT OR IGNORE INTO scenarios (game_id, scenario_prompt, opening_text)
            SELECT id, scenario_prompt, opening_text FROM games
        """)
        conn.commit()
        conn.executescript("""
            BEGIN;
            CREATE TABLE games_new (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                title          TEXT    NOT NULL DEFAULT 'Untitled Adventure',
                description    TEXT,
                scenario_id    TEXT,
                model_id       TEXT,
                system_prompt  TEXT,
                custom_prompt  TEXT,
                story_summary  TEXT,
                num_predict    INTEGER NOT NULL DEFAULT 150,
                created_at     DATETIME DEFAULT (datetime('now')),
                last_played_at DATETIME DEFAULT (datetime('now'))
            );
            INSERT INTO games_new
                SELECT id, title, description, scenario_id, model_id, system_prompt,
                       custom_prompt, story_summary, num_predict, created_at, last_played_at
                FROM games;
            DROP TABLE games;
            ALTER TABLE games_new RENAME TO games;
            CREATE INDEX IF NOT EXISTS idx_games_played ON games(last_played_at DESC);
            COMMIT;
        """)

    conn.close()


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

_GAME_SELECT = """
    SELECT g.*,
           s.name            AS scenario_name,
           s.icon            AS scenario_icon,
           s.description     AS scenario_description,
           s.scenario_prompt AS scenario_prompt,
           s.opening_text    AS opening_text
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
        """INSERT INTO games (title, description, scenario_id, model_id, system_prompt, custom_prompt)
           VALUES (?,?,?,?,?,?)""",
        (
            body.get("title", "Untitled Adventure"),
            body.get("description"),
            body.get("scenario_id"),
            body.get("model_id"),
            body.get("system_prompt"),
            body.get("custom_prompt"),
        ),
    )
    conn.commit()
    game_id = cur.lastrowid
    conn.execute(
        """INSERT INTO scenarios (game_id, name, icon, description, scenario_prompt, opening_text)
           VALUES (?,?,?,?,?,?)""",
        (
            game_id,
            body.get("scenario_name", ""),
            body.get("scenario_icon", "📖"),
            body.get("scenario_description", ""),
            body.get("scenario_prompt"),
            body.get("opening_text"),
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

    game_fields     = ["title", "description", "num_predict", "system_prompt", "custom_prompt", "story_summary"]
    scenario_fields = ["scenario_name", "scenario_icon", "scenario_description", "scenario_prompt", "opening_text"]

    game_updates     = {k: body[k] for k in game_fields     if k in body}
    scenario_updates = {k: body[k] for k in scenario_fields if k in body}

    conn = get_db()

    if game_updates:
        cols = ", ".join(f"{k}=?" for k in game_updates)
        vals = list(game_updates.values()) + [game_id]
        conn.execute(f"UPDATE games SET {cols} WHERE id=?", vals)
        conn.commit()

    if scenario_updates:
        # Map API field names to column names
        col_map = {
            "scenario_name":        "name",
            "scenario_icon":        "icon",
            "scenario_description": "description",
            "scenario_prompt":      "scenario_prompt",
            "opening_text":         "opening_text",
        }
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

@app.get("/api/games/{game_id}/scenario")
async def export_game_scenario(game_id: int):
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
    scenario_id = game.get("scenario_id") or f"game_{game_id}"

    export = {
        "id":           scenario_id,
        "name":         game.get("scenario_name") or game.get("title", ""),
        "icon":         game.get("scenario_icon") or "📖",
        "description":  game.get("scenario_description") or "",
        "scenarioPrompt": game.get("scenario_prompt") or "",
        "openingText":  game.get("opening_text") or "",
    }

    if character:
        mc = {"name": character["name"]}
        if character["class"]:
            mc["class"] = character["class"]
        if character["description"]:
            mc["description"] = character["description"]
        export["mainCharacters"] = [mc]

    if cards:
        export["cards"] = [
            {
                "type":        c["type"],
                "name":        c["name"],
                "description": c["description"] or "",
                "triggers":    c["triggers"] or "",
            }
            for c in cards
        ]

    return export


_VALID_CARD_TYPES = {"location", "npc", "item", "faction", "lore"}


@app.post("/api/scenarios/import")
async def import_scenario(request: Request):
    body = await request.json()

    errors = []
    sc_id = body.get("id", "")
    if not sc_id:
        errors.append('missing "id"')
    elif not re.match(r"^[a-z0-9_-]+$", sc_id):
        errors.append('"id" must match ^[a-z0-9_-]+$')
    if not body.get("name"):
        errors.append('missing "name"')
    for i, card in enumerate(body.get("cards", [])):
        if not card.get("type"):
            errors.append(f'card[{i}] missing "type"')
        elif card["type"] not in _VALID_CARD_TYPES:
            errors.append(f'card[{i}] invalid type "{card["type"]}"')
        if not card.get("name"):
            errors.append(f'card[{i}] missing "name"')
    if errors:
        raise HTTPException(400, f"Validation failed: {'; '.join(errors)}")

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

    return body


# ── Summarize ─────────────────────────────────────────────────────────────────

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

    turns_text = "\n".join(
        f"{'Player' if m['role'] == 'user' else 'Story'}: {m['content']}"
        for m in messages_to_summarize
    )
    if existing_summary:
        turns_text = f"Previous summary: {existing_summary}\n\nNew events:\n{turns_text}"

    ollama_req = {
        "model": dict(game)["model_id"],
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
    summary = data.get("message", {}).get("content", "").strip()

    conn = get_db()
    conn.execute("UPDATE games SET story_summary=? WHERE id=?", (summary, game_id))
    conn.commit()
    conn.close()
    return {"summary": summary}


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

    ollama_req = {
        "model": model_id,
        "messages": messages,
        "stream": True,
        "options": {
            "temperature":    temperature,
            "num_predict":    num_predict,
            "repeat_penalty": repeat_penalty,
            "num_ctx":        num_ctx,
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
