# Cloud LLM support: OpenAI-compatible provider alongside local Ollama

## Context

The user has one low-power Ollama instance (~80 s/turn). Cloud inference providers (OpenRouter, DeepInfra, Groq, …) serve open-source models like Llama 3.1 8B for fractions of a cent per playthrough via the OpenAI-compatible chat-completions API. The backend currently talks to Ollama's native API (`/api/chat`, `options.num_predict`, …) in four places. Goal: a single LLM client module that can target either local Ollama (native API, unchanged behavior) or any OpenAI-compatible cloud endpoint, switched by environment variables — no frontend changes, no DB schema changes.

Provider choice: OpenRouter for testing (free `:free` Llama 3.1 8B tier available; paid is ~$0.0006 per 15-turn playthrough). Uncensored models not needed for testing.

### Pricing reference (15-turn playthrough ≈ 25K input + 4K output tokens)

| Provider | 1B | 3–4B | 8B (Llama 3.1) | 12–13B | Uncensored models? |
|---|---|---|---|---|---|
| OpenRouter | ~$0.0002 | ~$0.0003 | ~$0.0006 (or free tier) | ~$0.0006 (Mistral Nemo 12B) | Yes — Dolphin, abliterated, RP fine-tunes |
| DeepInfra | ~$0.0002 | ~$0.0004 | ~$0.0009 ($0.029/$0.05 per M) | ~$0.001 | Partly — smaller catalog |
| Groq | ~$0.0009 | ~$0.001 | ~$0.0016 ($0.05/$0.08 per M) | — | No — official models only |
| Together AI | — | ~$0.002 | ~$0.005 ($0.18 per M) | ~$0.008 | Mostly no |
| Featherless | flat $10/month, unlimited tokens, any HF model up to 15B (incl. Chronomaid 13B) | ← | ← | ← | Yes — RP community focus |

## Current Ollama touchpoints

| File | What it does |
|---|---|
| `backend/main.py:26` | `OLLAMA_HOST` env var |
| `backend/main.py:64-81` | health check via `GET /api/tags` |
| `backend/main.py:86-126` | model list / pull / delete (Ollama-native, meaningless in cloud) |
| `backend/main.py:444-470` | turn streaming via `POST /api/chat` (NDJSON chunks, `prompt_eval_count`/`eval_count` usage) |
| `backend/modules/describe.py`, `summarize.py`, `player_intent.py` | non-streaming `POST /api/chat`, each with own `OLLAMA_HOST` copy |

`tests/test_playthrough.py` and the frontend only consume the backend's own NDJSON event format (`{"type": "token"|"done"|"error"}`) — they are unaffected.

## Design

### New module: `backend/llm.py`

Central client, two transports selected by env:

- `LLM_PROVIDER` = `ollama` (default) | `openai`
- `OLLAMA_HOST` — unchanged, used by the ollama transport
- `LLM_BASE_URL` — e.g. `https://openrouter.ai/api/v1`, used by the openai transport
- `LLM_API_KEY` — sent as `Authorization: Bearer …` in openai mode

API (both transports):

```python
async def chat(model_id, messages, options) -> dict
    # returns {"text": str, "prompt_tokens": int, "completion_tokens": int, "raw": dict}

async def chat_stream(model_id, messages, options)
    # async generator: yields {"token": str} per chunk,
    # then one final {"done": True, "prompt_tokens": ..., "completion_tokens": ..., "raw": last_chunk}

async def health() -> bool      # /api/tags (ollama) or GET /models (openai)
```

`options` stays the Ollama-style dict the callers already build (`num_predict`, `temperature`, `repeat_penalty`, `num_ctx`, `num_gpu`, `num_batch`, `keep_alive`).

- **ollama transport**: passes options through unchanged to `POST {OLLAMA_HOST}/api/chat` — zero behavior change locally.
- **openai transport**: `POST {LLM_BASE_URL}/chat/completions` with `max_tokens` ← `num_predict`, `temperature`, `repetition_penalty` ← `repeat_penalty` (OpenRouter/DeepInfra accept it; others ignore), drops `num_ctx`/`num_gpu`/`num_batch` (local-only concepts). Streaming uses SSE (`data: {...}` lines, `choices[0].delta.content`) with `stream_options: {"include_usage": true}` for token counts; tolerate missing usage (fall back to 0).

### Callers

- `backend/main.py` turn endpoint: replace the httpx streaming block (`main.py:452-470`) with `async for event in llm.chat_stream(...)`. The DB insert, model_stats update, and NDJSON output stay identical (store the provider request/response JSON in the existing `ollama_request`/`ollama_response` columns — no schema change).
- `modules/describe.py`, `modules/summarize.py`, `modules/player_intent.py`: replace each module's own `OLLAMA_HOST` + httpx POST with `llm.chat(...)`. Keep each module's option values exactly as they are today.
- `main.py` health endpoint: use `llm.health()`.
- `main.py` model endpoints: in openai mode, `GET /api/models` proxies `GET {LLM_BASE_URL}/models` mapped to the Ollama tags shape (`{"models": [{"name": id}]}`); `pull`/`delete` return HTTP 400 "not supported with cloud provider".
- `workflow.py` needs no change (it only calls module functions, which now go through llm.py).

### compose.yml

Add to `backend` and `workflow` services (interpolated from host env / `.env`):

```yaml
- LLM_PROVIDER=${LLM_PROVIDER:-ollama}
- LLM_BASE_URL=${LLM_BASE_URL:-}
- LLM_API_KEY=${LLM_API_KEY:-}
```

Create `.env.example` with an OpenRouter sample (`LLM_PROVIDER=openai`, `LLM_BASE_URL=https://openrouter.ai/api/v1`, `LLM_API_KEY=sk-or-...`). Add `.env` to `.gitignore` so the key is never committed.

### config.json

Add one cloud model entry to `availableModels` for testing, e.g.:

```json
{ "id": "meta-llama/llama-3.1-8b-instruct", "name": "Llama 3.1 8B (OpenRouter)", "sizeMb": 0, "nsfw": false, "parameters": "8B", "description": "Cloud-hosted via OpenRouter — requires LLM_PROVIDER=openai.", "link": "https://openrouter.ai/meta-llama/llama-3.1-8b-instruct" }
```

### Docs

- Update `flowDiagram.md`: new `llm.py` module node; modules and the turn route call it; Ollama/cloud branch.
- No `datamodell.md` change (no schema change).

## Files

- **New**: `backend/llm.py`, `.env.example`
- **Modified**: `backend/main.py`, `backend/modules/describe.py`, `backend/modules/summarize.py`, `backend/modules/player_intent.py`, `compose.yml`, `config.json`, `flowDiagram.md`, `.gitignore`

## Verification

1. Default mode (no `.env`): `podman compose up backend`, play a turn — behavior identical to today.
2. Cloud mode: create `.env` with OpenRouter key, restart backend, select the OpenRouter model, play a turn; check turn streams, tokens are recorded in the turns table, summarize/describe/player-intent work.
3. `podman compose run --rm tester` against cloud mode with a test config pointing at `meta-llama/llama-3.1-8b-instruct`.
