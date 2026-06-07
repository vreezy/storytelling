// StoryTelling — frontend logic (Ollama backend, no in-browser inference)

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  config:      null,   // dungeon-config.json
  gameId:      null,   // active game DB id
  modelId:     null,   // selected Ollama model id
  scenario:    null,   // scenario object from config
  systemPrompt:'',     // resolved system prompt for this game
  character:   { name: '', description: '', class: '', stats: null, notes: '' },
  cards:       [],     // world_cards rows
  messages:    [],     // [{role, content}] — rolling context window (no system msg)
  segments:    [],     // [{text, cssClass}] — story display rebuild
  lastAction:  null,   // {text, type} for retry
  generating:  false,
  healthPollId:null,
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
$(async function () {
  try {
    state.config = await $.getJSON('./dungeon-config.json');
  } catch {
    showToast('Failed to load dungeon-config.json.', 'danger');
    return;
  }

  buildScenarioGrid();
  bindEvents();
  pollHealth();
  await refreshInstalledModels();
  await refreshGameList();

  const hashId = parseInt(location.hash.replace('#game=', ''));
  if (hashId) await loadGame(hashId);
});

// ── Health polling ────────────────────────────────────────────────────────────
function pollHealth() {
  checkHealth();
  state.healthPollId = setInterval(checkHealth, 5000);
}

async function checkHealth() {
  const url = `${state.config.backendUrl}/api/health`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    const ok = data.ollama === 'ok' && data.db === 'ok';
    setHealthBadge(ok, data.ollama === 'ok' ? (data.db === 'ok' ? 'online' : 'DB error') : 'Ollama offline');
    if (ok) {
      $('#action-input').prop('disabled', state.gameId === null || state.generating);
    } else {
      $('#action-input, #send-btn').prop('disabled', true);
    }
  } catch {
    setHealthBadge(false, 'backend offline');
    $('#action-input, #send-btn').prop('disabled', true);
  }
}

function setHealthBadge(ok, label) {
  const cls  = ok ? 'bg-success' : 'bg-danger';
  const text = `⬤ ${label}`;
  $('#health-badge, #health-badge-game').text(text).removeClass('bg-secondary bg-success bg-danger').addClass(cls);
}

// ── Installed models ──────────────────────────────────────────────────────────
async function refreshInstalledModels() {
  try {
    const r    = await fetch(`${state.config.backendUrl}/api/models`);
    const data = await r.json();
    const installed = (data.models || []).map(m => m.name);

    const $sel = $('#model-select').empty();
    const cfg  = state.config.availableModels || [];
    const present = cfg.filter(m => installed.some(n => n === m.id || n.startsWith(m.id + ':')));

    if (present.length === 0) {
      $sel.append(new Option('— No models installed — open Models to download —', ''));
    } else {
      $sel.append(new Option('— Select a model —', ''));
      present.forEach(m => {
        const label = m.nsfw ? `🔞 ${m.name}` : m.name;
        $sel.append(new Option(label, m.id));
      });
      const lastModel = localStorage.getItem('dungeon_last_model');
      if (lastModel && present.some(m => m.id === lastModel)) {
        $sel.val(lastModel);
        state.modelId = lastModel;
      }
    }
    updateStartBtn();
    return installed;
  } catch {
    return [];
  }
}

// ── Models modal ──────────────────────────────────────────────────────────────
async function openModelsModal() {
  const $body = $('#models-table-body').html(
    '<tr><td colspan="4" class="text-center text-secondary py-3">Loading…</td></tr>'
  );

  let installed = [];
  try {
    const r    = await fetch(`${state.config.backendUrl}/api/models`);
    const data = await r.json();
    installed  = (data.models || []).map(m => m.name);
  } catch { /* offline */ }

  $body.empty();
  (state.config.availableModels || []).forEach(m => {
    const isInstalled = installed.some(n => n === m.id || n.startsWith(m.id + ':'));
    const sizeStr = m.sizeMb >= 1000 ? `${(m.sizeMb / 1000).toFixed(1)} GB` : `${m.sizeMb} MB`;
    const $row = $(`
      <tr data-model-id="${m.id}">
        <td><span class="fw-semibold">${m.name}</span><br>
            <small class="text-secondary font-monospace">${m.id}</small></td>
        <td class="text-end align-middle">${sizeStr}</td>
        <td class="text-center align-middle">${m.nsfw ? '<span class="badge bg-danger">18+</span>' : ''}</td>
        <td class="text-center align-middle model-action-cell"></td>
      </tr>
    `);
    renderModelRowAction($row, m.id, isInstalled);
    $body.append($row);
  });
}

function renderModelRowAction($row, modelId, isInstalled) {
  const $cell = $row.find('.model-action-cell').empty();
  if (isInstalled) {
    $cell.html(`
      <span class="badge bg-success me-2">✓ Installed</span>
      <button class="btn btn-sm btn-outline-danger delete-model-btn">Delete</button>
    `);
    $cell.find('.delete-model-btn').on('click', async function () {
      if (!confirm(`Delete model "${modelId}" from Ollama?`)) return;
      $(this).prop('disabled', true).text('Deleting…');
      try {
        await fetch(`${state.config.backendUrl}/api/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
        renderModelRowAction($row, modelId, false);
        await refreshInstalledModels();
      } catch (e) {
        showToast(`Delete failed: ${e.message}`, 'danger');
        $(this).prop('disabled', false).text('Delete');
      }
    });
  } else {
    const $progress = $('<div class="d-none"><progress class="w-100" value="0" max="100"></progress><small class="text-secondary pull-status"></small></div>');
    const $btn      = $('<button class="btn btn-sm btn-outline-primary">Download</button>');
    $cell.append($btn).append($progress);
    $btn.on('click', async function () {
      $btn.prop('disabled', true).text('Starting…');
      $progress.removeClass('d-none');
      try {
        await pullModel(modelId, $progress.find('progress')[0], $progress.find('.pull-status'));
        renderModelRowAction($row, modelId, true);
        await refreshInstalledModels();
      } catch (e) {
        showToast(`Download failed: ${e.message}`, 'danger');
        $btn.prop('disabled', false).text('Download');
        $progress.addClass('d-none');
      }
    });
  }
}

async function pullModel(modelId, progressEl, $statusEl) {
  const r = await fetch(`${state.config.backendUrl}/api/models/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: modelId }),
  });
  if (!r.ok) {
    throw new Error(`Backend error: ${r.status}`);
  }
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
      try {
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        $statusEl.text(msg.status || '');
        if (msg.total && msg.completed) {
          progressEl.max   = msg.total;
          progressEl.value = msg.completed;
        }
        if (msg.status === 'success') success = true;
      } catch (e) {
        throw new Error(e.message || 'Pull failed');
      }
    }
  }
  if (!success) throw new Error('Pull did not complete successfully');
  $statusEl.text('Done ✓');
}

// ── Game list ─────────────────────────────────────────────────────────────────
async function refreshGameList() {
  try {
    const r     = await fetch(`${state.config.backendUrl}/api/games`);
    const games = await r.json();
    const $list = $('#load-game-list').empty();

    if (games.length === 0) {
      $list.html('<div class="text-center text-secondary py-4">No saved games yet.</div>');
      return;
    }

    const $table = $(`
      <table class="table table-dark table-hover mb-0">
        <thead><tr>
          <th>Title</th><th>Scenario</th><th>Model</th>
          <th class="text-end">Last played</th>
          <th></th>
        </tr></thead>
        <tbody></tbody>
      </table>
    `);
    const $tbody = $table.find('tbody');

    games.forEach(g => {
      const sc        = (state.config.scenarios || []).find(s => s.id === g.scenario_id) || {};
      const icon      = sc.icon || '📖';
      const lastPlayed= new Date(g.last_played_at + 'Z').toLocaleString();
      const modelShort= (g.model_id || '').split(':')[0].split('/').pop();

      const $row = $(`
        <tr style="cursor:pointer" data-game-id="${g.id}">
          <td><strong>${$('<span>').text(g.title).html()}</strong></td>
          <td>${icon} ${sc.name || g.scenario_id || '—'}</td>
          <td><small class="text-secondary">${modelShort}</small></td>
          <td class="text-end"><small class="text-secondary">${lastPlayed}</small></td>
          <td><button class="btn btn-sm btn-outline-danger delete-game-btn" data-game-id="${g.id}">✕</button></td>
        </tr>
      `);

      $row.on('click', function (e) {
        if ($(e.target).hasClass('delete-game-btn')) return;
        bootstrap.Modal.getInstance(document.getElementById('load-modal'))?.hide();
        loadGame(g.id);
      });

      $row.find('.delete-game-btn').on('click', async function (e) {
        e.stopPropagation();
        if (!confirm(`Delete game "${g.title}"?`)) return;
        await fetch(`${state.config.backendUrl}/api/games/${g.id}`, { method: 'DELETE' });
        if (state.gameId === g.id) resetGame();
        await refreshGameList();
      });

      $tbody.append($row);
    });
    $list.append($table);
  } catch (e) {
    $('#load-game-list').html(`<div class="text-center text-danger py-4">Error: ${e.message}</div>`);
  }
}

// ── Load game from DB ─────────────────────────────────────────────────────────
async function loadGame(id) {
  try {
    const r    = await fetch(`${state.config.backendUrl}/api/games/${id}`);
    const game = await r.json();

    state.gameId      = game.id;
    state.modelId     = game.model_id;
    state.systemPrompt= game.system_prompt || '';
    state.character   = { name: '', description: '', class: '', stats: null, notes: '' };
    state.messages    = [];
    state.segments    = [];
    state.cards       = [];
    state.lastAction  = null;

    // Load character from DB
    try {
      const cr = await fetch(`${state.config.backendUrl}/api/games/${id}/character`);
      const ch = await cr.json();
      if (ch.name) state.character = { ...ch, stats: ch.stats ? JSON.parse(ch.stats) : null };
    } catch { /* no character yet */ }

    // Load world cards
    try {
      const wr = await fetch(`${state.config.backendUrl}/api/games/${id}/cards`);
      state.cards = await wr.json();
    } catch { state.cards = []; }

    const sc = (state.config.scenarios || []).find(s => s.id === game.scenario_id) || {};
    state.scenario = sc;
    $('#scenario-title').text(`${sc.icon || ''} ${sc.name || game.title}`);
    $('#story-text').empty();
    state.segments = [];

    // Reconstruct display and messages from turns
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

    // Truncate to context window
    const maxMsg = state.config.contextMaxMessages || 20;
    if (state.messages.length > maxMsg) {
      state.messages = state.messages.slice(-maxMsg);
    }

    updateContextBar();
    renderCharSidebar();
    $('#setup-screen').addClass('d-none');
    $('#game-screen').removeClass('d-none').addClass('d-flex');
    $('#debug-panel').removeClass('d-none');
    $('#send-btn, #action-input').prop('disabled', false);
    $('#action-input').trigger('focus');
    location.hash = `game=${id}`;
    const el = document.getElementById('story-text');
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    showToast(`Failed to load game: ${e.message}`, 'danger');
  }
}

// ── Start new game ────────────────────────────────────────────────────────────
async function startGame() {
  if (!state.modelId || !state.scenario) return;

  const sc    = state.scenario;
  const title = $('#game-title-input').val().trim() || `${sc.name} Adventure`;

  const globalPrompt   = state.config.systemPrompt || '';
  const scenarioPrompt = sc.id === 'custom'
    ? ($('#custom-prompt').val().trim() || 'You are a dungeon master for a text adventure.')
    : (sc.systemPrompt || '');
  state.systemPrompt = [globalPrompt, scenarioPrompt].filter(Boolean).join('\n\n');

  const openingText = sc.openingText || '';

  // Create game in DB
  try {
    const r    = await fetch(`${state.config.backendUrl}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        scenario_id:   sc.id,
        model_id:      state.modelId,
        system_prompt: state.systemPrompt,
        opening_text:  openingText,
      }),
    });
    const game = await r.json();
    state.gameId = game.id;
  } catch (e) {
    showToast(`Could not create game: ${e.message}`, 'danger');
    return;
  }

  // Save character to DB
  const charName = $('#char-name-input').val().trim();
  const charDesc = $('#char-desc-input').val().trim();
  state.character = { name: charName, description: charDesc };
  if (charName || charDesc) {
    await fetch(`${state.config.backendUrl}/api/games/${state.gameId}/character`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: charName, description: charDesc }),
    }).catch(() => {});
  }

  state.messages   = [];
  state.segments   = [];
  state.cards      = [];
  state.lastAction = null;

  const sc2 = (state.config.scenarios || []).find(s => s.id === sc.id) || sc;
  $('#scenario-title').text(`${sc2.icon || ''} ${sc2.name}`);
  $('#story-text').empty();
  $('#setup-screen').addClass('d-none');
  $('#game-screen').removeClass('d-none').addClass('d-flex');
  $('#debug-panel').removeClass('d-none');

  if (openingText) {
    appendSegment(openingText + '\n\n', 'narrative');
    state.messages.push({ role: 'assistant', content: openingText });
  }

  updateContextBar();
  renderCharSidebar();
  $('#action-input').prop('disabled', false).trigger('focus');
  $('#send-btn').prop('disabled', false);
  localStorage.setItem('dungeon_last_model', state.modelId);
  location.hash = `game=${state.gameId}`;
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

  // Build messages for this request
  const charCtx = buildCharacterContext();
  const actionPrompt = state.config.actionPrompts?.[actionType] || '';
  const cardsCtx = buildCardsContext();
  let sysContent = [state.systemPrompt, charCtx, cardsCtx, actionPrompt].filter(Boolean).join('\n\n');

  // Move any leading assistant message (opening text) into system context
  // so the conversation always starts user→assistant for ChatML models
  let history = state.messages;
  if (history.length && history[0].role === 'assistant') {
    sysContent += '\n\nStory opening: ' + history[0].content;
    history = history.slice(1);
  }

  const messages = [
    { role: 'system', content: sysContent },
    ...history,
    { role: 'user', content: playerLine },
  ];

  const gen = state.config.generation || {};

  // Console debug
  console.group('%c[Dungeon] Turn', 'color:#7ecfff;font-weight:bold');
  console.log('%cModel:', 'color:#aaa', state.modelId);
  console.log('%cAction:', 'color:#aaa', actionType, actionText);
  console.log('%cMessages (' + messages.length + '):', 'color:#aaa', messages);
  console.log('%cParams:', 'color:#aaa', gen);
  console.groupEnd();

  const streamSpan = $('<span class="narrative streaming-cursor"></span>').appendTo('#story-text');
  let response = '';

  try {
    const r = await fetch(`${state.config.backendUrl}/api/games/${state.gameId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action_type:    actionType,
        raw_input:      actionText,
        messages,
        model_id:       state.modelId,
        temperature:    gen.temperature ?? 0.75,
        num_predict:    gen.maxNewTokens ?? 200,
        repeat_penalty: gen.repetitionPenalty ?? 1.1,
        num_ctx:        gen.numCtx ?? 4096,
      }),
    });

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
          response += msg.content;
          streamSpan.text(response);
          const el = document.getElementById('story-text');
          el.scrollTop = el.scrollHeight;
        } else if (msg.type === 'done') {
          updateDebugPanel(msg, messages, {
            model_id: state.modelId,
            temperature:    gen.temperature,
            num_predict:    gen.maxNewTokens,
            repeat_penalty: gen.repetitionPenalty,
          });
        } else if (msg.type === 'error') {
          throw new Error(msg.message);
        }
      }
    }

    const finalText = (response || '(No response generated)') + '\n\n';
    streamSpan.remove();
    appendSegment(finalText, 'narrative');

    // Update rolling context
    state.messages.push({ role: 'user', content: playerLine });
    state.messages.push({ role: 'assistant', content: response });
    const maxMsg = state.config.contextMaxMessages || 20;
    if (state.messages.length > maxMsg) {
      state.messages = state.messages.slice(-maxMsg);
    }
    updateContextBar();

  } catch (err) {
    streamSpan.text(`[Error: ${err.message}]\n`).addClass('text-danger').removeClass('streaming-cursor');
    showToast(`Generation error: ${err.message}`, 'danger');
  } finally {
    state.generating = false;
    $('#send-btn').prop('disabled', false);
    $('#retry-btn').prop('disabled', false);
    $('#undo-btn').prop('disabled', false);
    $('#action-input').trigger('focus');
  }
}

// ── Undo ──────────────────────────────────────────────────────────────────────
async function undo() {
  if (state.generating || !state.gameId) return;
  try {
    await fetch(`${state.config.backendUrl}/api/games/${state.gameId}/turns/last`, { method: 'DELETE' });
  } catch { /* ignore */ }

  // Remove last two segments (action + narrative) from display
  const toRemove = state.segments.slice(-2);
  state.segments  = state.segments.slice(0, -2);

  // Remove from messages (last user + assistant pair)
  if (state.messages.length >= 2) {
    state.messages = state.messages.slice(0, -2);
  }

  rebuildStoryDisplay();
  updateContextBar();
  if (state.segments.length === 0) {
    $('#undo-btn').prop('disabled', true);
  }
}

// ── Retry ─────────────────────────────────────────────────────────────────────
async function retry() {
  if (!state.lastAction || state.generating) return;
  await undo();
  await generateContinuation(state.lastAction.text, state.lastAction.type);
}

// ── Reset game ────────────────────────────────────────────────────────────────
function resetGame() {
  state.gameId      = null;
  state.modelId     = $('#model-select').val() || null;
  state.scenario    = null;
  state.systemPrompt= '';
  state.messages    = [];
  state.segments    = [];
  state.cards       = [];
  state.lastAction  = null;

  $('#story-text').empty();
  $('#action-input').prop('disabled', true).val('');
  $('#send-btn, #undo-btn, #retry-btn').prop('disabled', true);
  $('.scenario-card').removeClass('border-primary active').addClass('border-secondary');
  $('#start-btn').prop('disabled', true);
  $('#game-screen').addClass('d-none').removeClass('d-flex');
  $('#setup-screen').removeClass('d-none');
  $('#debug-panel').addClass('d-none');
  history.replaceState(null, '', location.pathname);

  updateStartBtn();
  refreshGameList();
}

// ── Build scenario cards ──────────────────────────────────────────────────────
function buildScenarioGrid() {
  (state.config.scenarios || []).forEach(sc => {
    const col  = $('<div class="col"></div>');
    const card = $(`
      <div class="card h-100 scenario-card border border-secondary" data-id="${sc.id}" role="button">
        <div class="card-body text-center py-3">
          <div class="display-6 mb-1">${sc.icon}</div>
          <h6 class="card-title mb-1">${sc.name}</h6>
          <p class="card-text small text-secondary mb-0">${sc.description}</p>
        </div>
      </div>
    `);
    col.append(card);
    $('#scenario-grid').append(col);
  });
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
  const lines = active.map(c => `[${c.type.toUpperCase()}] ${c.name}${c.description ? ': ' + c.description : ''}`);
  return 'World context:\n' + lines.join('\n');
}

function appendSegment(text, cssClass) {
  state.segments.push({ text, cssClass });
  const idx  = state.segments.length - 1;
  const span = $('<span></span>').addClass(cssClass).text(text);
  attachSegmentEdit(span, idx);
  $('#story-text').append(span);
  const el = document.getElementById('story-text');
  el.scrollTop = el.scrollHeight;
  return span;
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
        if (e.key === 'Escape') { $ta.replaceWith($span); }
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
  const msgs = state.segments
    .filter(s => s.cssClass === 'narrative' || s.cssClass === 'action')
    .map(s => ({
      role:    s.cssClass === 'narrative' ? 'assistant' : 'user',
      content: s.text.replace(/\n+$/, ''),
    }));
  const maxMsg = state.config.contextMaxMessages || 20;
  state.messages = msgs.length > maxMsg ? msgs.slice(-maxMsg) : msgs;
  updateContextBar();
}

function updateContextBar() {
  const msgChars = state.messages.reduce((a, m) => a + m.content.length, 0);
  const approxTok = Math.floor(msgChars / 4);
  const max = (state.config.contextMaxMessages || 20) * 150; // rough token estimate
  const pct = Math.min(100, Math.floor((approxTok / max) * 100));
  $('#context-bar')
    .css('width', `${pct}%`)
    .attr('aria-valuenow', pct)
    .removeClass('bg-success bg-warning bg-danger')
    .addClass(pct < 60 ? 'bg-success' : pct < 85 ? 'bg-warning' : 'bg-danger');
  $('#context-label').removeClass('d-none').text(`~${approxTok} tok, ${state.messages.length} msgs`);
}

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

function renderCharSidebar() {
  const c = state.character;
  $('#char-fields').html(`
    <div class="mb-2">
      <label class="small text-secondary mb-1 d-block">Name</label>
      <input id="char-name-edit" type="text" class="form-control form-control-sm"
             value="${(c.name || '').replace(/"/g, '&quot;')}" placeholder="Hero">
    </div>
    <div class="mb-2">
      <label class="small text-secondary mb-1 d-block">Class</label>
      <input id="char-class-edit" type="text" class="form-control form-control-sm"
             value="${(c.class || '').replace(/"/g, '&quot;')}" placeholder="—">
    </div>
    <div class="mb-2">
      <label class="small text-secondary mb-1 d-block">Description</label>
      <textarea id="char-desc-edit" class="form-control form-control-sm" rows="3"
                placeholder="—">${c.description || ''}</textarea>
    </div>
    <div class="mb-2">
      <label class="small text-secondary mb-1 d-block">Notes</label>
      <textarea id="char-notes-edit" class="form-control form-control-sm" rows="3"
                placeholder="Inventory, quests, relationships…">${c.notes || ''}</textarea>
    </div>
  `);

  async function saveCharacter() {
    state.character = {
      ...state.character,
      name:        $('#char-name-edit').val().trim(),
      class:       $('#char-class-edit').val().trim(),
      description: $('#char-desc-edit').val().trim(),
      notes:       $('#char-notes-edit').val().trim(),
    };
    await fetch(`${state.config.backendUrl}/api/games/${state.gameId}/character`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.character),
    }).catch(() => {});
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
  const $el = $(`
    <div class="card bg-dark border-secondary mb-2" data-card-id="${card.id}">
      <div class="card-body p-2">
        <div class="d-flex align-items-center gap-1 mb-1">
          <div class="form-check form-switch mb-0 me-1">
            <input class="form-check-input card-active-toggle" type="checkbox" ${card.active ? 'checked' : ''}>
          </div>
          <select class="form-select form-select-sm card-type-sel" style="width:90px">
            ${CARD_TYPES.map(t => `<option value="${t}" ${card.type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-outline-danger ms-auto card-del-btn" style="padding:1px 6px">✕</button>
        </div>
        <input type="text" class="form-control form-control-sm mb-1 card-name-input" value="${(card.name || '').replace(/"/g, '&quot;')}" placeholder="Name">
        <textarea class="form-control form-control-sm card-desc-input" rows="2" placeholder="Description…">${card.description || ''}</textarea>
      </div>
    </div>
  `);

  async function saveCard() {
    const idx = state.cards.findIndex(c => c.id === card.id);
    const updated = {
      ...card,
      type:        $el.find('.card-type-sel').val(),
      name:        $el.find('.card-name-input').val().trim(),
      description: $el.find('.card-desc-input').val().trim(),
      active:      $el.find('.card-active-toggle').is(':checked') ? 1 : 0,
    };
    await fetch(`${state.config.backendUrl}/api/games/${state.gameId}/cards/${card.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    }).catch(() => {});
    if (idx >= 0) state.cards[idx] = updated;
  }

  $el.find('.card-active-toggle, .card-type-sel').on('change', saveCard);
  $el.find('.card-name-input, .card-desc-input').on('blur', saveCard);
  $el.find('.card-del-btn').on('click', async () => {
    if (!confirm(`Delete card "${card.name}"?`)) return;
    await fetch(`${state.config.backendUrl}/api/games/${state.gameId}/cards/${card.id}`, { method: 'DELETE' }).catch(() => {});
    state.cards = state.cards.filter(c => c.id !== card.id);
    $el.remove();
    if (!state.cards.length) renderWorldCards();
  });

  return $el;
}

function updateStartBtn() {
  const hasModel    = !!state.modelId && $('#model-select').val();
  const hasScenario = !!state.scenario;
  $('#start-btn').prop('disabled', !(hasModel && hasScenario));
}

function showToast(message, type = 'info') {
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

// ── Debug modal (prompt editor) ───────────────────────────────────────────────
function openDebugModal() {
  const ap = state.config.actionPrompts || {};
  $('#debug-global-prompt').val(state.config.systemPrompt || '');
  $('#debug-scenario-prompt').val(state.scenario?.systemPrompt || '');
  $('#debug-char-context').val(buildCharacterContext());
  $('#debug-action-do').val(ap.do || '');
  $('#debug-action-say').val(ap.say || '');
  $('#debug-action-story').val(ap.story || '');
  $('#debug-active-action').text($('#action-type').val() || 'do');
  $('#debug-last-prompt').val(JSON.stringify(state.messages, null, 2) || '(no turns yet)');
  updateDebugCombined();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('debug-modal')).show();
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

// ── Stats modal ───────────────────────────────────────────────────────────────
async function openStatsModal() {
  const $body = $('#stats-table-body').html(
    '<tr><td colspan="6" class="text-center text-secondary py-3">Loading…</td></tr>'
  );
  try {
    const r    = await fetch(`${state.config.backendUrl}/api/stats`);
    const rows = await r.json();
    $body.empty();
    if (rows.length === 0) {
      $body.html('<tr><td colspan="6" class="text-center text-secondary py-3">No data yet.</td></tr>');
      return;
    }
    rows.forEach(s => {
      const last = s.last_used_at ? new Date(s.last_used_at + 'Z').toLocaleString() : '—';
      $body.append(`<tr>
        <td class="font-monospace small">${s.model_id}</td>
        <td class="text-end">${s.total_turns}</td>
        <td class="text-end">${s.total_prompt_tok?.toLocaleString() ?? '—'}</td>
        <td class="text-end">${s.total_compl_tok?.toLocaleString() ?? '—'}</td>
        <td class="text-end">${s.avg_tok_per_sec?.toFixed(1) ?? '—'}</td>
        <td class="text-end small text-secondary">${last}</td>
      </tr>`);
    });
  } catch (e) {
    $body.html(`<tr><td colspan="6" class="text-center text-danger py-3">${e.message}</td></tr>`);
  }
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  // Model select
  $('#model-select').on('change', function () {
    state.modelId = $(this).val() || null;
    updateStartBtn();
  });

  // Scenario click
  $(document).on('click', '.scenario-card', function () {
    $('.scenario-card').removeClass('border-primary active').addClass('border-secondary');
    $(this).addClass('border-primary active').removeClass('border-secondary');
    const id = $(this).data('id');
    state.scenario = (state.config.scenarios || []).find(s => s.id === id) || null;
    $('#custom-prompt-area').toggleClass('d-none', id !== 'custom');
    updateStartBtn();
  });

  // Action buttons
  $('#start-btn').on('click', startGame);
  $('#send-btn').on('click', sendAction);
  $('#undo-btn').on('click', undo);
  $('#retry-btn').on('click', retry);
  $('#new-game-btn').on('click', resetGame);
  $('#debug-btn').on('click', openDebugModal);
  $('#char-toggle-btn').on('click', function () {
    const sheet = $('#char-sheet');
    sheet.css('display') === 'none' ? sheet.css('display', 'flex') : sheet.hide();
  });

  // Sidebar tabs
  $('#sidebar-tabs').on('click', '[data-tab]', function () {
    const tab = $(this).data('tab');
    $('#sidebar-tabs .nav-link').removeClass('active');
    $(this).addClass('active');
    $('#tab-char, #tab-world').addClass('d-none');
    $(`#tab-${tab}`).removeClass('d-none');
    if (tab === 'world') renderWorldCards();
  });

  // Add world card
  $('#add-card-btn').on('click', async function () {
    const card = await fetch(`${state.config.backendUrl}/api/games/${state.gameId}/cards`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'location', name: '', description: '', active: 1 }),
    }).then(r => r.json()).catch(() => null);
    if (!card) return;
    state.cards.push(card);
    $('#world-cards-list .text-secondary').remove();
    $('#world-cards-list').append(buildCardEl(card));
    $('#world-cards-list').find('.card-name-input').last().trigger('focus');
  });

  // Enter to send
  $('#action-input').on('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAction(); }
  });

  // Debug modal inputs
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

  // Modal open handlers
  document.getElementById('models-modal').addEventListener('show.bs.modal', openModelsModal);
  document.getElementById('load-modal').addEventListener('show.bs.modal', refreshGameList);
  document.getElementById('stats-modal').addEventListener('show.bs.modal', openStatsModal);
}
