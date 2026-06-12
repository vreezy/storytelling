# CLAUDE.md — Project Guidelines

## Code execution

- **No local code execution — of any kind.** Nothing is ever executed directly on the host: no `python`/`py`/`pip`, no `node`/`npm`, no other interpreters or build tools.
- Everything runs **only via podman** (e.g. `podman compose run --rm tester`).

---

## Language

All code, comments, documentation, and configuration files in this project must be written in **English**. No German.

---

## No CDN — everything local

- `libs/bootstrap.min.css`, `libs/bootstrap.bundle.min.js`, and `libs/jquery.min.js` must be present locally.
- No external script or stylesheet URLs (`https://cdn.*`) are allowed in HTML files.

---

## Web server

- VS Code **Live Server** extension is used as the local HTTP server (no dedicated server container).
- `index.html` → right-click → "Open with Live Server" → `http://127.0.0.1:5500`

---

## Pages

- `index.html` — setup screen (model selection, scenario, character)
- `game.html` — game screen (story, action input, sidebar with tabs)
- `api.js` — all backend fetch calls as ES module exports
- `utils.js` — shared helpers (showToast, pollHealth, renderTemplate, …)
- `setup.js` — logic for index.html
- `game.js` — logic for game.html
- `style.css` — shared CSS
- Generation parameters and prompts in `config.json`; scenarios in `scenarios/`

---

## Scenario format — Character Card V2

- Scenario files in `scenarios/` are **Character Card V2** documents (`chara_card_v2`, [spec](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)). **V2 only — never V3.** JSON Schema: `scenarios/schema.json`.
- The scenario **id is the filename** — the card does not contain an id field. `scenarios/index.json` controls the load order.
- App-specific data lives in `data.extensions.storytelling`: `icon` (setup-screen emoji) and `mainCharacters` (suggested player characters). Imported community cards lack this — handle its absence gracefully.
- Field usage: `creator_notes` = UI pitch (never in the prompt). `system_prompt` = scenario system prompt (world rules), appended **after** the global system prompt. `description` = main card content, injected into every prompt right after the system prompts (also editable in the Scenario tab). `first_mes` = opening message (highlighted + swappable against `alternate_greetings` while the game has no turns). `character_book.entries` = world cards (`keys` array → `world_cards.triggers` comma string). `post_history_instructions` = system message injected **after** the chat history, always the last prompt part.
- **Macros** `{{char}}` (card name) and `{{user}}` (player character name) are replaced at prompt-build time; `{{original}}` is replaced with an empty string (the global prompt is always included). Implementations: `applyMacros` in `utils.js` and `apply_macros` in `tests/test_playthrough.py` — keep both in sync, same for `buildMessages` (game.js) and `MessageBuilder.build_messages` (test).
- The global narrator prompt is a **single** `systemPrompt` (config.json) / `games.system_prompt` (DB) — the former `customSystemPrompt`/`custom_prompt` no longer exist.

---

## Key settings in game.js

```js
// Paths must be absolute from root — NOT relative (./…)
// Relative paths cause double-path bugs because the browser resolves
// them relative to the current page, not the project root.
```

---

## Tests

- Headless playthroughs live in `tests/` — configs under `tests/configs/*.json`, script `tests/test_playthrough.py`.
- **Whenever the DB schema or API endpoints change**, check whether `test_playthrough.py` is affected:
  - New or renamed fields in the `turns` table → update `TurnRecord` and `Analyzer`.
  - Changed request/response structure for `/api/games`, `/api/games/{id}/turns`, or `/api/games/{id}/summarize` → update `GameClient` and `PlaythroughRunner`.
  - New endpoints affecting game setup → integrate into `PlaythroughRunner.run()` as needed.
- Run: `podman compose run --rm tester`

---

## Database schema documentation

- The current SQLite schema is documented in [`datamodell.md`](datamodell.md) as a Mermaid ERD.
- **Update `datamodell.md` immediately after any schema change** (new columns, new tables, changed types, new migrations).

## Backend flow documentation

- **After any backend change** (new endpoint, new module, changed startup flow, refactor) update [`flowDiagram.md`](flowDiagram.md) to keep it in sync with the actual code.

## Workflow engine & modules — `backend/workflow.py` + `backend/modules/`

- **Business logic lives in `backend/modules/<name>.py`** (e.g. `modules/summarize.py`). FastAPI **routes stay in `main.py`** and call the module functions — no routers in module files.
- `backend/workflow.py` is the **offline batch runner** for low-power systems: the user turns off live generation in the game, plays, then runs the workflow and leaves the computer. Run: `podman compose run --rm workflow` (needs Ollama, not the backend container).
- The summarize workflow regenerates `games.story_summary` **from scratch** for every game (idempotent); chunk size comes from `summarizeAfterMessages` in `config.json`.
- **Adding a new offline-capable feature:** put its logic in `backend/modules/<name>.py`, write an `async def run_<name>(game, turns, config)` runner in `workflow.py`, and register it in the `MODULES` list there.

---

## Migrations — `backend/migrations.py`

All schema changes live in `backend/migrations.py`. `main.py` imports `get_db` and `init_db` from there; migrations run automatically on every app startup.

**When to add a migration:**

- Adding a column → `ALTER TABLE … ADD COLUMN`
- Adding a table → `CREATE TABLE IF NOT EXISTS`
- Renaming or restructuring a table → `CREATE TABLE … / INSERT … / DROP / RENAME`

**How to add a migration:**

1. Write a new `_migrate_<description>(conn)` function in `migrations.py`. It **must be idempotent** — check `PRAGMA table_info` or `IF NOT EXISTS` before applying the change.
2. Call it at the bottom of `run_migrations()` (inside `init_db`).
3. Update `datamodell.md` to reflect the new schema.

Example:

```python
def _migrate_add_foo_to_games(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(games)").fetchall()}
    if "foo" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN foo TEXT")
        conn.commit()
```

---

## Model categories

- **chatml template** (SmolLM2-*-Instruct): ChatML format `<|im_start|>role\n...<|im_end|>`
- **tinyllama template** (TinyLlama-Chat): `<|role|>\n...</s>`
- **completion** (GPT-2, distilgpt2, BLOOM, etc.): no chat format — plain text completion only

---

## GPU / CPU

- WebGPU availability is checked once on page load (`navigator.gpu`).
- The toggle stays `disabled` if no WebGPU is detected — no manual override needed.
- GPU dtype: `q4f16` (chatml/tinyllama), `q8` (completion)
- CPU dtype: `q4` (chatml/tinyllama), `q8` (completion)
