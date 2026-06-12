// StoryTelling — game screen logic

import {
  loadConfig, initApi, showToast, pollHealth, parseDate, renderTemplate, triggerDownload,
  applyMacros,
} from './utils.js';
import {
  getGame, getCharacter, getCards, putCharacter, putGame,
  createCard, putCard, deleteCard,
  streamTurn, putTurn, undoTurn, getStats, summarizeGame, analyzePlayerIntent,
  describeScene, getGameScenario, getModels,
} from './api.js';

// ── Active segment edit cleanup handle ────────────────────────────────────────
let _cancelSegEdit = null;

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  config:         null,
  gameId:         null,
  modelId:        null,
  scenario:       null,
  systemPrompt:   '',   // merged global narrator prompt (games.system_prompt)
  // Character Card V2 fields (scenarios table)
  cardDescription: '',  // data.description — UI-only scenario description, NOT in the prompt
  cardPersonality: '',  // data.personality
  cardScenario:    '',  // data.scenario
  cardSystemPrompt: '', // data.system_prompt — appended after the global system prompt
  postHistoryInstructions: '', // data.post_history_instructions — injected after history
  mesExample:      '',  // data.mes_example
  cardFirstMes:    '',  // data.first_mes — raw (macros applied at display time)
  cardAlternateGreetings: [], // data.alternate_greetings
  cardTags:        [],  // data.tags
  cardCreator:     '',
  cardCharacterVersion: '',
  character:      { name: '', description: '', class: '', stats: null, notes: '' },
  cards:          [],
  messages:       [],
  segments:       [],
  lastAction:     null,
  generating:     false,
  summarizing:    false,
  summarizeEnabled: true,
  pendingSummary: [],   // trimmed messages waiting to be summarized in a batch
  storySummary:   '',
  playerIntent:   '',
  playerIntentEnabled: true,
  analyzingIntent: false,
  userMsgsSinceIntent: 0,
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
function parseJsonArray(text) {
  try {
    const v = typeof text === 'string' ? JSON.parse(text) : text;
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

async function loadGame(id) {
  const game = await getGame(id);

  state.gameId          = game.id;
  state.modelId         = game.model_id;
  state.systemPrompt    = game.system_prompt || '';
  state.cardDescription = game.card_description || '';
  state.cardPersonality = game.personality || '';
  state.cardScenario    = game.scenario || '';
  state.cardSystemPrompt = game.card_system_prompt || '';
  state.postHistoryInstructions = game.post_history_instructions || '';
  state.mesExample      = game.mes_example || '';
  state.cardFirstMes    = game.first_mes || '';
  state.cardAlternateGreetings = parseJsonArray(game.alternate_greetings);
  state.cardTags        = parseJsonArray(game.tags);
  state.cardCreator     = game.creator || '';
  state.cardCharacterVersion = game.character_version || '';
  state.storySummary    = game.story_summary || '';
  state.summarizeEnabled = game.summarize_enabled !== 0;
  state.pendingSummary  = [];
  state.playerIntent    = game.player_intent || '';
  state.playerIntentEnabled = game.player_intent_enabled !== 0;
  state.userMsgsSinceIntent = 0;
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
    description: game.creator_notes || '',
  };
  $('#scenario-title').text(`${state.scenario.icon} ${state.scenario.name}`.trim());
  renderScenarioTab();
  $('#story-text').empty();
  state.segments = [];

  const isFresh = (game.turns || []).length === 0;
  if (game.first_mes) {
    const opening = applyMacros(game.first_mes, macroContext());
    appendSegment(opening + '\n\n', isFresh ? 'narrative opening-fresh' : 'narrative', 'game', 'first_mes');
    state.messages.push({ role: 'assistant', content: opening });
  }
  renderOpeningPicker(isFresh && !!game.first_mes);

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
  $('#summarize-toggle').prop('checked', state.summarizeEnabled);
  $('#player-intent-toggle').prop('checked', state.playerIntentEnabled);
  $('#plot-prompt-edit').val(state.systemPrompt);

  // Restore sidebar width (default 500px set in HTML)
  const savedW = localStorage.getItem('sidebar_width');
  if (savedW) $('#char-sheet').css('width', parseInt(savedW) + 'px');

  $('#debug-panel').removeClass('d-none');
  $('#send-btn, #action-input, #continue-btn, #describe-btn').prop('disabled', false);
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
  clearFreshOpening();
  $('#send-btn, #undo-btn, #retry-btn, #continue-btn, #describe-btn').prop('disabled', true);

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
      state.userMsgsSinceIntent += 1;
      maybeAnalyzeIntent();
    }
    state.messages.push({ role: 'assistant', content: trimmed || response });
    const maxMsg = state.config.contextMaxMessages || 20;
    if (state.messages.length > maxMsg) {
      const overflow = state.messages.slice(0, state.messages.length - maxMsg);
      state.messages = state.messages.slice(-maxMsg);
      if (state.summarizeEnabled) {
        state.pendingSummary.push(...overflow);
        maybeSummarize();
      }
    }
    updateContextBar();
    if (!$('#tab-debug').hasClass('d-none')) refreshDebugTab();

  } catch (err) {
    streamSpan.text(`[Error: ${err.message}]\n`).addClass('text-danger').removeClass('streaming-cursor');
    showToast(`Generation error: ${err.message}`, 'danger');
  } finally {
    state.generating = false;
    $('#send-btn, #retry-btn, #undo-btn, #continue-btn, #describe-btn').prop('disabled', false);
    $('#action-input').trigger('focus');
  }
}

// ── Summarization batching ────────────────────────────────────────────────────
// Trimmed messages collect in state.pendingSummary; once at least
// config.summarizeAfterMessages have accumulated, one summarize call
// condenses the whole batch into the rolling story summary.
function maybeSummarize() {
  const threshold = state.config.summarizeAfterMessages || 6;
  if (state.summarizing || state.pendingSummary.length < threshold) return;

  const batch = state.pendingSummary;
  state.pendingSummary = [];
  state.summarizing = true;
  summarizeGame(state.gameId, {
    messages:         batch,
    existing_summary: state.storySummary,
  }).then(result => {
    state.storySummary = result.summary;
  }).catch(err => {
    console.warn('[summary] failed:', err);
    // Re-queue the batch so the next turn retries it
    state.pendingSummary = [...batch, ...state.pendingSummary];
  }).finally(() => {
    state.summarizing = false;
  });
}

// ── Scene description (for text-to-image models) ──────────────────────────────
// Sends the recent story context to the backend, which asks the model for a
// detailed visual snapshot (characters, clothing, poses, setting, lighting).
// The result is shown in a modal with a copy button — it never becomes part
// of the story, the message history, or the database.
async function describeCurrentScene() {
  if (state.generating || !state.gameId) return;
  const recent = state.messages.slice(-8);
  if (!recent.length) {
    showToast('Nothing to describe yet — play a turn first.', 'warning');
    return;
  }

  $('#describe-btn').prop('disabled', true);
  $('#describe-output').val('Generating description…');
  bootstrap.Modal.getOrCreateInstance('#describe-modal').show();

  try {
    // Character context without the name — the description must stay nameless.
    const c = state.character || {};
    const charVisual = [c.description, c.class ? `Class: ${c.class}` : '']
      .filter(Boolean).join(' — ');
    const result = await describeScene(state.gameId, {
      messages:  recent,
      character: charVisual ? `The protagonist: ${charVisual}` : '',
    });
    $('#describe-output').val(result.description || '(The model returned an empty description.)');
  } catch (err) {
    $('#describe-output').val(`Error: ${err.message}`);
  } finally {
    $('#describe-btn').prop('disabled', state.generating);
  }
}

// ── Player intent analysis ────────────────────────────────────────────────────
// Every config.playerIntentAfterMessages player inputs, the backend analyzes
// all inputs of this game (from the turns table) and returns a narrator
// instruction that is injected into the system content like the summary.
function maybeAnalyzeIntent() {
  const threshold = state.config.playerIntentAfterMessages || 5;
  if (!state.playerIntentEnabled || state.analyzingIntent) return;
  if (state.userMsgsSinceIntent < threshold) return;

  state.userMsgsSinceIntent = 0;
  state.analyzingIntent = true;
  analyzePlayerIntent(state.gameId).then(result => {
    state.playerIntent = result.player_intent || '';
  }).catch(err => {
    console.warn('[player intent] failed:', err);
  }).finally(() => {
    state.analyzingIntent = false;
  });
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
// Card V2 macro context: {{char}} = card name, {{user}} = player character.
function macroContext() {
  return {
    charName: state.scenario?.name || '',
    userName: state.character?.name || '',
  };
}

// Assembles the prompt per Character Card V2 semantics:
// global system prompt → scenario system prompt (card) → description →
// personality → scenario → protagonist → world cards → summary → intent →
// action prompt → example dialogue → story opening;
// post_history_instructions goes AFTER the chat history as the final
// system message.
function buildMessages(actionType, playerLine) {
  const mc           = macroContext();
  const charCtx      = buildCharacterContext();
  const actionPrompt = actionType === 'continue'
    ? ''
    : (state.config.actionPrompts?.[actionType] || '');
  const continueMsg = actionType === 'continue'
    ? (state.config.actionPrompts?.continue || 'Continue.') : null;
  const cardsCtx     = buildCardsContext(playerLine || '');

  let sysContent = [
    state.systemPrompt,
    state.cardSystemPrompt ? applyMacros(state.cardSystemPrompt, mc) : '',
    state.cardDescription ? applyMacros(state.cardDescription, mc) : '',
    state.cardPersonality ? applyMacros(`{{char}}'s personality: ${state.cardPersonality}`, mc) : '',
    state.cardScenario ? `Scenario: ${applyMacros(state.cardScenario, mc)}` : '',
    charCtx,
    applyMacros(cardsCtx, mc),
    state.storySummary ? `Story so far: ${state.storySummary}` : '',
    state.playerIntent,
    actionPrompt,
    state.mesExample ? `Example dialogue:\n${applyMacros(state.mesExample, mc)}` : '',
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

  if (state.postHistoryInstructions) {
    msgs.push({ role: 'system', content: applyMacros(state.postHistoryInstructions, mc) });
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

// ── Opening picker (fresh games only) ─────────────────────────────────────────
// Until the first turn is played, the opening text (first_mes) is highlighted,
// freely editable (click it), and can be swapped against alternate_greetings.
function renderOpeningPicker(show) {
  const $panel = $('#opening-picker');
  if (!$panel.length) return;
  if (!show) { $panel.addClass('d-none'); return; }

  const $sel = $('#opening-select').empty();
  $sel.append(new Option('Current opening', '-1'));
  state.cardAlternateGreetings.forEach((g, i) => {
    const preview = String(g).replace(/\s+/g, ' ').slice(0, 70);
    $sel.append(new Option(`Alternative ${i + 1} — ${preview}…`, String(i)));
  });
  $sel.val('-1').prop('disabled', state.cardAlternateGreetings.length === 0);
  $panel.removeClass('d-none');
}

// Swap first_mes with the chosen alternate greeting — nothing gets lost,
// the previous opening takes the alternate's place in the list.
async function swapOpening(altIndex) {
  const alts   = [...state.cardAlternateGreetings];
  const chosen = alts[altIndex];
  if (chosen == null) return;
  alts[altIndex] = state.cardFirstMes;
  try {
    await putGame(state.gameId, { first_mes: chosen, alternate_greetings: alts });
  } catch {
    showToast('Failed to save opening.', 'danger');
    return;
  }
  state.cardFirstMes = chosen;
  state.cardAlternateGreetings = alts;
  const opening = applyMacros(chosen, macroContext());
  state.segments[0] = { ...state.segments[0], text: opening + '\n\n' };
  state.messages[0] = { role: 'assistant', content: opening };
  rebuildStoryDisplay();
  renderOpeningPicker(true);
  renderScenarioTab();
  showToast('Opening swapped.', 'success');
}

// Called when the first action is sent — the game is no longer "fresh".
function clearFreshOpening() {
  $('#opening-picker').addClass('d-none');
  if (state.segments[0]?.cssClass?.includes('opening-fresh')) {
    state.segments[0].cssClass = 'narrative';
    $('#story-text span').first().removeClass('opening-fresh');
  }
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
          putGame(state.gameId, { first_mes: newText.trimEnd() })
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
  $('#debug-scenario-prompt').val(state.cardSystemPrompt || '');
  $('#debug-phi').val(state.postHistoryInstructions || '');
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
    state.cardDescription || '',
    state.cardPersonality ? `{{char}}'s personality: ${state.cardPersonality}` : '',
    state.cardScenario ? `Scenario: ${state.cardScenario}` : '',
    $('#debug-char-context').val(),
    state.playerIntent || '',
    ap[activeAction] || '',
  ].filter(s => s.trim());
  $('#debug-combined').val(parts.join('\n\n'));
}

function buildNextPromptPreview() {
  const actionText = $('#action-input').val().trim() || '(type an action to preview)';
  const actionType = $('#action-type').val() || 'do';
  const playerLine = buildPlayerActionText(actionText, actionType);

  const origSystem  = state.systemPrompt;
  const origCardSys = state.cardSystemPrompt;
  const origAp      = { ...state.config.actionPrompts };

  state.systemPrompt     = $('#debug-global-prompt').val();
  state.cardSystemPrompt = $('#debug-scenario-prompt').val();
  state.config.actionPrompts = {
    do:    $('#debug-action-do').val(),
    say:   $('#debug-action-say').val(),
    story: $('#debug-action-story').val(),
  };

  const messages = buildMessages(actionType, playerLine);

  state.systemPrompt     = origSystem;
  state.cardSystemPrompt = origCardSys;
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
    { label: 'Scenario System Prompt',        color: '#51cf66', value: $('#debug-scenario-prompt').val() },
    { label: 'Card Description',              color: '#a3e635', value: state.cardDescription || '' },
    { label: 'Personality',                   color: '#22d3ee', value: state.cardPersonality ? `{{char}}'s personality: ${state.cardPersonality}` : '' },
    { label: 'Scenario',                      color: '#2dd4bf', value: state.cardScenario ? `Scenario: ${state.cardScenario}` : '' },
    { label: 'Character Context',             color: '#fbbf24', value: buildCharacterContext() },
    { label: 'World Cards',                   color: '#f97316', value: buildCardsContext(playerLine) },
    { label: 'Story Summary',                 color: '#a78bfa', value: state.storySummary ? `Story so far: ${state.storySummary}` : '' },
    { label: 'Player Intent',                 color: '#ec4899', value: state.playerIntent || '' },
    { label: `Action Prompt (${actionType})`, color: '#f87171', value: ['do','say','story'].includes(actionType) ? ($('#debug-action-' + actionType).val() || '') : '' },
    { label: 'Example Dialogue',              color: '#94a3b8', value: state.mesExample ? `Example dialogue:\n${state.mesExample}` : '' },
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

  // Post-history instructions — always shown as the last prompt block
  const phi      = state.postHistoryInstructions || '';
  const phiStats = phi ? textStats(phi) : zeroStats;
  html += `<div class="debug-pipeline-sep">↓ Post-History Instructions` +
    (phi ? `<span class="debug-sep-stats">${fmtStats(phiStats)}</span>` : '') +
    `</div>`;
  html += `<div class="debug-src-block${phi ? '' : ' debug-src-empty'}" style="border-left-color:#e879f9">` +
    `<span class="debug-src-label" style="color:#e879f9">card → system message (after history)</span>` +
    (phi ? `<span class="debug-src-stats">${fmtStats(phiStats)}</span>` : '') +
    `<pre class="debug-src-pre">${escHtml(phi || '(empty)')}</pre></div>`;

  const grandTotal = addStats(addStats(addStats(sysTotal, histTotal), actionStats), phiStats);
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

// ── Scenario tab (full Character Card V2 editor) ──────────────────────────────
function renderScenarioTab() {
  $('#scenario-icon-edit').val(state.scenario.icon);
  $('#scenario-name-edit').val(state.scenario.name);
  $('#scenario-desc-edit').val(state.scenario.description);          // creator_notes
  $('#scenario-description-edit').val(state.cardDescription);
  $('#scenario-personality-edit').val(state.cardPersonality);
  $('#scenario-scenario-edit').val(state.cardScenario);
  $('#scenario-first-mes-edit').val(state.cardFirstMes);
  $('#scenario-mes-example-edit').val(state.mesExample);
  $('#scenario-prompt-edit').val(state.cardSystemPrompt);
  $('#scenario-phi-edit').val(state.postHistoryInstructions);
  $('#scenario-tags-edit').val(state.cardTags.join(', '));
  $('#scenario-creator-edit').val(state.cardCreator);
  $('#scenario-version-edit').val(state.cardCharacterVersion);

  const $list = $('#alt-greetings-list').empty();
  state.cardAlternateGreetings.forEach(g => $list.append(buildAltGreetingEl(g)));
}

function buildAltGreetingEl(text) {
  const $el = $(`
    <div class="d-flex gap-1 mb-2 alt-greeting-item">
      <textarea class="form-control form-control-sm alt-greeting-text" rows="3"></textarea>
      <button class="btn btn-sm btn-outline-danger align-self-start alt-greeting-del" title="Remove">✕</button>
    </div>
  `);
  $el.find('.alt-greeting-text').val(text);
  $el.find('.alt-greeting-del').on('click', function () { $(this).closest('.alt-greeting-item').remove(); });
  return $el;
}

function collectAltGreetings() {
  return $('#alt-greetings-list .alt-greeting-text').map(function () {
    return $(this).val().trim();
  }).get().filter(Boolean);
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

  // Model tab: player intent toggle
  $('#player-intent-toggle').on('change', function () {
    const enabled = $(this).is(':checked');
    state.playerIntentEnabled = enabled;
    if (enabled) state.userMsgsSinceIntent = 0;
    putGame(state.gameId, { player_intent_enabled: enabled ? 1 : 0 })
      .then(() => showToast(`Player intent analysis ${enabled ? 'enabled' : 'disabled'}.`, 'success'))
      .catch(() => {
        showToast('Failed to save player intent setting.', 'danger');
        state.playerIntentEnabled = !enabled;
        $(this).prop('checked', !enabled);
      });
  });

  // Model tab: summarization toggle
  $('#summarize-toggle').on('change', function () {
    const enabled = $(this).is(':checked');
    state.summarizeEnabled = enabled;
    if (!enabled) state.pendingSummary = [];
    putGame(state.gameId, { summarize_enabled: enabled ? 1 : 0 })
      .then(() => showToast(`Summarization ${enabled ? 'enabled' : 'disabled'}.`, 'success'))
      .catch(() => {
        showToast('Failed to save summarization setting.', 'danger');
        state.summarizeEnabled = !enabled;
        $(this).prop('checked', !enabled);
      });
  });

  // Scenario tab: full Character Card V2 editor
  $('#scenario-save-btn').on('click', async () => {
    const payload = {
      scenario_name:             $('#scenario-name-edit').val().trim(),
      scenario_icon:             $('#scenario-icon-edit').val().trim(),
      creator_notes:             $('#scenario-desc-edit').val().trim(),
      card_description:          $('#scenario-description-edit').val(),
      personality:               $('#scenario-personality-edit').val(),
      scenario:                  $('#scenario-scenario-edit').val(),
      first_mes:                 $('#scenario-first-mes-edit').val(),
      mes_example:               $('#scenario-mes-example-edit').val(),
      card_system_prompt:        $('#scenario-prompt-edit').val(),
      post_history_instructions: $('#scenario-phi-edit').val(),
      alternate_greetings:       collectAltGreetings(),
      tags:                      $('#scenario-tags-edit').val().split(',').map(t => t.trim()).filter(Boolean),
      creator:                   $('#scenario-creator-edit').val().trim(),
      character_version:         $('#scenario-version-edit').val().trim(),
    };
    try {
      await putGame(state.gameId, payload);
      const firstMesChanged = payload.first_mes !== state.cardFirstMes;
      state.scenario.name  = payload.scenario_name || state.scenario.name;
      state.scenario.icon  = payload.scenario_icon || state.scenario.icon;
      state.scenario.description = payload.creator_notes;
      state.cardDescription = payload.card_description;
      state.cardPersonality = payload.personality;
      state.cardScenario    = payload.scenario;
      state.cardFirstMes    = payload.first_mes;
      state.mesExample      = payload.mes_example;
      state.cardSystemPrompt = payload.card_system_prompt;
      state.postHistoryInstructions = payload.post_history_instructions;
      state.cardAlternateGreetings = payload.alternate_greetings;
      state.cardTags        = payload.tags;
      state.cardCreator     = payload.creator;
      state.cardCharacterVersion = payload.character_version;
      $('#scenario-title').text(`${state.scenario.icon} ${state.scenario.name}`.trim());
      // Fresh game: reflect an edited first_mes in the story view + picker
      if (firstMesChanged && state.segments[0]?.field === 'first_mes'
          && state.segments[0]?.cssClass?.includes('opening-fresh')) {
        const opening = applyMacros(payload.first_mes, macroContext());
        state.segments[0] = { ...state.segments[0], text: opening + '\n\n' };
        state.messages[0] = { role: 'assistant', content: opening };
        rebuildStoryDisplay();
      }
      renderOpeningPicker(!$('#opening-picker').hasClass('d-none'));
      showToast('Scenario saved.', 'success');
    } catch {
      showToast('Failed to save scenario.', 'danger');
    }
  });

  // Scenario tab: add an alternate greeting
  $('#alt-greeting-add').on('click', () => {
    $('#alt-greetings-list').append(buildAltGreetingEl(''));
    $('#alt-greetings-list .alt-greeting-text').last().trigger('focus');
  });

  // Fresh-game opening: swap in an alternate greeting
  $('#opening-select').on('change', function () {
    const idx = parseInt($(this).val(), 10);
    if (idx >= 0) swapOpening(idx);
  });

  // Scenario tab: export as Character Card V2 JSON
  $('#scenario-export-btn').on('click', async () => {
    try {
      const card = await getGameScenario(state.gameId);
      triggerDownload(JSON.stringify(card, null, 2), `${state.scenario?.id || 'card-' + state.gameId}.json`);
      showToast('Scenario exported.', 'success');
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'danger');
    }
  });

  // Plot tab: merged global system prompt
  $('#plot-save-btn').on('click', async () => {
    const sysText = $('#plot-prompt-edit').val();
    try {
      await putGame(state.gameId, { system_prompt: sysText });
      state.systemPrompt = sysText;
      showToast('Prompt saved.', 'success');
    } catch {
      showToast('Failed to save prompt.', 'danger');
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
  $('#describe-btn').on('click', describeCurrentScene);
  $('#describe-copy-btn').on('click', async () => {
    const text = $('#describe-output').val();
    try {
      await navigator.clipboard.writeText(text);
      showToast('Description copied.', 'success');
    } catch {
      $('#describe-output').trigger('select');
      showToast('Copy failed — text selected, press Ctrl+C.', 'warning');
    }
  });
  // Enter to send
  $('#action-input').on('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAction(); }
  });

  // Debug tab — live prompt editing syncs to state
  $('#debug-global-prompt').on('input', function () {
    state.systemPrompt = $(this).val(); updateDebugCombined(); buildNextPromptPreview();
  });
  $('#debug-scenario-prompt').on('input', function () {
    state.cardSystemPrompt = $(this).val(); updateDebugCombined(); buildNextPromptPreview();
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
