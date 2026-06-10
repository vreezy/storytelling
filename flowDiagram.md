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
        MB[FastAPI routes\n22 endpoints]
    end

    subgraph MODS["modules/"]
        S1[summarize.py\ngenerate_summary + save_summary]
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
    WF -->|iterates all games\nruns registered modules| S1
    WF -->|get_db| M1
    S1 -->|POST /api/chat non-stream| EXT2
    S1 -->|UPDATE story_summary| EXT1

    click MIGS "flowDiagram_migrations.md" "Open migrations.py diagram"
    click MAIN "flowDiagram_main.md" "Open main.py diagram"
```

**Diagrams:**

- [migrations.py detail](flowDiagram_migrations.md)
- [main.py detail](flowDiagram_main.md)

**Modules:**

- `modules/summarize.py` — summarization business logic (no FastAPI code): `generate_summary` condenses story messages through Ollama, `save_summary` writes `games.story_summary`. Called by the `POST /api/games/{id}/summarize` route in `main.py` (live mode, only when the per-game `summarize_enabled` switch is on) and by `workflow.py` (offline mode).
- `workflow.py` — offline workflow engine for low-power systems (`podman compose run --rm workflow`): iterates all games and runs every job registered in its `MODULES` list. The summarize job regenerates each game's summary from scratch in chunks of `summarizeAfterMessages` (config.json); games still fitting the context window are skipped. Future batch jobs: add `modules/<name>.py` + a runner registered in `MODULES`.
