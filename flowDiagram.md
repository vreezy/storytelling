# Backend — Architecture Overview

> Click a module node to open its detailed diagram.

```mermaid
flowchart TD
    START([App Start])

    subgraph MIGS["migrations.py"]
        M1[get_db]
        M2[init_db\n+ all migrations]
    end

    subgraph MAIN["main.py"]
        MA[lifespan]
        MB[FastAPI routes\n24 endpoints]
    end

    subgraph MODS["modules/"]
        S1[summarize.py\ngenerate_summary + save_summary]
        S2[player_intent.py\nfetch_user_inputs +\ngenerate_player_intent + save_player_intent]
        S3[describe.py\ngenerate_description]
    end

    WF[workflow.py\noffline batch runner\npodman compose run --rm workflow]

    EXT1[(SQLite\nstory.db)]
    EXT2([Ollama\nLLM server])
    EXT3[Static files\nSTATIC_DIR]

    START --> MA
    MA -->|calls on startup| M2
    M2 -->|schema + ALTER migrations| EXT1
    M1 -->|open connection| EXT1
    MB -->|get_db| M1
    MB -->|HTTP streaming| EXT2
    MB -->|serve| EXT3
    MB -->|summarize route calls| S1
    MB -->|player-intent route calls| S2
    MB -->|describe route calls| S3
    S3 -->|POST /api/chat non-stream| EXT2
    WF -->|iterates all games\nruns registered modules| S1
    WF -->|iterates all games\nruns registered modules| S2
    WF -->|get_db| M1
    S1 -->|POST /api/chat non-stream| EXT2
    S1 -->|UPDATE story_summary| EXT1
    S2 -->|POST /api/chat non-stream| EXT2
    S2 -->|SELECT raw_input\nUPDATE player_intent| EXT1

    click MIGS "flowDiagram_migrations.md" "Open migrations.py diagram"
    click MAIN "flowDiagram_main.md" "Open main.py diagram"
```

**Diagrams:**

- [migrations.py detail](flowDiagram_migrations.md)
- [main.py detail](flowDiagram_main.md)

**Modules:**

- `modules/summarize.py` — summarization business logic (no FastAPI code): `generate_summary` condenses story messages through Ollama, `save_summary` writes `games.story_summary`. Called by the `POST /api/games/{id}/summarize` route in `main.py` (live mode, only when the per-game `summarize_enabled` switch is on) and by `workflow.py` (offline mode).
- `modules/player_intent.py` — player intent analysis business logic (no FastAPI code): `fetch_user_inputs` reads all `raw_input` values of a game from the `turns` table, `generate_player_intent` asks Ollama what the player wants (prompt: `playerIntentPrompt` in config.json), `save_player_intent` writes `games.player_intent`. Called by the `POST /api/games/{id}/player-intent` route in `main.py` (triggered by the frontend every `playerIntentAfterMessages` player inputs when the per-game `player_intent_enabled` switch is on) and by `workflow.py` (offline mode).
- `modules/describe.py` — scene description business logic (no FastAPI code): `generate_description` asks Ollama for a detailed visual snapshot of the current scene (characters without names, clothing, poses, setting, lighting) for text-to-image models; prompt: `describePrompt` in config.json. Called by the `POST /api/games/{id}/describe` route in `main.py` (Describe button next to Continue). The result is ephemeral — nothing is stored.
- `workflow.py` — offline workflow engine for low-power systems (`podman compose run --rm workflow`): iterates all games and runs every job registered in its `MODULES` list. The summarize job regenerates each game's summary from scratch in chunks of `summarizeAfterMessages` (config.json); games still fitting the context window are skipped. Future batch jobs: add `modules/<name>.py` + a runner registered in `MODULES`.
