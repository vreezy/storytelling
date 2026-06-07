// All backend API calls — import and use in setup.js / game.js

let _base = 'http://localhost:8000';

export function initApi(config) {
  _base = config.backendUrl;
}

// ── Health ────────────────────────────────────────────────────────────────────
export async function getHealth() {
  const r = await fetch(`${_base}/api/health`, { signal: AbortSignal.timeout(3000) });
  return r.json();
}

// ── Models ────────────────────────────────────────────────────────────────────
export async function getModels() {
  const r = await fetch(`${_base}/api/models`);
  return r.json();
}

export async function deleteModel(modelId) {
  const r = await fetch(`${_base}/api/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`Delete failed: ${r.status}`);
}

// onProgress({ status, completed, total }) called for each NDJSON line
export async function pullModel(modelId, onProgress) {
  const r = await fetch(`${_base}/api/models/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId }),
  });
  if (!r.ok) throw new Error(`Backend error: ${r.status}`);

  const reader  = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';
  let success   = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      onProgress?.(msg);
      if (msg.status === 'success') success = true;
    }
  }
  if (!success) throw new Error('Pull did not complete successfully');
}

// ── Games ─────────────────────────────────────────────────────────────────────
export async function getGames() {
  const r = await fetch(`${_base}/api/games`);
  return r.json();
}

export async function createGame(payload) {
  const r = await fetch(`${_base}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Could not create game: ${r.status}`);
  return r.json();
}

export async function getGame(id) {
  const r = await fetch(`${_base}/api/games/${id}`);
  if (!r.ok) throw new Error(`Game not found: ${r.status}`);
  return r.json();
}

export async function deleteGame(id) {
  await fetch(`${_base}/api/games/${id}`, { method: 'DELETE' });
}

export async function putGame(gameId, data) {
  const r = await fetch(`${_base}/api/games/${gameId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`putGame failed: ${r.status}`);
  return r.json();
}

// ── Character ─────────────────────────────────────────────────────────────────
export async function getCharacter(gameId) {
  const r = await fetch(`${_base}/api/games/${gameId}/character`);
  if (!r.ok) throw new Error('No character');
  return r.json();
}

export async function putCharacter(gameId, data) {
  await fetch(`${_base}/api/games/${gameId}/character`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ── World Cards ───────────────────────────────────────────────────────────────
export async function getCards(gameId) {
  const r = await fetch(`${_base}/api/games/${gameId}/cards`);
  return r.json();
}

export async function createCard(gameId, data) {
  const r = await fetch(`${_base}/api/games/${gameId}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json();
}

export async function putCard(gameId, cardId, data) {
  await fetch(`${_base}/api/games/${gameId}/cards/${cardId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteCard(gameId, cardId) {
  await fetch(`${_base}/api/games/${gameId}/cards/${cardId}`, { method: 'DELETE' });
}

// ── Turns ─────────────────────────────────────────────────────────────────────
// onToken(text), onDone(doneMsg) called during streaming
export async function streamTurn(gameId, payload, onToken, onDone) {
  const r = await fetch(`${_base}/api/games/${gameId}/turns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Turn request failed: ${r.status}`);

  const reader  = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === 'token') {
        onToken?.(msg.content);
      } else if (msg.type === 'done') {
        onDone?.(msg);
      } else if (msg.type === 'error') {
        throw new Error(msg.message);
      }
    }
  }
}

export async function putTurn(gameId, turnId, data) {
  const r = await fetch(`${_base}/api/games/${gameId}/turns/${turnId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`putTurn failed: ${r.status}`);
  return r.json();
}

export async function undoTurn(gameId) {
  await fetch(`${_base}/api/games/${gameId}/turns/last`, { method: 'DELETE' });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export async function getStats() {
  const r = await fetch(`${_base}/api/stats`);
  return r.json();
}
