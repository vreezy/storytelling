# CLAUDE.md — Wichtige Hinweise für dieses Projekt

## Kein CDN — alles lokal

- `libs/transformers.min.js`, alle `*.wasm`-Dateien, `libs/bootstrap.min.css`, `libs/bootstrap.bundle.min.js` und `libs/jquery.min.js` müssen lokal vorhanden sein.
- Keine externe Script- oder Stylesheet-URLs (`https://cdn.*`) in HTML-Dateien erlaubt.
- In `app.js` und `dungeon.js` ist `env.allowRemoteModels = false` gesetzt — transformers.js darf zur Laufzeit **keine** HuggingFace-Requests machen.

## Modell-Downloads

- Download erfolgt via `download.py` (im Projekt-Root) in einem Podman-Container.
- Starten: `podman compose run --rm downloader` (im Projekt-Root, **nicht** in einem Unterordner)
- Welche Modelle geladen werden, steuert `.env` im Projekt-Root → Variable `DOWNLOAD_MODELS` (kommagetrennt).
- Modelle landen unter `models/<org>/<modelname>/` (z.B. `models/HuggingFaceTB/SmolLM2-135M-Instruct/`).
- Nur ONNX-Dateien + JSON-Configs werden heruntergeladen; PyTorch-Weights (`.bin`, `.safetensors`) werden nicht benötigt.
- Nach dem Download wird `models-available.js` automatisch generiert — nicht manuell bearbeiten.

## Webserver

- VS Code **Live Server** Extension wird als lokaler HTTP-Server genutzt (kein eigener Server-Container).
- `index.html` → Rechtsklick → "Open with Live Server" → `http://127.0.0.1:5500`
- `dungeon.html` ist unter `http://127.0.0.1:5500/dungeon.html` erreichbar.

## Wichtige Einstellungen in app.js und dungeon.js

```js
env.localModelPath    = '/models/';   // absoluter Pfad ab Root — NICHT './models/'
env.allowRemoteModels = false;        // nie remote laden
env.backends.onnx.wasm.wasmPaths = '/libs/'; // absoluter Pfad — NICHT './libs/'
```

**Wichtig:** Relative Pfade (`./libs/`, `./models/`) führen zu doppelten Pfaden (`/libs/libs/`), weil transformers.js Pfade relativ zur eigenen Datei (`/libs/transformers.min.js`) auflöst.

## Seiten

- `index.html` — Setup-Screen (Modellauswahl, Szenario, Charakter)
- `game.html` — Spielscreen (Story, Aktionseingabe, Sidebar mit Tabs)
- `api.js` — alle Backend-Fetch-Calls als ES-Module-Exports
- `utils.js` — gemeinsame Hilfsfunktionen (showToast, pollHealth, renderTemplate, …)
- `setup.js` — Logik für index.html
- `game.js` — Logik für game.html
- `style.css` — gemeinsames CSS
- Szenarien und Generierungsparameter in `dungeon-config.json`

## Datenbankschema-Dokumentation

- Das aktuelle SQLite-Schema ist in [`datamodell.md`](datamodell.md) als Mermaid-ERD dokumentiert.
- **Bei jeder Schemaänderung** (neue Spalten, neue Tabellen, geänderte Typen, neue Migrations in `main.py`) muss `datamodell.md` sofort aktualisiert werden.
- Migrationen werden in `backend/main.py` → `init_db()` per `PRAGMA table_info` geprüft und als `ALTER TABLE` ausgeführt.

## Modell-Kategorien

- **chatml-Template** (SmolLM2-*-Instruct): ChatML-Format `<|im_start|>role\n...<|im_end|>`
- **tinyllama-Template** (TinyLlama-Chat): `<|role|>\n...</s>`
- **completion** (GPT-2, distilgpt2, BLOOM, etc.): Kein Chat-Format — nur Textvervollständigung

## GPU/CPU

- WebGPU-Verfügbarkeit wird einmalig beim Seitenload geprüft (`navigator.gpu`).
- Toggle bleibt `disabled` wenn kein WebGPU → kein manueller Override nötig.
- GPU dtype: `q4f16` (chatml/tinyllama), `q8` (completion)
- CPU dtype: `q4` (chatml/tinyllama), `q8` (completion)
