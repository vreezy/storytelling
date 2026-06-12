-- ── Games ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
    id             INTEGER  PRIMARY KEY AUTOINCREMENT,
    title          TEXT     NOT NULL DEFAULT 'Untitled Adventure',
    description    TEXT,
    scenario_id    TEXT,
    model_id       TEXT,
    system_prompt  TEXT,                        -- global narrator system prompt (merged, single field)
    story_summary  TEXT,                        -- rolling narrative summary of pruned turns
    summarize_enabled INTEGER NOT NULL DEFAULT 1,  -- 1 = auto-summarize pruned turns, 0 = off
    player_intent  TEXT,                        -- generated narrator instruction from player-input analysis
    player_intent_enabled INTEGER NOT NULL DEFAULT 1,  -- 1 = auto-analyze player intent, 0 = off
    num_predict    INTEGER  NOT NULL DEFAULT 150,  -- per-game output token limit
    created_at     DATETIME DEFAULT (datetime('now')),
    last_played_at DATETIME DEFAULT (datetime('now'))
);

-- ── Scenarios (Character Card V2 data, 1:1 with games) ───────────────────────
-- Columns mirror the chara_card_v2 spec:
-- https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
CREATE TABLE IF NOT EXISTS scenarios (
    game_id                   INTEGER  PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    name                      TEXT     NOT NULL DEFAULT '',   -- card name ({{char}} macro value)
    icon                      TEXT     NOT NULL DEFAULT '📖', -- app extension (extensions.storytelling.icon)
    creator_notes             TEXT     NOT NULL DEFAULT '',   -- UI-only pitch, never in the prompt
    description               TEXT,                           -- main card content, injected into every prompt
    personality               TEXT,                           -- short personality summary (optional)
    scenario                  TEXT,                           -- circumstances of the story (optional)
    first_mes                 TEXT,                           -- opening text, first assistant message
    mes_example               TEXT,                           -- example dialogue (optional)
    system_prompt             TEXT,                           -- scenario system prompt, appended after the global one
    post_history_instructions TEXT,                           -- injected after chat history
    alternate_greetings       TEXT NOT NULL DEFAULT '[]',     -- JSON array of alternative first_mes
    tags                      TEXT NOT NULL DEFAULT '[]',     -- JSON array of strings
    creator                   TEXT NOT NULL DEFAULT '',
    character_version         TEXT NOT NULL DEFAULT ''
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
