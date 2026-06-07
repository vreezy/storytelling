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

## Stats

Click **Stats** on the setup screen to see aggregate performance per model:
total turns, total tokens, average tokens per second, last used.

---

## Project Structure

```
aidungeon/
├── index.html            # Main UI (setup screen + game screen + modals)
├── dungeon.js            # Frontend logic
├── dungeon-style.css     # Styles
├── dungeon-config.json   # Scenarios, model list, generation parameters
├── compose.yml           # Podman Compose
├── download.py           # Downloads frontend libs (Bootstrap, jQuery)
├── .env                  # HF_TOKEN (optional, for private HuggingFace repos)
├── backend/
│   ├── main.py           # FastAPI application
│   └── schema.sql        # SQLite schema
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
