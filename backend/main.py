"""
StoryTelling — FastAPI backend
Serves the frontend at / and the REST API at /api/...
Ollama is expected at OLLAMA_HOST (default: http://host.docker.internal:11434)
"""

import json
import os
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
    # Migrations for existing databases
    cols = {r[1] for r in conn.execute("PRAGMA table_info(games)").fetchall()}
    if "num_predict" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN num_predict INTEGER NOT NULL DEFAULT 150")
        conn.commit()
    if "scenario_prompt" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN scenario_prompt TEXT")
        conn.commit()
    if "custom_prompt" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN custom_prompt TEXT")
        conn.commit()
    card_cols = {r[1] for r in conn.execute("PRAGMA table_info(world_cards)").fetchall()}
    if "triggers" not in card_cols:
        conn.execute("ALTER TABLE world_cards ADD COLUMN triggers TEXT")
        conn.commit()
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
        "SELECT * FROM games ORDER BY last_played_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/games")
async def create_game(request: Request):
    body = await request.json()
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO games (title, description, scenario_id, model_id, system_prompt, scenario_prompt, custom_prompt, opening_text)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            body.get("title", "Untitled Adventure"),
            body.get("description"),
            body.get("scenario_id"),
            body.get("model_id"),
            body.get("system_prompt"),
            body.get("scenario_prompt"),
            body.get("custom_prompt"),
            body.get("opening_text"),
        ),
    )
    conn.commit()
    game_id = cur.lastrowid
    row = conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
    conn.close()
    return dict(row)


@app.get("/api/games/{game_id}")
async def get_game(game_id: int):
    conn = get_db()
    game = conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
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
    allowed = ["title", "description", "num_predict", "system_prompt", "scenario_prompt", "custom_prompt", "opening_text"]
    updates = {k: body[k] for k in allowed if k in body}
    conn = get_db()
    if updates:
        cols = ", ".join(f"{k}=?" for k in updates)
        vals = list(updates.values()) + [game_id]
        conn.execute(f"UPDATE games SET {cols} WHERE id=?", vals)
        conn.commit()
    row = conn.execute("SELECT * FROM games WHERE id=?", (game_id,)).fetchone()
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
