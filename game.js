// StoryTelling — game screen logic

import {
  loadConfig, initApi, showToast, pollHealth, parseDate, renderTemplate,
} from './utils.js';
import {
  getGame, getCharacter, getCards, putCharacter,
  createCard, putCard, deleteCard,
  streamTurn, undoTurn, getStats,
} from './api.js';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  config:      null,
  gameId:      null,
  modelId:     null,
  scenario:    null,
  systemPrompt:'',
  character:   { name: '', description: '', class: '', stats: null, notes: '' },
  cards:       [],
  messages:    [],
  segments:    [],
  lastAction:  null,
  generating:  false,
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
$(async function () {
  const id = parseInt(new URLSearchParams(location.search).get('id'));
  if (!id) { location.href = 'index.html'; return; }

  try {
    state.config = await loadConfig();
  } catch {
    showToast('Failed to load dungeon-config.json.', 'danger');
    return;
  }

  initApi(state.config);
  pollHealth(state.config, (ok) => {
    if (ok) {
      $('#action-input').prop('disabled', state.gameId === null || state.generating);
    } else {
      $('#action-input, #send-btn').prop('disabled', true);
    }
  });

  bindEvents();

  try {
    await loadGame(id);
  } catch (e) {
    showToast(`Failed to load game: ${e.message}`, 'danger');
    setTimeout(() => { location.href = 'index.html'; }, 2000);
  }
});

// ── Load game from DB ─────────────────────────────────────────────────────────
async function loadGame(id) {
  const game = await getGame(id);

  state.gameId       = game.id;
  state.modelId      = game.model_id;
  state.systemPrompt = game.system_prompt || '';
  state.character    = { name: '', description: '', class: '', stats: null, notes: '' };
  state.messages     = [];
  state.segments     = [];
  state.cards        = [];
  state.lastAction   = null;

  try {
    const ch = await getCharacter(id);
    if (ch.name) state.character = { ...ch, stats: ch.stats ? JSON.parse(ch.stats) : null };
  } catch { /* no character yet */ }

  try {
    state.cards = await getCards(id);
  } catch { state.cards = []; }

  const sc = (state.config.scenarios || []).find(s => s.id === game.scenario_id) || {};
  state.scenario = sc;
  $('#scenario-title').text(`${sc.icon || ''} ${sc.name || game.title}`);
  $('#story-text').empty();
  state.segments = [];

  if (game.opening_text) {
    appendSegment(game.opening_text + '\n\n', 'narrative');
    state.messages.push({ role: 'assistant', content: game.opening_text });
  }

  for (const t of game.turns) {
    if (t.raw_input) {
      const playerLine = buildPlayerActionText(t.raw_input, t.action_type);
      appendSegment(playerLine, 'action');
      state.messages.push({ role: 'user', content: playerLine });
    }
    if (t.response) {
      appendSegment(t.response + '\n\n', 'narrative');
      state.messages.push({ role: 'assistant', content: t.response });
    }
  }

  const maxMsg = state.config.contextMaxMessages || 20;
  if (state.messages.length > maxMsg) state.messages = state.messages.slice(-maxMsg);

  updateContextBar();
  renderCharSidebar();
  $('#debug-panel').removeClass('d-none');
  $('#send-btn, #action-input').prop('disabled', false);
  $('#action-input').trigger('focus');
  history.replaceState(null, '', `?id=${id}`);
  const el = document.getElementById('story-text');
  el.scrollTop = el.scrollHeight;
}

// ── Send action ───────────────────────────────────────────────────────────────
async function sendAction() {
  if (state.generating || !state.gameId) return;
  const text = $('#action-input').val().trim();
  if (!text) return;
  const type = $('#action-type').val();
  state.lastAction = { text, type };
  $('#action-input').val('');
  await generateContinuation(text, type);
}

// ── Generate continuation ─────────────────────────────────────────────────────
async function generateContinuation(actionText, actionType) {
  state.generating = true;
  $('#send-btn, #undo-btn, #retry-btn').prop('disabled', true);

  const playerLine = buildPlayerActionText(actionText, actionType);
  appendSegment(playerLine, 'action');

  const messages = buildMessages(actionType, playerLine);
  const gen      = state.config.generation || {};

  console.group('%c[Dungeon] Turn', 'color:#7ecfff;font-weight:bold');
  console.log('%cModel:', 'color:#aaa', state.modelId);
  console.log('%cAction:', 'color:#aaa', actionType, actionText);
  console.log('%cMessages (' + messages.length + '):', 'color:#aaa', messages);
  console.groupEnd();

  const streamSpan = $('<span class="narrative streaming-cursor"></span>').appendTo('#story-text');
  let response = '';

  try {
    const payload = {
      action_type:    actionType,
      raw_input:      actionText,
      messages,
      model_id:       state.modelId,
      temperature:    gen.temperature ?? 0.75,
      num_predict:    gen.maxNewTokens ?? 200,
      repeat_penalty: gen.repetitionPenalty ?? 1.1,
      num_ctx:        gen.numCtx ?? 4096,
    };

    await streamTurn(
      state.gameId,
      payload,
      (token) => {
        response += token;
        streamSpan.text(response);
        const el = document.getElementById('story-text');
        el.scrollTop = el.scrollHeight;
      },
      (doneMsg) => {
        updateDebugPanel(doneMsg, messages, {
          model_id:       state.modelId,
          temperature:    gen.temperature,
          num_predict:    gen.maxNewTokens,
          repeat_penalty: gen.repetitionPenalty,
        });
      },
    );

    const finalText = (response || '(No response generated)') + '\n\n';
    streamSpan.remove();
    appendSegment(finalText, 'narrative');

    state.messages.push({ role: 'user',      content: playerLine });
    state.messages.push({ role: 'assistant', content: response });
    const maxMsg = state.config.contextMaxMessages || 20;
    if (state.messages.length > maxMsg) state.messages = state.messages.slice(-maxMsg);
    updateContextBar();

  } catch (err) {
    streamSpan.text(`[Error: ${err.message}]\n`).addClass('text-danger').removeClass('streaming-cursor');
    showToast(`Generation error: ${err.message}`, 'danger');
  } finally {
    state.generating = false;
    $('#send-btn, #retry-btn, #undo-btn').prop('disabled', false);
    $('#action-input').trigger('focus');
  }
}

// ── Message builder (shared by generateContinuation & debug preview) ──────────
function buildMessages(actionType, playerLine) {
  const charCtx      = buildCharacterContext();
  const actionPrompt = state.config.actionPrompts?.[actionType] || '';
  const cardsCtx     = buildCardsContext();
  let sysContent = [state.systemPrompt, charCtx, cardsCtx, actionPrompt].filter(Boolean).join('\n\n');

  let history = [...state.messages];
  if (history.length && history[0].role === 'assistant') {
    sysContent += '\n\nStory opening: ' + history[0].content;
    history = history.slice(1);
  }

  return [
    { role: 'system', content: sysContent },
    ...history,
    { role: 'user', content: playerLine },
  ];
}

// ── Undo ──────────────────────────────────────────────────────────────────────
async function undo() {
  if (state.generating || !state.gameId) return;
  try { await undoTurn(state.gameId); } catch { /* ignore */ }

  state.segments = state.segments.slice(0, -2);
  if (state.messages.length >= 2) state.messages = state.messages.slice(0, -2);

  rebuildStoryDisplay();
  updateContextBar();
  if (state.segments.length === 0) $('#undo-btn').prop('disabled', true);
}

// ── Retry ─────────────────────────────────────────────────────────────────────
async function retry() {
  if (!state.lastAction || state.generating) return;
  await undo();
  await generateContinuation(state.lastAction.text, state.lastAction.type);
}

// ── Story display ─────────────────────────────────────────────────────────────
function appendSegment(text, cssClass) {
  state.segments.push({ text, cssClass });
  const idx  = state.segments.length - 1;
  const $span = $('<span></span>').addClass(cssClass).text(text);
  attachSegmentEdit($span, idx);
  $('#story-text').append($span);
  const el = document.getElementById('story-text');
  el.scrollTop = el.scrollHeight;
  return $span;
}

function rebuildStoryDisplay() {
  $('#story-text').empty();
  state.segments.forEach((seg, i) => {
    const $span = $('<span></span>').addClass(seg.cssClass).text(seg.text);
    attachSegmentEdit($span, i);
    $span.appendTo('#story-text');
  });
  const el = document.getElementById('story-text');
  el.scrollTop = el.scrollHeight;
}

function attachSegmentEdit($span, idx) {
  $span.on('click', function () {
    if (state.generating) return;
    const $ta = $('<textarea class="segment-edit"></textarea>')
      .val(state.segments[idx].text)
      .on('keydown', function (e) {
        if (e.key === 'Escape') $ta.replaceWith($span);
      })
      .on('blur', function () {
        const newText = $ta.val();
        state.segments[idx].text = newText;
        $span.text(newText);
        $ta.replaceWith($span);
        rebuildMessagesFromSegments();
      });
    $span.replaceWith($ta);
    $ta.css('width', $('#story-text').width() + 'px');
    $ta[0].style.height = $ta[0].scrollHeight + 'px';
    $ta.focus();
  });
}

function rebuildMessagesFromSegments() {
  const msgs = state.segments.map(s => ({
    role:    s.cssClass === 'narrative' ? 'assistant' : 'user',
    content: s.text.replace(/\n+$/, ''),
  }));
  const maxMsg = state.config.contextMaxMessages || 20;
  state.messages = msgs.length > maxMsg ? msgs.slice(-maxMsg) : msgs;
  updateContextBar();
}

// ── Context bar ───────────────────────────────────────────────────────────────
function updateContextBar() {
  const msgChars  = state.messages.reduce((a, m) => a + m.content.length, 0);
  const approxTok = Math.floor(msgChars / 4);
  const max = (state.config.contextMaxMessages || 20) * 150;
  const pct = Math.min(100, Math.floor((approxTok / max) * 100));
  $('#context-bar')
    .css('width', `${pct}%`)
    .attr('aria-valuenow', pct)
    .removeClass('bg-success bg-warning bg-danger')
    .addClass(pct < 60 ? 'bg-success' : pct < 85 ? 'bg-warning' : 'bg-danger');
  $('#context-label').removeClass('d-none').text(`~${approxTok} tok, ${state.messages.length} msgs`);
}

// ── Debug panel ───────────────────────────────────────────────────────────────
function updateDebugPanel(doneMsg, messages, params) {
  const tps = doneMsg.duration_ms > 0
    ? (doneMsg.completion_tokens * 1000 / doneMsg.duration_ms).toFixed(1)
    : '—';
  $('#dbg-prompt-tok').text(doneMsg.prompt_tokens ?? '—');
  $('#dbg-compl-tok').text(doneMsg.completion_tokens ?? '—');
  $('#dbg-total-tok').text(doneMsg.total_tokens ?? '—');
  $('#dbg-duration').text(doneMsg.duration_ms != null ? `${doneMsg.duration_ms} ms` : '—');
  $('#dbg-tps').text(tps);
  $('#dbg-prompt').val(JSON.stringify(messages, null, 2));
  $('#dbg-ollama-req').val(JSON.stringify(params, null, 2));
}

// ── Debug modal ───────────────────────────────────────────────────────────────
function openDebugModal() {
  const ap = state.config.actionPrompts || {};
  $('#debug-global-prompt').val(state.config.systemPrompt || '');
  $('#debug-scenario-prompt').val(state.scenario?.systemPrompt || '');
  $('#debug-char-context').val(buildCharacterContext());
  $('#debug-action-do').val(ap.do || '');
  $('#debug-action-say').val(ap.say || '');
  $('#debug-action-story').val(ap.story || '');
  $('#debug-active-action').text($('#action-type').val() || 'do');
  $('#debug-last-prompt').val(
    state.messages.length ? JSON.stringify(state.messages, null, 2) : '(no turns yet)'
  );
  updateDebugCombined();
  buildNextPromptPreview();

  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('debug-modal'));
  modal.show();

  // Live-update next prompt when action prompts are edited
  const $modal = $('#debug-modal');
  $modal.off('input.nextprompt').on(
    'input.nextprompt',
    '#debug-global-prompt, #debug-scenario-prompt, #debug-action-do, #debug-action-say, #debug-action-story',
    buildNextPromptPreview,
  );
  $('#action-type').off('change.nextprompt').on('change.nextprompt', function () {
    if ($('#debug-modal').hasClass('show')) buildNextPromptPreview();
  });
  document.getElementById('debug-modal').addEventListener('hidden.bs.modal', () => {
    $modal.off('input.nextprompt');
    $('#action-type').off('change.nextprompt');
  }, { once: true });
}

function updateDebugCombined() {
  const activeAction = $('#action-type').val() || 'do';
  const ap = state.config.actionPrompts || {};
  const parts = [
    $('#debug-global-prompt').val(),
    $('#debug-scenario-prompt').val(),
    $('#debug-char-context').val(),
    ap[activeAction] || '',
  ].filter(s => s.trim());
  $('#debug-combined').val(parts.join('\n\n'));
}

function buildNextPromptPreview() {
  const actionText = $('#action-input').val().trim() || '(type an action to preview)';
  const actionType = $('#action-type').val() || 'do';
  const playerLine = buildPlayerActionText(actionText, actionType);

  // Use live values from debug modal inputs if changed
  const origSystem   = state.config.systemPrompt;
  const origScenario = state.scenario?.systemPrompt;
  const origAp       = { ...state.config.actionPrompts };

  state.config.systemPrompt = $('#debug-global-prompt').val();
  if (state.scenario) state.scenario.systemPrompt = $('#debug-scenario-prompt').val();
  state.config.actionPrompts = {
    do:    $('#debug-action-do').val(),
    say:   $('#debug-action-say').val(),
    story: $('#debug-action-story').val(),
  };

  const messages = buildMessages(actionType, playerLine);

  // Restore
  state.config.systemPrompt = origSystem;
  if (state.scenario) state.scenario.systemPrompt = origScenario;
  state.config.actionPrompts = origAp;

  $('#debug-next-prompt').val(JSON.stringify(messages, null, 2));
  $('#debug-next-action-type').text(actionType);
  $('#debug-action-preview').val($('#action-input').val());
}

// ── Stats modal ───────────────────────────────────────────────────────────────
async function openStatsModal() {
  // Stats modal is on index.html; this is a no-op placeholder if ever needed here
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildPlayerActionText(text, type) {
  switch (type) {
    case 'say':   return `> You say: "${text}"\n`;
    case 'story': return `[${text}]\n`;
    default:      return `> You ${text}\n`;
  }
}

function buildCharacterContext() {
  const c = state.character;
  if (!c) return '';
  const parts = [c.name, c.description].filter(Boolean);
  if (c.class) parts.push(`Class: ${c.class}`);
  if (c.notes) parts.push(`Notes: ${c.notes}`);
  return parts.length ? `The protagonist is ${parts.join(' — ')}.` : '';
}

function buildCardsContext() {
  const active = (state.cards || []).filter(c => c.active);
  if (!active.length) return '';
  const lines = active.map(c =>
    `[${c.type.toUpperCase()}] ${c.name}${c.description ? ': ' + c.description : ''}`
  );
  return 'World context:\n' + lines.join('\n');
}

// ── Character sidebar ─────────────────────────────────────────────────────────
function renderCharSidebar() {
  const c    = state.character;
  const $tmpl = renderTemplate('tmpl-char-fields');
  $('#char-name-edit', $tmpl).val(c.name || '');
  $('#char-class-edit', $tmpl).val(c.class || '');
  $('#char-desc-edit', $tmpl).val(c.description || '');
  $('#char-notes-edit', $tmpl).val(c.notes || '');
  $('#char-fields').empty().append($tmpl);

  async function saveCharacter() {
    state.character = {
      ...state.character,
      name:        $('#char-name-edit').val().trim(),
      class:       $('#char-class-edit').val().trim(),
      description: $('#char-desc-edit').val().trim(),
      notes:       $('#char-notes-edit').val().trim(),
    };
    await putCharacter(state.gameId, state.character).catch(() => {});
  }

  $('#char-name-edit, #char-class-edit, #char-desc-edit, #char-notes-edit').on('blur', saveCharacter);
}

// ── World Cards ───────────────────────────────────────────────────────────────
const CARD_TYPES = ['location', 'npc', 'item', 'faction', 'lore'];

function renderWorldCards() {
  const $list = $('#world-cards-list').empty();
  if (!state.cards.length) {
    $list.html('<div class="text-secondary small text-center py-2">No cards yet.</div>');
    return;
  }
  state.cards.forEach(card => $list.append(buildCardEl(card)));
}

function buildCardEl(card) {
  const $tmpl = renderTemplate('tmpl-world-card');
  const $el   = $tmpl.find('.card');

  $el.attr('data-card-id', card.id);
  $el.find('.card-active-toggle').prop('checked', !!card.active);
  $el.find('.card-type-sel').val(card.type || 'location');
  $el.find('.card-name-input').val(card.name || '');
  $el.find('.card-desc-input').val(card.description || '');

  async function saveCard() {
    const idx = state.cards.findIndex(c => c.id === card.id);
    const updated = {
      ...card,
      type:        $el.find('.card-type-sel').val(),
      name:        $el.find('.card-name-input').val().trim(),
      description: $el.find('.card-desc-input').val().trim(),
      active:      $el.find('.card-active-toggle').is(':checked') ? 1 : 0,
    };
    await putCard(state.gameId, card.id, updated).catch(() => {});
    if (idx >= 0) state.cards[idx] = updated;
  }

  $el.find('.card-active-toggle, .card-type-sel').on('change', saveCard);
  $el.find('.card-name-input, .card-desc-input').on('blur', saveCard);
  $el.find('.card-del-btn').on('click', async () => {
    if (!confirm(`Delete card "${card.name}"?`)) return;
    await deleteCard(state.gameId, card.id).catch(() => {});
    state.cards = state.cards.filter(c => c.id !== card.id);
    $el.remove();
    if (!state.cards.length) renderWorldCards();
  });

  return $tmpl;
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  $('#send-btn').on('click', sendAction);
  $('#undo-btn').on('click', undo);
  $('#retry-btn').on('click', retry);
  $('#debug-btn').on('click', openDebugModal);

  $('#char-toggle-btn').on('click', function () {
    const $sheet = $('#char-sheet');
    $sheet.css('display') === 'none' ? $sheet.css('display', 'flex') : $sheet.hide();
  });

  $('#sidebar-tabs').on('click', '[data-tab]', function () {
    const tab = $(this).data('tab');
    $('#sidebar-tabs .nav-link').removeClass('active');
    $(this).addClass('active');
    $('#tab-char, #tab-world').addClass('d-none');
    $(`#tab-${tab}`).removeClass('d-none');
    if (tab === 'world') renderWorldCards();
  });

  $('#add-card-btn').on('click', async function () {
    const card = await createCard(state.gameId, {
      type: 'location', name: '', description: '', active: 1,
    }).catch(() => null);
    if (!card) return;
    state.cards.push(card);
    $('#world-cards-list .text-secondary').remove();
    $('#world-cards-list').append(buildCardEl(card));
    $('#world-cards-list').find('.card-name-input').last().trigger('focus');
  });

  $('#action-input').on('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAction(); }
  });

  // Debug modal — live prompt editing syncs to state
  $('#debug-global-prompt').on('input', function () {
    state.config.systemPrompt = $(this).val(); updateDebugCombined();
  });
  $('#debug-scenario-prompt').on('input', function () {
    if (state.scenario) state.scenario.systemPrompt = $(this).val(); updateDebugCombined();
  });
  $('#debug-action-do').on('input', function () {
    state.config.actionPrompts.do = $(this).val(); updateDebugCombined();
  });
  $('#debug-action-say').on('input', function () {
    state.config.actionPrompts.say = $(this).val(); updateDebugCombined();
  });
  $('#debug-action-story').on('input', function () {
    state.config.actionPrompts.story = $(this).val(); updateDebugCombined();
  });
}
