// Shared utilities for setup.js and game.js

import { initApi } from './api.js';

export async function loadConfig() {
  const r = await fetch('./config.json');
  if (!r.ok) throw new Error('Failed to load config.json');
  const config = await r.json();

  const idxResp = await fetch('./scenarios/index.json');
  if (!idxResp.ok) throw new Error('Failed to load scenarios/index.json');
  const { scenarios: ids } = await idxResp.json();
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('scenarios/index.json must contain a non-empty "scenarios" array');

  config.scenarios = await Promise.all(ids.map(id => loadScenario(id)));
  return config;
}

async function loadScenario(id) {
  const r = await fetch(`./scenarios/${id}.json`);
  if (!r.ok) throw new Error(`Failed to load scenario: ${id}`);
  const card = await r.json();
  validateScenario(card, id);
  // The id is derived from the filename, not stored in the card.
  return { id, card: card.data };
}

// Validates a Character Card V2 document (chara_card_v2 spec).
function validateScenario(card, filename) {
  const errors = [];
  if (card.spec !== 'chara_card_v2') errors.push('"spec" must be "chara_card_v2" (V3 is not supported)');
  const data = card.data || {};
  if (!data.name) errors.push('missing "data.name"');
  const entries = data.character_book?.entries || [];
  entries.forEach((e, i) => {
    if (typeof e.content !== 'string' || !e.content) errors.push(`character_book.entries[${i}] missing "content"`);
    if (e.keys && !Array.isArray(e.keys)) errors.push(`character_book.entries[${i}] "keys" must be an array`);
  });
  if (errors.length) throw new Error(`Scenario "${filename}.json" validation failed: ${errors.join('; ')}`);
}

// ── Card V2 macros ────────────────────────────────────────────────────────────
// Replaces {{char}}, {{user}} and {{original}} in card-sourced text.
// charName: the card's data.name | userName: the player character's name.
// original: only used when a card's system_prompt / post_history_instructions
// override the app default (per spec, {{original}} embeds the replaced text).
export function applyMacros(text, { charName = '', userName = '', original = '' } = {}) {
  if (!text) return text;
  return text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName || 'you')
    .replace(/\{\{original\}\}/gi, original);
}

export { initApi };

// ── Date parsing ──────────────────────────────────────────────────────────────
export function parseDate(str) {
  if (!str) return '—';
  let d = new Date(str);
  if (isNaN(d)) d = new Date(str + 'Z');
  return isNaN(d) ? '—' : d.toLocaleString();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
export function showToast(message, type = 'info') {
  const id = `toast-${Date.now()}`;
  const el = $(`
    <div id="${id}" class="toast align-items-center text-bg-${type} border-0 mb-2" role="alert">
      <div class="d-flex">
        <div class="toast-body">${message}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>
  `);
  $('#toast-container').append(el);
  const toast = new bootstrap.Toast(el[0], { delay: 4000 });
  toast.show();
  el[0].addEventListener('hidden.bs.toast', () => el.remove());
}

// ── Health badge ──────────────────────────────────────────────────────────────
export function setHealthBadge(ok, label) {
  const cls  = ok ? 'bg-success' : 'bg-danger';
  const text = `⬤ ${label}`;
  // update whichever badge element is present on the current page
  $('#health-badge, #health-badge-game')
    .text(text)
    .removeClass('bg-secondary bg-success bg-danger')
    .addClass(cls);
}

export function pollHealth(config, onStatusChange) {
  checkHealth(config, onStatusChange);
  return setInterval(() => checkHealth(config, onStatusChange), 5000);
}

async function checkHealth(config, onStatusChange) {
  const url = `${config.backendUrl}/api/health`;
  try {
    const r    = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    const ok   = data.ollama === 'ok' && data.db === 'ok';
    const label = data.ollama === 'ok' ? (data.db === 'ok' ? 'online' : 'DB error') : 'Ollama offline';
    setHealthBadge(ok, label);
    onStatusChange?.(ok);
  } catch {
    setHealthBadge(false, 'backend offline');
    onStatusChange?.(false);
  }
}

// ── File download ─────────────────────────────────────────────────────────────
export function triggerDownload(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}

// ── Template rendering ────────────────────────────────────────────────────────
// Clones a <template id="tmpl-*"> and fills placeholders:
//   data-bind="key"         → sets .text()
//   data-bind="key" data-attr="attr" → sets the named attribute
//   data-html="key"         → sets .html()
//   data-show="key"         → toggles .d-none based on truthiness
export function renderTemplate(id, data = {}) {
  const tmpl = document.getElementById(id);
  const $el  = $(tmpl.content.cloneNode(true));
  Object.entries(data).forEach(([k, v]) => {
    $el.find(`[data-bind="${k}"]`).each(function () {
      const attr = $(this).data('attr');
      if (attr) $(this).attr(attr, v ?? '');
      else      $(this).text(v ?? '');
    });
    $el.find(`[data-html="${k}"]`).html(v ?? '');
    $el.find(`[data-show="${k}"]`).toggleClass('d-none', !v);
  });
  return $el;
}
