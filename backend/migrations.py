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
    if "story_summary" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN story_summary TEXT")
        conn.commit()


def _migrate_add_summarize_enabled(conn: sqlite3.Connection):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(games)").fetchall()}
    if "summarize_enabled" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN summarize_enabled INTEGER NOT NULL DEFAULT 1")
        conn.commit()


def _migrate_add_player_intent(conn: sqlite3.Connection):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(games)").fetchall()}
    if "player_intent" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN player_intent TEXT")
        conn.commit()
    if "player_intent_enabled" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN player_intent_enabled INTEGER NOT NULL DEFAULT 1")
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


def _migrate_merge_custom_prompt_into_system_prompt(conn: sqlite3.Connection):
    """Fold games.custom_prompt into games.system_prompt and drop the column."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(games)").fetchall()}
    if "custom_prompt" not in cols:
        return
    conn.execute("""
        UPDATE games
        SET system_prompt = TRIM(COALESCE(system_prompt, '')
                                 || char(10) || char(10)
                                 || custom_prompt)
        WHERE custom_prompt IS NOT NULL AND custom_prompt != ''
    """)
    conn.execute("ALTER TABLE games DROP COLUMN custom_prompt")
    conn.commit()


def _migrate_scenarios_to_card_v2(conn: sqlite3.Connection):
    """Rebuild the scenarios table with Character Card V2 columns.

    Old → new: description → creator_notes (UI pitch), scenario_prompt →
    system_prompt (world rules, appended after the global system prompt),
    opening_text → first_mes. The V2 description column is UI-only text.
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(scenarios)").fetchall()}
    if "first_mes" in cols:
        return
    conn.executescript("""
        BEGIN;
        CREATE TABLE scenarios_v2 (
            game_id                   INTEGER  PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
            name                      TEXT     NOT NULL DEFAULT '',
            icon                      TEXT     NOT NULL DEFAULT '📖',
            creator_notes             TEXT     NOT NULL DEFAULT '',
            description               TEXT,
            personality               TEXT,
            scenario                  TEXT,
            first_mes                 TEXT,
            mes_example               TEXT,
            system_prompt             TEXT,
            post_history_instructions TEXT,
            alternate_greetings       TEXT NOT NULL DEFAULT '[]',
            tags                      TEXT NOT NULL DEFAULT '[]',
            creator                   TEXT NOT NULL DEFAULT '',
            character_version         TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO scenarios_v2 (game_id, name, icon, creator_notes, system_prompt, first_mes)
            SELECT game_id, name, icon, description, scenario_prompt, opening_text
            FROM scenarios;
        DROP TABLE scenarios;
        ALTER TABLE scenarios_v2 RENAME TO scenarios;
        COMMIT;
    """)


def _migrate_fix_card_v2_description(conn: sqlite3.Connection):
    """One-time fix for DBs migrated when the world text wrongly landed in
    scenarios.description instead of scenarios.system_prompt. Runs once,
    tracked via PRAGMA user_version (0 → 1)."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version >= 1:
        return
    cols = {r[1] for r in conn.execute("PRAGMA table_info(scenarios)").fetchall()}
    if "first_mes" in cols:
        conn.execute("""
            UPDATE scenarios
            SET system_prompt = description, description = ''
            WHERE (system_prompt IS NULL OR system_prompt = '')
              AND description IS NOT NULL AND description != ''
        """)
    conn.execute("PRAGMA user_version = 1")
    conn.commit()


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
    _migrate_add_player_intent(conn)
    _migrate_merge_custom_prompt_into_system_prompt(conn)
    _migrate_scenarios_to_card_v2(conn)
    _migrate_fix_card_v2_description(conn)

    conn.close()
