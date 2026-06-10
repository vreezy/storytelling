# StoryTelling — Local

Text adventure game powered by local AI via Ollama. No cloud, no CDN at runtime.

---

## Architecture

```
Browser → http://localhost:8000/         FastAPI (Podman) — serves UI + REST API
FastAPI  → http://localhost:11434        Ollama for Windows (native, GPU accelerated)
FastAPI  → /data/dungeon.db             SQLite (Podman named volume, persists between restarts)
```

---

## Prerequisites

| Tool | Purpose |
|---|---|
| [Podman Desktop](https://podman.io/) | Runs the FastAPI backend container |
| [Ollama for Windows](https://ollama.com/download) | Runs AI models (GPU accelerated) |

---

## First-time Setup

### 1. Download frontend libraries (Bootstrap, jQuery)

```powershell
podman compose run --rm downloader
```

This downloads `libs/bootstrap.min.css`, `libs/bootstrap.bundle.min.js`, and `libs/jquery.min.js`.

### 2. Start the backend

Make sure **Ollama for Windows is running** first (system tray icon or `ollama serve` in a terminal).

```powershell
podman compose up backend
```

### 3. Open in browser

→ `http://localhost:8000/`

The connection badge in the top-right should turn green.

---

## Downloading Models

1. Click **Models** (top of the page)
2. Choose a model from the list and click **Download**
3. Wait for the progress bar to complete — the model is saved to Ollama's model store
4. The model now appears in the **New Game** model selector

| Model | Size | NSFW |
|---|---|---|
| SmolLM2 135M Instruct | ~90 MB | No |
| SmolLM2 360M Instruct | ~230 MB | No |
| SmolLM2 1.7B Instruct | ~1 GB | No |
| Mistral 7B Instruct | ~4.1 GB | No |
| Chronomaid Storytelling 13B | ~7.9 GB | Yes (18+) |
| Dolphin Mistral 7B | ~4.1 GB | Yes (18+) |

---

## Playing

1. Open `http://localhost:8000/`
2. Enter a **Game Title** and select an installed **Model**
3. Choose a **Scenario** (or write your own with Custom World)
4. Optionally fill in a **Character** name and description
5. Click **Begin Story**
6. Type your action and press **Enter** or click **Send**
   - **Do** — your character acts (default)
   - **Say** — your character speaks
   - **Story** — narrator-style steering

### Continuing a saved game

Click **Load Game** at any time. Games are listed newest-first. Click a row to resume.

---

## Stopping

```powershell
podman compose down
```

Ollama keeps running in the system tray. Close it separately if needed.

---

## Debug Panel

During a game, expand the **🔧 Debug — Last Turn** panel at the bottom to see:
- Prompt tokens / completion tokens / total tokens
- Duration (ms) and tokens per second
- Full messages JSON sent to Ollama
- Full Ollama request JSON

The **🔧 Prompt Debug Editor** button (top-right of the game screen) lets you edit the system prompt, scenario prompt, and action prompts live — changes apply to the next turn.

---

## Prompt Analysis (Automated Playthrough)

The `tester` service plays 30 scripted turns automatically and writes a Markdown analysis report to `tests/reports/`. Use it to evaluate prompt quality and spot issues like short responses, repetition, or context overflow.

**Start the backend first, then run:**

```powershell
podman compose run --rm tester
```

The report appears in `tests/reports/analysis_YYYYMMDD_HHMMSS.md` on the host.

### What the report covers

| Section | What it measures |
|---------|-----------------|
| Response Length | avg/min/max tokens per turn; flags short (<30) or truncated responses |
| Generation Speed | tok/s per turn with a spark-line chart |
| Prompt Token Growth | how the prompt grows over 30 turns; overflow estimate |
| Repetition Detection | trigram overlap between consecutive responses |
| Action Responsiveness | avg response length broken down by `do` / `say` / `story` |
| Format Compliance | mid-sentence starts, trailing `...`, OOC brackets, refusals |
| Recommendations | plain-English suggestions for prompt changes |

### Customising the run

Each scenario has its own config file in `tests/configs/`. Select one at startup when the menu is shown.

To add a run for a new scenario, copy an existing config and edit the `scenario_id` and `actions`:

```json
{
  "scenario_id": "horror",
  "model_id": "mistral:7b-instruct",
  "game_title": "Playthrough Test — Horror",
  "actions": [ { "type": "do", "text": "approach the front door" }, ... ]
}
```

---

## Summarize Workflow (offline)

The game can condense old story messages into a rolling "Story so far" summary live during play (switch in the **Model** tab of the game sidebar). On low-power systems this extra generation per turn is unwelcome — turn the switch **off**, play your session, then run the offline workflow and leave the computer:

```powershell
podman compose run --rm workflow
```

The workflow engine (`backend/workflow.py`) iterates **all games** and regenerates each story summary **from scratch**: it rebuilds the full message history from the turns, takes everything that has fallen out of the context window (`contextMaxMessages` in `config.json`), and folds it chunk by chunk (`summarizeAfterMessages` per chunk) into a fresh summary via Ollama. Re-running is always safe — the result simply replaces the previous summary.

**Ollama must be running.** The backend container is not needed. Games whose story still fits the context window are skipped.

The engine is built for more batch jobs later: business logic lives in `backend/modules/<name>.py`, and each job is registered in the `MODULES` list in `workflow.py`.

---

## Scenarios

Scenarios live in `scenarios/`. Each file is a self-contained JSON document. The load order is controlled by `scenarios/index.json`.

### Adding a new scenario

**1.** Create `scenarios/<your-id>.json`:

```json
{
  "id": "your-id",
  "name": "Display Name",
  "icon": "🌍",
  "description": "One-line pitch shown on the setup screen.",
  "scenarioPrompt": "Narrator instructions specific to this world.",
  "openingText": "The first paragraph the player sees.",
  "mainCharacters": [
    {
      "name": "Hero Name",
      "class": "Role / Class",
      "description": "Character background pre-filled on the setup screen."
    }
  ],
  "cards": [
    {
      "type": "location",
      "name": "Starting Location",
      "description": "Always injected (no triggers = pinned)."
    },
    {
      "type": "npc",
      "name": "Key NPC",
      "description": "Only injected when a trigger keyword matches.",
      "triggers": "keyword1, keyword2"
    }
  ]
}
```

**`type`** must be one of: `location` · `npc` · `item` · `faction` · `lore`

**`triggers`** — comma-separated keywords checked against the player's current action and the last 2 messages. Leave blank (or omit) to always inject the card.

**2.** Register it in `scenarios/index.json`:

```json
{ "scenarios": ["fantasy", "scifi", "horror", "zootopia", "overlord", "your-id", "custom"] }
```

The order here is the display order on the setup screen. `custom` should stay last.

**3.** Reload the page — the scenario appears in the grid immediately.

### Schema

`scenarios/schema.json` contains a JSON Schema (Draft-07) that documents all fields and their types. Any JSON-aware editor (VS Code with the JSON Language Server) will validate your file against it automatically if you add:

```json
{ "$schema": "./schema.json", "id": "your-id", ... }
```

---

## Stats

Click **Stats** on the setup screen to see aggregate performance per model:
total turns, total tokens, average tokens per second, last used.

---

## Project Structure

```
aidungeon/
├── index.html            # Setup screen
├── game.html             # Game screen
├── setup.js              # Setup screen logic
├── game.js               # Game screen logic
├── api.js                # All backend fetch calls
├── utils.js              # Shared helpers (loadConfig, showToast, …)
├── style.css             # Shared styles
├── config.json           # Global settings, model list, generation parameters
├── scenarios/
│   ├── index.json        # Load order — lists all scenario IDs
│   ├── schema.json       # JSON Schema for scenario files (validation / editor hints)
│   ├── fantasy.json
│   ├── scifi.json
│   ├── horror.json
│   ├── zootopia.json
│   ├── overlord.json
│   └── custom.json
├── compose.yml           # Podman Compose
├── backend/
│   ├── main.py           # FastAPI application (all routes)
│   ├── migrations.py     # DB connection + idempotent schema migrations
│   ├── workflow.py       # Offline workflow engine (podman compose run --rm workflow)
│   ├── modules/
│   │   └── summarize.py  # Summarization business logic (used by main.py + workflow.py)
│   └── schema.sql        # SQLite schema
├── tests/
│   ├── test_playthrough.py   # Headless 30-turn playthrough + analysis
│   ├── configs/              # One JSON config per scenario run
│   └── reports/              # Generated Markdown reports (git-ignored)
└── libs/                 # Frontend libraries (populated by downloader)
```

---

## Troubleshooting

**Connection badge is red**
→ Make sure Ollama for Windows is running. Then check `podman compose up backend`.
→ Verify Ollama is reachable: `curl http://localhost:11434/api/tags`

**Backend can't reach Ollama**
→ On Windows, Podman containers reach the host via `172.24.0.1` (the Podman VM's default gateway), not via `host.docker.internal` (which resolves to an unused bridge).
→ `compose.yml` sets `OLLAMA_HOST=http://172.24.0.1:11434` explicitly to work around this.
→ The Windows Firewall must allow inbound TCP 11434 from the Podman VM subnet (`172.24.0.0/20`). Run once **as Administrator**:

```powershell
netsh advfirewall firewall add rule name="Ollama Podman" dir=in action=allow protocol=TCP localport=11434 remoteip=172.24.0.0/255.255.240.0
```

→ After adding the rule, restart the backend: `podman compose restart backend`

**Model not showing in selector**
→ The model must be downloaded first. Open **Models** → click **Download**.

**`podman compose` not found**
→ Install via `pip install podman-compose` or use Podman Desktop's built-in compose.

**Port 8000 already in use**
→ `podman compose down` then `podman compose up backend`.

**Slow generation**
→ Ollama uses your GPU automatically. If it's slow, check Task Manager → GPU.
→ Smaller models (SmolLM2 135M or 360M) generate much faster than 7B+.
