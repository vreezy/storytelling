# StoryTelling — Local

Text adventure game powered by local AI via Ollama. No cloud, no CDN at runtime.

---

## Architecture

```
Browser → http://localhost:8000/         FastAPI (Podman) — serves UI + REST API
FastAPI  → http://localhost:11434        Ollama on the host (native, GPU accelerated)
FastAPI  → /data/dungeon.db             SQLite (Podman named volume, persists between restarts)
```

---

## Prerequisites

| Tool | Purpose |
|---|---|
| [Podman](https://podman.io/) (Desktop on Windows/macOS, `podman` + `podman-compose` on Linux) | Runs the FastAPI backend container |
| [Ollama](https://ollama.com/download) | Runs AI models (GPU accelerated) |

### `podman compose` vs. `podman-compose`

Both work — every command in this README is given in both forms. They are two different frontends for the same `compose.yml`:

- **`podman compose`** — the subcommand built into Podman. It delegates to an external provider (`podman-compose` or `docker-compose`), so it only works if one of them is installed.
- **`podman-compose`** — the standalone Python tool. On Fedora: `sudo dnf install podman-compose`.

If `podman compose` prints *"no compose provider found"*, use `podman-compose` directly.

---

## Linux / Fedora setup

Two things differ from Windows. Both are already handled in `compose.yml`, except the Ollama bind address, which you must set on the host.

### 1. SELinux — bind mounts need the `:z` label

On Fedora/RHEL, SELinux blocks a container from reading files on a bind mount unless they carry a container label. Symptom:

```
sh: 0: cannot open /app/backend/start.sh: Permission denied
```

`compose.yml` already appends `:z` to every bind mount (`- .:/app:z`), which makes Podman relabel the project directory on start. The flag is silently ignored on Windows, macOS, and non-SELinux Linux, so the same file works everywhere. **No action needed.**

### 2. Ollama must listen on `0.0.0.0`

By default Ollama only binds `127.0.0.1`, which containers cannot reach — the connection badge stays red and `/api/health` reports `"ollama": "error"`. Make Ollama listen on all interfaces:

```bash
sudo systemctl edit ollama.service
```

Add:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

Then:

```bash
sudo systemctl restart ollama
```

Verify it now listens on all interfaces (`*:11434` instead of `127.0.0.1:11434`):

```bash
ss -tlnp | grep 11434
```

If you start Ollama by hand instead of via systemd, run it as `OLLAMA_HOST=0.0.0.0 ollama serve`.

> Podman's own firewalld zone allows traffic from the container network to the host, so no extra firewall rule is needed on Fedora.

---

## First-time Setup

### 1. Download frontend libraries (Bootstrap, jQuery)

```bash
podman compose run --rm downloader --libs-only
# or
podman-compose run --rm downloader --libs-only
```

This downloads `libs/bootstrap.min.css`, `libs/bootstrap.bundle.min.js`, and `libs/jquery.min.js`.

Omitting `--libs-only` also fetches the ONNX models into `models/` (large download — only needed for in-browser inference).

> This step is optional: the backend runs the same libs download automatically on every start.

### 2. Start the backend

Make sure **Ollama is running** first (Windows: system tray icon; Linux: `systemctl status ollama`, and see *Linux / Fedora setup* above).

```bash
podman compose up backend
# or
podman-compose up backend
```

Add `-d` to run it in the background.

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

**🖼 Describe** (next to Continue) generates a detailed visual description of the current scene — characters (hair, eyes, clothing, pose; no names), setting, lighting — ready to paste into a text-to-image model. The prompt is configurable via `describePrompt` in `config.json`; the result is shown in a dialog with a copy button and is not added to the story.

### Continuing a saved game

Click **Load Game** at any time. Games are listed newest-first. Click a row to resume.

---

## Stopping

```bash
podman compose down
# or
podman-compose down
```

Ollama keeps running (system tray on Windows, `ollama.service` on Linux). Stop it separately if needed.

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

```bash
podman compose run --rm tester
# or
podman-compose run --rm tester
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

```bash
podman compose run --rm workflow
# or
podman-compose run --rm workflow
```

The workflow engine (`backend/workflow.py`) iterates **all games** and regenerates each story summary **from scratch**: it rebuilds the full message history from the turns, takes everything that has fallen out of the context window (`contextMaxMessages` in `config.json`), and folds it chunk by chunk (`summarizeAfterMessages` per chunk) into a fresh summary via Ollama. Re-running is always safe — the result simply replaces the previous summary.

The workflow also regenerates the **player intent analysis** for every game: all player inputs are analyzed with `playerIntentPrompt` (config.json) to work out what the player wants, and the resulting narrator instruction replaces `games.player_intent` (the live equivalent runs every `playerIntentAfterMessages` inputs via the "Player Intent Analysis" switch in the Model tab).

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
├── download.py           # Fetches frontend libs (+ ONNX models) — run via the downloader service
├── scenarios/
│   ├── index.json        # Load order — lists all scenario IDs
│   ├── schema.json       # JSON Schema for scenario files (validation / editor hints)
│   ├── fantasy.json
│   ├── scifi.json
│   ├── horror.json
│   ├── zootopia.json
│   ├── overlord.json
│   └── custom.json
├── compose.yml           # Podman Compose (downloader / backend / workflow / tester)
├── backend/
│   ├── main.py           # FastAPI application (all routes)
│   ├── migrations.py     # DB connection + idempotent schema migrations
│   ├── workflow.py       # Offline workflow engine (podman compose run --rm workflow)
│   ├── modules/
│   │   ├── summarize.py      # Summarization business logic (used by main.py + workflow.py)
│   │   └── player_intent.py  # Player intent analysis (used by main.py + workflow.py)
│   └── schema.sql        # SQLite schema
├── tests/
│   ├── test_playthrough.py   # Headless 30-turn playthrough + analysis
│   ├── configs/              # One JSON config per scenario run
│   └── reports/              # Generated Markdown reports (git-ignored)
└── libs/                 # Frontend libraries (populated by downloader)
```

---

## Troubleshooting

**`cannot open /app/backend/start.sh: Permission denied` (Linux)**
→ SELinux is blocking the bind mount. Every bind mount in `compose.yml` must end in `:z` (e.g. `- .:/app:z`). Check with `getenforce` — if it prints `Enforcing`, this is the cause.
→ Verify the mount works: `podman run --rm -v .:/app:z python:3.13-slim head -1 /app/backend/start.sh`

**Connection badge is red**
→ Make sure Ollama is running, then check the backend logs: `podman logs storytelling_backend_1`.
→ The backend prints the detected host on start: `OLLAMA_HOST: http://…:11434`.
→ Verify Ollama is reachable from the host: `curl http://localhost:11434/api/tags`
→ Check what the backend sees: `curl http://localhost:8000/api/health` → `{"ollama":"ok","db":"ok"}`

**Backend can't reach Ollama — Linux**
→ Almost always the bind address: Ollama defaults to `127.0.0.1`, which containers cannot reach. See *Linux / Fedora setup* above and set `OLLAMA_HOST=0.0.0.0` for the Ollama service.
→ Confirm from inside the container:

```bash
podman exec storytelling_backend_1 \
  python3 -c "import urllib.request;print(urllib.request.urlopen('http://host.containers.internal:11434/api/tags',timeout=5).status)"
```

`Connection refused` = Ollama is still bound to loopback. A timeout = firewall.

**Backend can't reach Ollama — Windows**
→ On Windows, Podman containers reach the host via `172.24.0.1` (the Podman VM's default gateway), not via `host.docker.internal` (which resolves to an unused bridge). Set it explicitly in a `.env` file next to `compose.yml`:

```
OLLAMA_HOST=http://172.24.0.1:11434
```

→ The Windows Firewall must allow inbound TCP 11434 from the Podman VM subnet (`172.24.0.0/20`). Run once **as Administrator**:

```powershell
New-NetFirewallRule -DisplayName "Ollama Podman" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 11434 -RemoteAddress "172.24.0.0/20"
```

→ After adding the rule, restart the backend: `podman compose restart backend`

**Model not showing in selector**
→ The model must be downloaded first. Open **Models** → click **Download**.

**Sending a turn fails with `Ollama HTTP 500: unable to load model …`**
→ The model was downloaded fine but Ollama cannot run it — usually its architecture is newer than the installed Ollama. The real reason is only in the Ollama log:

```bash
journalctl -u ollama -n 50    # Linux
```

Look for a line like `error loading model architecture: unknown model architecture: 'gemma4'`. Either pick a model your Ollama version supports, or update Ollama. Note that the Fedora package (`dnf install ollama`) lags well behind upstream releases.

**`ollama serve` says `bind: address already in use`**
→ Ollama already runs as a service — that message means it is up, not broken. Use `systemctl status ollama` and `journalctl -u ollama -f` instead of starting a second instance.

**`podman compose` not found / "no compose provider found"**
→ Fedora: `sudo dnf install podman-compose`, or just call `podman-compose …` directly.
→ Windows/macOS: `pip install podman-compose` or use Podman Desktop's built-in compose.

**`podman-compose down` prints `no container with name … tester_1 / workflow_1 / downloader_1`**
→ Harmless. `down` tries to remove one container per service, but those three are one-shot services always started with `run --rm`, so they have already removed themselves. As long as there is no error for `backend`, the shutdown worked. Check with `podman ps -a` — an empty list means everything is gone.

**`cannot open …/crun/…/exec.fifo: No such file or directory`**
→ The container is already running (e.g. from an earlier `up -d`); `up` tried to start it a second time. Check with `podman ps`, then `podman-compose down` and start again.

**`podman-compose run` warns "The input device is not a TTY"**
→ Harmless for `downloader` and `workflow`. For `tester` (which shows an interactive menu) run it from a real terminal, not from a script or CI job.

**Port 8000 already in use**
→ `podman compose down` then `podman compose up backend`.

**Slow generation**
→ Ollama uses your GPU automatically. If it's slow, check Task Manager → GPU.
→ Smaller models (SmolLM2 135M or 360M) generate much faster than 7B+.

## Optimizations

### `num_batch` — why it is 4096, not 512

`num_batch` controls how many prompt tokens llama.cpp processes per pass. On
some ROCm GPUs (seen on gfx1151 / Strix Halo) a prompt that spans **multiple
batches corrupts the model state** and the reply degrades into word salad —
deterministically, not randomly.

A full game prompt (system prompt + scenario + character + world cards + story
summary + history) is easily 1000+ tokens, so the old value of 512 split it
into several batches and triggered the bug on every turn. Short test prompts
stayed under one batch and looked fine, which made this painful to diagnose:

| Prompt | num_batch | Result |
|---|---|---|
| ~1000 tokens (real game turn) | 128 / 512 | word salad |
| ~1000 tokens (real game turn) | 2048 / 4096 | clean prose |
| ~90 tokens (minimal test) | 512 | clean prose |

Because of this, `numBatch` is set to **4096** in both generation blocks of
`config.json`, and the summarize / player-intent / describe requests use the
same explicit `num_ctx` / `num_batch` values. Keeping these identical across
all request types has a second benefit: Ollama reuses one runner per model
instead of restarting the llama-server whenever the options differ.

Rules of thumb:

- `num_batch` must be **larger than your longest prompt** (check
  `prompt_tokens` in the debug panel after a turn).
- If word salad ever returns, replay the stored `ollama_request` of the bad
  turn (in the `turns` table) directly against Ollama and vary only
  `num_batch` — that isolates the bug in one step.
- This is an upstream llama.cpp/ROCm issue; an Ollama update may remove the
  need for the workaround.

### One resident model at a time

Ollama's free-memory accounting overcommits on unified-memory GPUs, so a
second resident model silently corrupts generation instead of being evicted.
The backend therefore unloads every other model before each turn
(`unload_others()` in `backend/modules/ollama.py`). Side effect: a model kept
loaded by another tool (e.g. Open WebUI) is unloaded when a game turn runs.
