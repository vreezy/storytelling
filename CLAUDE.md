# CLAUDE.md — Project Guidelines

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
- Scenarios and generation parameters in `config.json`

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
- **Update `datamodell.md` immediately after any schema change** (new columns, new tables, changed types, new migrations in `main.py`).
- Migrations are applied in `backend/main.py` → `init_db()` via `PRAGMA table_info` checks and `ALTER TABLE` statements.

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
