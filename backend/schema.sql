-- ── Games ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
    id             INTEGER  PRIMARY KEY AUTOINCREMENT,
    title          TEXT     NOT NULL DEFAULT 'Untitled Adventure',
    description    TEXT,
    scenario_id    TEXT,
    model_id       TEXT,
    system_prompt  TEXT,                        -- global DM system prompt
    custom_prompt  TEXT,                        -- custom prompt extension (writing style, etc.)
    story_summary  TEXT,                        -- rolling narrative summary of pruned turns
    num_predict    INTEGER  NOT NULL DEFAULT 150,  -- per-game output token limit
    created_at     DATETIME DEFAULT (datetime('now')),
    last_played_at DATETIME DEFAULT (datetime('now'))
);

-- ── Scenarios (display metadata + prompts, 1:1 with games) ───────────────────
CREATE TABLE IF NOT EXISTS scenarios (
    game_id         INTEGER  PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    name            TEXT     NOT NULL DEFAULT '',
    icon            TEXT     NOT NULL DEFAULT '📖',
    description     TEXT     NOT NULL DEFAULT '',
    scenario_prompt TEXT,                       -- scenario-specific DM instructions
    opening_text    TEXT                        -- opening text shown at game start
);

-- ── Turns (full debug data per generation) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS turns (
    id                INTEGER  PRIMARY KEY AUTOINCREMENT,
    game_id           INTEGER  NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    turn_index        INTEGER  NOT NULL,
    action_type       TEXT,                     -- 'do' | 'say' | 'story'
    raw_input         TEXT,                     -- exact player text
    model_id          TEXT     NOT NULL,
    full_prompt       TEXT     NOT NULL,        -- messages JSON sent to Ollama
    ollama_request    TEXT     NOT NULL,        -- full request JSON body
    temperature       REAL,
    num_predict       INTEGER,
    repeat_penalty    REAL,
    response          TEXT,                     -- generated text
    ollama_response   TEXT,                     -- full final Ollama response JSON
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    created_at        DATETIME DEFAULT (datetime('now')),
    started_at        DATETIME,
    finished_at       DATETIME,
    duration_ms       INTEGER,
    error             TEXT
);

-- ── Characters (one per game) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS characters (
    id          INTEGER  PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER  NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name        TEXT     NOT NULL DEFAULT 'Hero',
    description TEXT,
    class       TEXT,
    stats       TEXT,                           -- JSON: {"str":10,"dex":14,...}
    notes       TEXT,
    created_at  DATETIME DEFAULT (datetime('now')),
    updated_at  DATETIME DEFAULT (datetime('now'))
);

-- ── World Cards (lore injected into system prompt) ────────────────────────────
CREATE TABLE IF NOT EXISTS world_cards (
    id          INTEGER  PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER  NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    type        TEXT     NOT NULL DEFAULT 'location', -- 'location'|'npc'|'item'|'faction'|'lore'
    name        TEXT     NOT NULL,
    description TEXT,
    active      INTEGER  NOT NULL DEFAULT 1,    -- 0 = disabled
    sort_order  INTEGER  NOT NULL DEFAULT 0,
    triggers    TEXT,                           -- comma-separated keywords; empty = always injected
    created_at  DATETIME DEFAULT (datetime('now')),
    updated_at  DATETIME DEFAULT (datetime('now'))
);

-- ── Bookmarks (save points inside a game) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookmarks (
    id          INTEGER  PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER  NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    turn_id     INTEGER  NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    label       TEXT,
    created_at  DATETIME DEFAULT (datetime('now'))
);

-- ── Model Stats (running aggregate per Ollama model) ─────────────────────────
CREATE TABLE IF NOT EXISTS model_stats (
    model_id          TEXT     PRIMARY KEY,
    total_turns       INTEGER  NOT NULL DEFAULT 0,
    total_prompt_tok  INTEGER  NOT NULL DEFAULT 0,
    total_compl_tok   INTEGER  NOT NULL DEFAULT 0,
    total_duration_ms INTEGER  NOT NULL DEFAULT 0,
    avg_tok_per_sec   REAL,
    last_used_at      DATETIME
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_turns_game      ON turns(game_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_games_played    ON games(last_played_at DESC);
CREATE INDEX IF NOT EXISTS idx_worldcards_game ON world_cards(game_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_bookmarks_game  ON bookmarks(game_id, turn_id);
