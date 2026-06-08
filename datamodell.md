# Database Model — StoryTelling

Current SQLite schema. **Update this document immediately after any schema change** (see CLAUDE.md).

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
        TEXT custom_prompt
        TEXT opening_text
        TEXT story_summary
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

    games ||--o{ turns : "has"
    games ||--o| characters : "has"
    games ||--o{ world_cards : "has"
    games ||--o{ bookmarks : "has"
    turns ||--o{ bookmarks : "references"
```

## Field notes

### games
| Field | Description |
|---|---|
| `system_prompt` | Global narrator prompt (writing style, general rules) — editable in the Plot tab |
| `scenario_prompt` | Scenario-specific narrator prompt (world setting, scenario rules) — editable in the Scenario tab |
| `opening_text` | Opening narrative shown as the first story segment |
| `story_summary` | Running summary of turns that have been trimmed from the context window |
| `num_predict` | Per-game output token limit (25–200, default: 150) — editable in the Model tab |

### turns
| Field | Description |
|---|---|
| `action_type` | `do` / `say` / `story` / `continue` |
| `full_prompt` | JSON array of messages sent to Ollama |
| `ollama_request` | Full Ollama request body |

### world_cards
| Field | Description |
|---|---|
| `type` | `location` / `npc` / `item` / `faction` / `lore` |
| `active` | 0 = inactive (not injected into context) |
| `triggers` | Comma-separated keywords; empty = always injected (pinned); set = only injected when a keyword appears in the current player action or the last 2 messages |
