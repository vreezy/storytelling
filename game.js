// StoryTelling — game screen logic

import {
  loadConfig, initApi, showToast, pollHealth, parseDate, renderTemplate, triggerDownload,
} from './utils.js';
import {
  getGame, getCharacter, getCards, putCharacter, putGame,
  createCard, putCard, deleteCard,
  streamTurn, putTurn, undoTurn, getStats, summarizeGame,
  getGameScenario, getModels,
} from './api.js';

// ── Active segment edit cleanup handle ────────────────────────────────────────
let _cancelSegEdit = null;

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  config:         null,
  gameId:         null,
  modelId:        null,
  scenario:       null,
  systemPrompt:   '',   // global DM prompt (games.system_prompt)
  scenarioPrompt: '',   // scenario-specific DM instructions (games.scenario_prompt)
  customPrompt:   '',   // custom prompt extension (games.custom_prompt)
  character:      { name: '', description: '', class: '', stats: null, notes: '' },
  cards:          [],
  messages:       [],
  segments:       [],
  lastAction:     null,
  generating:     false,
  summarizing:    false,
  storySummary:   '',
  numPredict:     200,
  sidebarOpen:    false,
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
$(async function () {
  const id = parseInt(new URLSearchParams(location.search).get('id'));
  if (!id) { location.href = 'index.html'; return; }

  try {
    state.config = await loadConfig();
  } catch {
    showToast('Failed to load config.json.', 'danger');
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

  state.gameId          = game.id;
  state.modelId         = game.model_id;
  state.systemPrompt    = game.system_prompt || '';
  state.scenarioPrompt  = game.scenario_prompt || '';
  state.customPrompt    = game.custom_prompt || '';
  state.storySummary    = game.story_summary || '';
  state.numPredict      = game.num_predict ?? 200;
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

  state.scenario = {
    id:          game.scenario_id,
    name:        game.scenario_name || game.title,
    icon:        game.scenario_icon || '',
    description: game.scenario_description || '',
  };
  $('#scenario-title').text(`${state.scenario.icon} ${state.scenario.name}`.trim());
  $('#scenario-icon-edit').val(state.scenario.icon);
  $('#scenario-name-edit').val(state.scenario.name);
  $('#scenario-desc-edit').val(state.scenario.description);
  $('#story-text').empty();
  state.segments = [];

  if (game.opening_text) {
    appendSegment(game.opening_text + '\n\n', 'narrative', 'game', 'opening_text');
    state.messages.push({ role: 'assistant', content: game.opening_text });
  }

  for (const t of game.turns) {
    if (t.raw_input) {
      const playerLine = buildPlayerActionText(t.raw_input, t.action_type);
      appendSegment(playerLine, 'action', t.id, 'raw_input');
      state.messages.push({ role: 'user', content: playerLine });
    }
    if (t.response) {
      appendSegment(t.response + '\n\n', 'narrative', t.id, 'response');
      state.messages.push({ role: 'assistant', content: t.response });
    }
  }

  const maxMsg = state.config.contextMaxMessages || 20;
  if (state.messages.length > maxMsg) state.messages = state.messages.slice(-maxMsg);

  updateContextBar();
  renderCharSidebar();

  // Populate sidebar tab fields
  $('#num-predict-range').val(state.numPredict);
  $('#num-predict-val').text(state.numPredict);
  $('#num-predict-reset').toggleClass('d-none', state.numPredict === 200);
  $('#scenario-prompt-edit').val(state.scenarioPrompt);
  $('#plot-prompt-edit').val(state.systemPrompt);
  $('#custom-prompt-edit').val(state.customPrompt);

  // Restore sidebar width (default 500px set in HTML)
  const savedW = localStorage.getItem('sidebar_width');
  if (savedW) $('#char-sheet').css('width', parseInt(savedW) + 'px');

  $('#debug-panel').removeClass('d-none');
  $('#send-btn, #action-input, #continue-btn').prop('disabled', false);
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

// ── Continue (no player input) ────────────────────────────────────────────────
async function continueStory() {
  if (state.generating || !state.gameId) return;
  state.lastAction = null;
  await generateContinuation(null, 'continue');
}

// ── Generate continuation ─────────────────────────────────────────────────────
async function generateContinuation(actionText, actionType) {
  state.generating = true;
  $('#send-btn, #undo-btn, #retry-btn, #continue-btn').prop('disabled', true);

  const isContinue = actionText === null;
  let playerLine   = null;

  let playerSegIdx = null;
  if (!isContinue) {
    playerLine = buildPlayerActionText(actionText, actionType);
    playerSegIdx = state.segments.length;
    appendSegment(playerLine, 'action');
  }

  const messages = buildMessages(actionType, playerLine);
  const gen      = state.config.generation || {};

  console.group('%c[Dungeon] Turn', 'color:#7ecfff;font-weight:bold');
  console.log('%cMode:', 'color:#aaa', isContinue ? 'continue' : actionType);
  console.log('%cMessages (' + messages.length + '):', 'color:#aaa', messages);
  console.groupEnd();

  const streamSpan = $('<span class="narrative streaming-cursor"></span>').appendTo('#story-text');
  let response = '';
  let doneTurnId = null;

  try {
    const payload = {
      action_type:    actionType,
      raw_input:      actionText ?? '',
      messages,
      model_id:       state.modelId,
      temperature:    gen.temperature ?? 0.75,
      num_predict:    state.numPredict,
      repeat_penalty: gen.repetitionPenalty ?? 1.1,
      num_ctx:        gen.numCtx   ?? 4096,
      num_gpu:        gen.numGpu   ?? 99,
      num_batch:      gen.numBatch ?? 512,
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
        doneTurnId = doneMsg.turn_id ?? null;
        updateDebugPanel(doneMsg, messages, {
          model_id:       state.modelId,
          temperature:    gen.temperature,
          num_predict:    state.numPredict,
          repeat_penalty: gen.repetitionPenalty,
        });
      },
    );

    const trimmed   = response ? trimToLastSentence(response) : '';
    const finalText = (trimmed || '(No response generated)') + '\n\n';
    streamSpan.remove();
    // Backfill turnId onto the player segment now that we know it
    if (doneTurnId !== null && playerSegIdx !== null) {
      state.segments[playerSegIdx].turnId = doneTurnId;
      state.segments[playerSegIdx].field  = 'raw_input';
    }
    appendSegment(finalText, 'narrative', doneTurnId, 'response');

    if (!isContinue) {
      state.messages.push({ role: 'user', content: playerLine });
    }
    state.messages.push({ role: 'assistant', content: trimmed || response });
    const maxMsg = state.config.contextMaxMessages || 20;
    if (state.messages.length > maxMsg) {
      if (!state.summarizing) {
        const overflow = state.messages.slice(0, state.messages.length - maxMsg);
        state.summarizing = true;
        summarizeGame(state.gameId, {
          messages:         overflow,
          existing_summary: state.storySummary,
        }).then(result => {
          state.storySummary = result.summary;
        }).catch(err => {
          console.warn('[summary] failed:', err);
        }).finally(() => {
          state.summarizing = false;
        });
      }
      state.messages = state.messages.slice(-maxMsg);
    }
    updateContextBar();
    if (!$('#tab-debug').hasClass('d-none')) refreshDebugTab();

  } catch (err) {
    streamSpan.text(`[Error: ${err.message}]\n`).addClass('text-danger').removeClass('streaming-cursor');
    showToast(`Generation error: ${err.message}`, 'danger');
  } finally {
    state.generating = false;
    $('#send-btn, #retry-btn, #undo-btn, #continue-btn').prop('disabled', false);
    $('#action-input').trigger('focus');
  }
}

// ── Sentence trimmer ──────────────────────────────────────────────────────────
function trimToLastSentence(text) {
  const t = text.trimEnd();
  // Greedily match up to the last sentence-ending punctuation + optional closing quotes
  const m = t.match(/^[\s\S]*[.!?…]["'''")\]»]*/);
  // Only apply if result keeps at least 20% of the text (avoid over-trimming)
  if (m && m[0].length >= t.length * 0.2) return m[0];
  return t;
}

// ── Message builder (shared by generateContinuation & debug preview) ──────────
function buildMessages(actionType, playerLine) {
  const charCtx      = buildCharacterContext();
  const actionPrompt = actionType === 'continue'
    ? ''
    : (state.config.actionPrompts?.[actionType] || '');
  const continueMsg = actionType === 'continue'
    ? (state.config.actionPrompts?.continue || 'Continue.') : null;
  const cardsCtx     = buildCardsContext(playerLine || '');
  let sysContent = [
    state.systemPrompt,
    state.scenarioPrompt,
    state.customPrompt,
    charCtx,
    cardsCtx,
    state.storySummary ? `Story so far: ${state.storySummary}` : '',
    actionPrompt,
  ].filter(Boolean).join('\n\n');

  let history = [...state.messages];
  if (history.length && history[0].role === 'assistant') {
    sysContent += '\n\nStory opening: ' + history[0].content;
    history = history.slice(1);
  }

  const msgs = [
    { role: 'system', content: sysContent },
    ...history,
  ];

  if (playerLine) {
    msgs.push({ role: 'user', content: playerLine });
  } else if (continueMsg) {
    msgs.push({ role: 'user', content: continueMsg });
  }

  return msgs;
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
  if (!$('#tab-debug').hasClass('d-none')) refreshDebugTab();
}

// ── Retry ─────────────────────────────────────────────────────────────────────
async function retry() {
  if (!state.lastAction || state.generating) return;
  await undo();
  await generateContinuation(state.lastAction.text, state.lastAction.type);
}

// ── Story display ─────────────────────────────────────────────────────────────
function appendSegment(text, cssClass, turnId = null, field = null) {
  state.segments.push({ text, cssClass, turnId, field });
  const idx   = state.segments.length - 1;
  const $span = $('<span></span>').addClass(cssClass).text(text);
  attachSegmentEdit($span, idx);
  $('#story-text').append($span);
  const el = document.getElementById('story-text');
  el.scrollTop = el.scrollHeight;
  return $span;
}

function rebuildStoryDisplay() {
  if (_cancelSegEdit) _cancelSegEdit();
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
    // Close any other open edit first
    if (_cancelSegEdit) _cancelSegEdit();

    let done = false;

    const finish = (doSave) => {
      if (done) return;
      done = true;
      _cancelSegEdit = null;
      $(document).off('mousedown.segEdit');
      if (doSave) {
        const newText = $ta.val();
        state.segments[idx].text = newText;
        $span.text(newText);
        rebuildMessagesFromSegments();
        // Persist to DB
        const seg = state.segments[idx];
        if (seg.turnId === 'game') {
          putGame(state.gameId, { opening_text: newText.trimEnd() })
            .then(() => showToast('Saved.', 'success'))
            .catch(() => showToast('Failed to save.', 'danger'));
        } else if (seg.turnId) {
          putTurn(state.gameId, seg.turnId, { [seg.field]: newText.trimEnd() })
            .then(() => showToast('Saved.', 'success'))
            .catch(() => showToast('Failed to save.', 'danger'));
        }
      }
      $ta.replaceWith($span);
    };

    // Exposed so rebuildStoryDisplay/undo can flush the edit before wiping DOM
    _cancelSegEdit = () => finish(true);

    const $ta = $('<textarea class="segment-edit"></textarea>')
      .val(state.segments[idx].text)
      .on('keydown', function (e) {
        if (e.key === 'Escape') finish(false);
      });

    // Save when the user clicks anywhere outside the textarea.
    // Using mousedown (not blur) avoids false triggers from sidebar focus management.
    $(document).on('mousedown.segEdit', function (e) {
      if (!$(e.target).is($ta) && !$.contains($ta[0], e.target)) {
        finish(true);
      }
    });

    // Use detach() not replaceWith() so $span keeps its click handler for future edits.
    $span.after($ta).detach();
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

// ── Debug tab ─────────────────────────────────────────────────────────────────
function refreshDebugTab() {
  const ap = state.config.actionPrompts || {};
  $('#debug-global-prompt').val(state.systemPrompt || '');
  $('#debug-scenario-prompt').val(state.scenarioPrompt || '');
  $('#debug-custom-prompt').val(state.customPrompt || '');
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
}

function updateDebugCombined() {
  const activeAction = $('#action-type').val() || 'do';
  const ap = state.config.actionPrompts || {};
  const parts = [
    $('#debug-global-prompt').val(),
    $('#debug-scenario-prompt').val(),
    state.customPrompt || '',
    $('#debug-char-context').val(),
    ap[activeAction] || '',
  ].filter(s => s.trim());
  $('#debug-combined').val(parts.join('\n\n'));
}

function buildNextPromptPreview() {
  const actionText = $('#action-input').val().trim() || '(type an action to preview)';
  const actionType = $('#action-type').val() || 'do';
  const playerLine = buildPlayerActionText(actionText, actionType);

  const origSystem   = state.systemPrompt;
  const origScenario = state.scenarioPrompt;
  const origAp       = { ...state.config.actionPrompts };

  state.systemPrompt   = $('#debug-global-prompt').val();
  state.scenarioPrompt = $('#debug-scenario-prompt').val();
  state.config.actionPrompts = {
    do:    $('#debug-action-do').val(),
    say:   $('#debug-action-say').val(),
    story: $('#debug-action-story').val(),
  };

  const messages = buildMessages(actionType, playerLine);

  state.systemPrompt   = origSystem;
  state.scenarioPrompt = origScenario;
  state.config.actionPrompts = origAp;

  $('#debug-next-prompt').val(JSON.stringify(messages, null, 2));
  $('#debug-next-action-type').text(actionType);
  $('#debug-action-preview').val($('#action-input').val());
  renderPromptDiagram();
}

function renderPromptDiagram() {
  const $diag = $('#debug-prompt-diagram');
  if ($diag.length === 0 || $('#tab-debug').hasClass('d-none')) return;

  const actionType = $('#action-type').val() || 'do';
  const actionText = $('#action-input').val().trim() || '(type an action to preview)';
  const playerLine = buildPlayerActionText(actionText, actionType);

  function textStats(text) {
    const chars  = text.length;
    const words  = text.trim() ? text.trim().split(/\s+/).length : 0;
    const tokens = Math.round(chars / 4);
    return { chars, words, tokens };
  }
  function addStats(a, b) {
    return { chars: a.chars + b.chars, words: a.words + b.words, tokens: a.tokens + b.tokens };
  }
  const zeroStats = { chars: 0, words: 0, tokens: 0 };
  function fmtStats(s) {
    return `${s.words.toLocaleString()} words &nbsp;·&nbsp; ${s.chars.toLocaleString()} chars &nbsp;·&nbsp; ~${s.tokens.toLocaleString()} tokens`;
  }

  const sysSources = [
    { label: 'Global System Prompt',          color: '#4a9eff', value: $('#debug-global-prompt').val() },
    { label: 'Scenario Prompt',               color: '#51cf66', value: $('#debug-scenario-prompt').val() },
    { label: 'Custom Extension',              color: '#22d3ee', value: state.customPrompt || '' },
    { label: 'Character Context',             color: '#fbbf24', value: buildCharacterContext() },
    { label: 'World Cards',                   color: '#f97316', value: buildCardsContext(playerLine) },
    { label: 'Story Summary',                 color: '#a78bfa', value: state.storySummary ? `Story so far: ${state.storySummary}` : '' },
    { label: `Action Prompt (${actionType})`, color: '#f87171', value: ['do','say','story'].includes(actionType) ? ($('#debug-action-' + actionType).val() || '') : '' },
  ];

  function srcBlock(s) {
    const empty = !s.value.trim();
    const st = empty ? null : textStats(s.value);
    return `<div class="debug-src-block${empty ? ' debug-src-empty' : ''}" style="border-left-color:${s.color}">` +
      `<span class="debug-src-label" style="color:${s.color}">${s.label}</span>` +
      (st ? `<span class="debug-src-stats">${fmtStats(st)}</span>` : '') +
      `<pre class="debug-src-pre">${escHtml(empty ? '(empty)' : s.value)}</pre>` +
      `</div>`;
  }

  const sysTotal = sysSources.reduce((acc, s) => s.value.trim() ? addStats(acc, textStats(s.value)) : acc, zeroStats);

  let html = `<div class="debug-pipeline">`;
  html += `<div class="debug-pipeline-hdr">⬡ System Message Assembly` +
    `<span class="debug-hdr-stats">${fmtStats(sysTotal)}</span></div>`;
  html += sysSources.map(srcBlock).join('');

  const history = state.messages.slice();
  const histDisplay = history.length > 0 && history[0].role === 'assistant' ? history.slice(1) : history;
  const histTotal = histDisplay.reduce((acc, m) => addStats(acc, textStats(m.content)), zeroStats);
  html += `<div class="debug-pipeline-sep">↕ Message History (${histDisplay.length} turn${histDisplay.length !== 1 ? 's' : ''})` +
    (histDisplay.length ? `<span class="debug-sep-stats">${fmtStats(histTotal)}</span>` : '') +
    `</div>`;

  if (histDisplay.length === 0) {
    html += `<div class="debug-src-block debug-src-empty" style="border-left-color:#6b7280">` +
      `<span class="debug-src-label" style="color:#6b7280">history</span>` +
      `<pre class="debug-src-pre">(no turns yet)</pre></div>`;
  } else {
    for (const msg of histDisplay) {
      const roleColor = msg.role === 'user' ? '#5aba6e' : '#a0a0c0';
      const st = textStats(msg.content);
      html += `<div class="debug-src-block" style="border-left-color:${roleColor}">` +
        `<span class="debug-src-label" style="color:${roleColor}">[${msg.role}]</span>` +
        `<span class="debug-src-stats">${fmtStats(st)}</span>` +
        `<pre class="debug-src-pre">${escHtml(msg.content)}</pre></div>`;
    }
  }

  const actionStats = textStats(playerLine);
  html += `<div class="debug-pipeline-sep">↓ Current Action` +
    `<span class="debug-sep-stats">${fmtStats(actionStats)}</span></div>`;
  html += `<div class="debug-src-block" style="border-left-color:#10b981">` +
    `<span class="debug-src-label" style="color:#10b981">player → user message</span>` +
    `<span class="debug-src-stats">${fmtStats(actionStats)}</span>` +
    `<pre class="debug-src-pre">${escHtml(playerLine)}</pre></div>`;

  const grandTotal = addStats(addStats(sysTotal, histTotal), actionStats);
  html += `<div class="debug-pipeline-total">` +
    `<span class="debug-total-label">Total next prompt</span>` +
    `<span class="debug-total-stats">${fmtStats(grandTotal)}</span>` +
    `</div>`;

  html += `</div>`;
  $diag.html(html);
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function buildCardsContext(playerLine = '') {
  const active = (state.cards || []).filter(c => c.active);
  if (!active.length) return '';

  // Search text: current player action + last 2 messages
  const searchText = [
    playerLine,
    ...state.messages.slice(-2).map(m => m.content),
  ].join(' ').toLowerCase();

  const relevant = active.filter(c => {
    if (!c.triggers) return true; // no triggers = pinned, always included
    const keywords = c.triggers.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (!keywords.length) return true;
    return keywords.some(k => searchText.includes(k));
  });

  if (!relevant.length) return '';
  const lines = relevant.map(c =>
    `[${c.type.toUpperCase()}] ${c.name}${c.description ? ': ' + c.description : ''}`
  );
  return 'World context:\n' + lines.join('\n');
}

// ── Character sidebar ─────────────────────────────────────────────────────────
function renderCharSidebar() {
  const c     = state.character;
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
    showToast('Character saved.', 'success');
  }

  $('#char-save-btn').on('click', saveCharacter);
}

// ── World Cards ───────────────────────────────────────────────────────────────
function renderWorldCards() {
  const $list = $('#world-cards-list').empty();
  if (!state.cards.length) {
    $list.html('<div class="text-secondary small text-center py-2">No cards yet.</div>');
    return;
  }
  state.cards.forEach(card => $list.append(buildCardEl(card)));
}

// ── Model switcher ────────────────────────────────────────────────────────────
async function renderModelCards() {
  const $list = $('#model-cards-list');
  $list.html('<div class="text-secondary small text-center py-3">Loading…</div>');

  let installedNames = [];
  try {
    const data = await getModels();
    installedNames = (data.models || []).map(m => m.name);
  } catch {
    $list.html('<div class="text-danger small text-center py-3">Could not load models.</div>');
    return;
  }

  const available = (state.config.availableModels || []).filter(m =>
    installedNames.some(n => n === m.id || n.startsWith(m.id + ':'))
  );

  if (!available.length) {
    $list.html('<div class="text-secondary small text-center py-3">No installed models found.</div>');
    return;
  }

  const active = available.find(m => m.id === state.modelId) || available[0];

  const $trigger = $(`
    <button class="btn btn-outline-secondary dropdown-toggle w-100 text-start d-flex align-items-center gap-2"
            type="button" data-bs-toggle="dropdown" aria-expanded="false">
      <span class="flex-grow-1 fw-semibold text-truncate">${active.name}</span>
      ${active.parameters ? `<span class="badge bg-secondary">${active.parameters}</span>` : ''}
      ${active.nsfw ? '<span class="badge bg-danger">18+</span>' : ''}
    </button>
  `);

  const $menu = $('<ul class="dropdown-menu w-100 shadow py-1"></ul>');

  available.forEach(m => {
    const isActive = m.id === state.modelId;
    const $item = $(`
      <li>
        <button class="dropdown-item model-dropdown-item py-2 px-3${isActive ? ' active' : ''}" type="button">
          <div class="d-flex align-items-center gap-1 mb-1">
            ${isActive ? '<span class="model-check">✓</span>' : '<span class="model-check"></span>'}
            <span class="fw-semibold">${m.name}</span>
            ${m.parameters ? `<span class="badge bg-secondary ms-1">${m.parameters}</span>` : ''}
            ${m.nsfw ? '<span class="badge bg-danger ms-1">18+</span>' : ''}
          </div>
          ${m.description ? `<div class="model-item-desc">${m.description}</div>` : ''}
        </button>
      </li>
    `);

    if (!isActive) {
      $item.find('button').on('click', async () => {
        $trigger.prop('disabled', true);
        try {
          await putGame(state.gameId, { model_id: m.id });
          state.modelId = m.id;
          localStorage.setItem('dungeon_last_model', m.id);
          showToast(`Switched to ${m.name}.`, 'success');
          renderModelCards();
        } catch {
          $trigger.prop('disabled', false);
          showToast('Failed to switch model.', 'danger');
        }
      });
    }

    $menu.append($item);
  });

  $list.empty().append(
    $('<div class="dropdown"></div>').append($trigger, $menu)
  );
}

function buildCardEl(card) {
  const $tmpl = renderTemplate('tmpl-world-card');
  const $el   = $tmpl.find('.card');

  $el.attr('data-card-id', card.id);
  $el.find('.card-active-toggle').prop('checked', !!card.active);
  $el.find('.card-type-sel').val(card.type || 'location');
  $el.find('.card-name-input').val(card.name || '');
  $el.find('.card-desc-input').val(card.description || '');
  $el.find('.card-triggers-input').val(card.triggers || '');

  async function saveCard() {
    const idx = state.cards.findIndex(c => c.id === card.id);
    const updated = {
      ...card,
      type:        $el.find('.card-type-sel').val(),
      name:        $el.find('.card-name-input').val().trim(),
      description: $el.find('.card-desc-input').val().trim(),
      triggers:    $el.find('.card-triggers-input').val().trim(),
      active:      $el.find('.card-active-toggle').is(':checked') ? 1 : 0,
    };
    try {
      await putCard(state.gameId, card.id, updated);
      if (idx >= 0) state.cards[idx] = updated;
      showToast('Card saved.', 'success');
    } catch {
      showToast('Failed to save card.', 'danger');
    }
  }

  $el.find('.card-active-toggle, .card-type-sel').on('change', saveCard);
  $el.find('.card-name-input, .card-desc-input, .card-triggers-input').on('blur', saveCard);
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
  // Options sidebar toggle
  $('#options-btn').on('click', () => {
    state.sidebarOpen = !state.sidebarOpen;
    const display = state.sidebarOpen ? 'flex' : 'none';
    $('#char-sheet').css('display', display);
    $('#sidebar-resizer').css('display', display);
  });

  // Sidebar tabs
  $('#sidebar-tabs').on('click', '[data-tab]', function () {
    const tab = $(this).data('tab');
    $('#sidebar-tabs .nav-link').removeClass('active');
    $(this).addClass('active');
    $('#tab-char, #tab-world, #tab-model, #tab-scenario, #tab-plot, #tab-debug').addClass('d-none');
    $(`#tab-${tab}`).removeClass('d-none');
    if (tab === 'world') renderWorldCards();
    if (tab === 'model') renderModelCards();
    if (tab === 'debug') refreshDebugTab();
  });

  // Model tab: output token range
  $('#num-predict-range').on('input', function () {
    const v = +$(this).val();
    state.numPredict = v;
    $('#num-predict-val').text(v);
    $('#num-predict-reset').toggleClass('d-none', v === 150);
    putGame(state.gameId, { num_predict: v }).catch(() => {});
  });
  $('#num-predict-reset').on('click', () => {
    state.numPredict = 200;
    $('#num-predict-range').val(200);
    $('#num-predict-val').text(200);
    $('#num-predict-reset').addClass('d-none');
    putGame(state.gameId, { num_predict: 200 }).catch(() => {});
  });

  // Scenario tab: scenario-specific DM prompt + display metadata
  $('#scenario-save-btn').on('click', async () => {
    const text = $('#scenario-prompt-edit').val();
    const name = $('#scenario-name-edit').val().trim();
    const icon = $('#scenario-icon-edit').val().trim();
    const desc = $('#scenario-desc-edit').val().trim();
    try {
      await putGame(state.gameId, {
        scenario_prompt:      text,
        scenario_name:        name,
        scenario_icon:        icon,
        scenario_description: desc,
      });
      state.scenarioPrompt = text;
      state.scenario.name  = name || state.scenario.name;
      state.scenario.icon  = icon || state.scenario.icon;
      state.scenario.description = desc;
      $('#scenario-title').text(`${state.scenario.icon} ${state.scenario.name}`.trim());
      showToast('Scenario saved.', 'success');
    } catch {
      showToast('Failed to save scenario.', 'danger');
    }
  });

  // Scenario tab: export
  $('#scenario-export-btn').on('click', async () => {
    try {
      const scenario = await getGameScenario(state.gameId);
      triggerDownload(JSON.stringify(scenario, null, 2), `${scenario.id || state.gameId}.json`);
      showToast('Scenario exported.', 'success');
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'danger');
    }
  });

  // Plot tab: system prompt + custom prompt
  $('#plot-save-btn').on('click', async () => {
    const sysText    = $('#plot-prompt-edit').val();
    const customText = $('#custom-prompt-edit').val();
    try {
      await putGame(state.gameId, { system_prompt: sysText, custom_prompt: customText });
      state.systemPrompt = sysText;
      state.customPrompt = customText;
      showToast('Prompts saved.', 'success');
    } catch {
      showToast('Failed to save prompts.', 'danger');
    }
  });

  // Add world card
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

  // Action buttons
  $('#send-btn').on('click', sendAction);
  $('#undo-btn').on('click', undo);
  $('#retry-btn').on('click', retry);
  $('#continue-btn').on('click', continueStory);
  // Enter to send
  $('#action-input').on('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAction(); }
  });

  // Debug tab — live prompt editing syncs to state
  $('#debug-global-prompt').on('input', function () {
    state.systemPrompt = $(this).val(); updateDebugCombined(); buildNextPromptPreview();
  });
  $('#debug-scenario-prompt').on('input', function () {
    state.scenarioPrompt = $(this).val(); updateDebugCombined(); buildNextPromptPreview();
  });
  $('#debug-action-do').on('input', function () {
    state.config.actionPrompts.do = $(this).val(); updateDebugCombined(); buildNextPromptPreview();
  });
  $('#debug-action-say').on('input', function () {
    state.config.actionPrompts.say = $(this).val(); updateDebugCombined(); buildNextPromptPreview();
  });
  $('#debug-action-story').on('input', function () {
    state.config.actionPrompts.story = $(this).val(); updateDebugCombined(); buildNextPromptPreview();
  });
  $('#action-type, #action-input').on('change input', function () {
    if (!$('#tab-debug').hasClass('d-none')) buildNextPromptPreview();
  });

  // Resizable sidebar
  let resizing = false, startX = 0, startW = 0;
  $('#sidebar-resizer').on('mousedown', function (e) {
    resizing = true;
    startX   = e.clientX;
    startW   = $('#char-sheet').width();
    $('#sidebar-resizer').addClass('dragging');
    e.preventDefault();
  });
  $(document).on('mousemove', function (e) {
    if (!resizing) return;
    const newW = Math.max(160, startW - (e.clientX - startX));
    $('#char-sheet').css('width', newW + 'px');
  });
  $(document).on('mouseup', function () {
    if (!resizing) return;
    resizing = false;
    $('#sidebar-resizer').removeClass('dragging');
    localStorage.setItem('sidebar_width', $('#char-sheet').width());
  });
}
