# Datenbankmodell — StoryTelling

Dieses Dokument beschreibt das aktuelle SQLite-Schema. **Bei jeder Schemaänderung muss dieses Dokument sofort aktualisiert werden** (siehe CLAUDE.md).

```mermaid
erDiagram
    games {
        INTEGER id PK
        TEXT title
        TEXT description
        TEXT scenario_id
        TEXT model_id
        TEXT system_prompt
        TEXT scenario_prompt
        TEXT opening_text
        INTEGER num_predict
        DATETIME created_at
        DATETIME last_played_at
    }

    turns {
        INTEGER id PK
        INTEGER game_id FK
        INTEGER turn_index
        TEXT action_type
        TEXT raw_input
        TEXT model_id
        TEXT full_prompt
        TEXT ollama_request
        REAL temperature
        INTEGER num_predict
        REAL repeat_penalty
        TEXT response
        TEXT ollama_response
        INTEGER prompt_tokens
        INTEGER completion_tokens
        INTEGER total_tokens
        DATETIME created_at
        DATETIME started_at
        DATETIME finished_at
        INTEGER duration_ms
        TEXT error
    }

    characters {
        INTEGER id PK
        INTEGER game_id FK
        TEXT name
        TEXT description
        TEXT class
        TEXT stats
        TEXT notes
        DATETIME created_at
        DATETIME updated_at
    }

    world_cards {
        INTEGER id PK
        INTEGER game_id FK
        TEXT type
        TEXT name
        TEXT description
        INTEGER active
        INTEGER sort_order
        TEXT triggers
        DATETIME created_at
        DATETIME updated_at
    }

    bookmarks {
        INTEGER id PK
        INTEGER game_id FK
        INTEGER turn_id FK
        TEXT label
        DATETIME created_at
    }

    model_stats {
        TEXT model_id PK
        INTEGER total_turns
        INTEGER total_prompt_tok
        INTEGER total_compl_tok
        INTEGER total_duration_ms
        REAL avg_tok_per_sec
        DATETIME last_used_at
    }

    games ||--o{ turns : "hat"
    games ||--o| characters : "hat"
    games ||--o{ world_cards : "hat"
    games ||--o{ bookmarks : "hat"
    turns ||--o{ bookmarks : "referenziert"
```

## Felder (Erläuterungen)

### games
| Feld | Beschreibung |
|---|---|
| `system_prompt` | Globaler DM-Prompt (Schreibstil, allg. Regeln), editierbar im Plot-Tab |
| `scenario_prompt` | Szenario-spezifischer DM-Prompt (Weltbeschreibung, Szenario-Regeln), editierbar im Scenario-Tab |
| `opening_text` | Eröffnungstext der Story (wird als erstes Narrativ angezeigt) |
| `num_predict` | Per-Game Output-Token-Limit (25–200, Standard: 150), editierbar im Model-Tab |

### turns
| Feld | Beschreibung |
|---|---|
| `action_type` | `do` / `say` / `story` / `continue` |
| `full_prompt` | JSON der an Ollama gesendeten messages |
| `ollama_request` | Vollständiger Ollama-Request-Body |

### world_cards
| Feld | Beschreibung |
|---|---|
| `type` | `location` / `npc` / `item` / `faction` / `lore` |
| `active` | 0 = inaktiv (nicht in Kontext injiziert) |
| `triggers` | Kommagetrennte Schlüsselwörter; leer = immer injiziert (pinned); gesetzt = nur injiziert wenn ein Keyword im aktuellen Spielerzug oder den letzten 2 Nachrichten vorkommt |
