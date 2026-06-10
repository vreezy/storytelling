"""
Database connection and migrations for StoryTelling backend.

Add new schema changes here as additional migrate_* functions and call them
at the bottom of run_migrations(). Every function must be idempotent — it
checks whether the change is already applied before executing it.
"""

import os
import sqlite3

DATABASE_PATH = os.environ.get("DATABASE_PATH", "/app/data/story.db")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ── Individual migrations (idempotent) ────────────────────────────────────────

def _migrate_games_columns(conn: sqlite3.Connection):
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


def _migrate_add_summarize_enabled(conn: sqlite3.Connection):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(games)").fetchall()}
    if "summarize_enabled" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN summarize_enabled INTEGER NOT NULL DEFAULT 1")
        conn.commit()


def _migrate_world_cards_columns(conn: sqlite3.Connection):
    card_cols = {r[1] for r in conn.execute("PRAGMA table_info(world_cards)").fetchall()}
    if "triggers" not in card_cols:
        conn.execute("ALTER TABLE world_cards ADD COLUMN triggers TEXT")
        conn.commit()


def _migrate_scenarios_table(conn: sqlite3.Connection):
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


def _migrate_scenario_columns_out_of_games(conn: sqlite3.Connection):
    """Move scenario_prompt / opening_text out of games into the scenarios table."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(games)").fetchall()}
    if "scenario_prompt" not in cols:
        return

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


# ── Entry point ───────────────────────────────────────────────────────────────

def init_db():
    os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
    schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
    with open(schema_path) as f:
        schema = f.read()

    conn = get_db()
    conn.executescript(schema)

    _migrate_games_columns(conn)
    _migrate_world_cards_columns(conn)
    _migrate_scenarios_table(conn)
    _migrate_scenario_columns_out_of_games(conn)
    _migrate_add_summarize_enabled(conn)

    conn.close()
