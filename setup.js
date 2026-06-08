// StoryTelling — setup screen logic

import {
  loadConfig, initApi, showToast, pollHealth, parseDate, renderTemplate,
} from './utils.js';
import {
  getModels, deleteModel, pullModel,
  getGames, createGame, deleteGame,
  putCharacter, createCard, getStats,
} from './api.js';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  config:   null,
  modelId:  null,
  scenario: null,
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
$(async function () {
  try {
    state.config = await loadConfig();
  } catch {
    showToast('Failed to load config.json.', 'danger');
    return;
  }

  initApi(state.config);
  pollHealth(state.config);

  buildScenarioGrid();
  bindEvents();
  await refreshInstalledModels();
  await refreshGameList();
});

// ── Scenario grid ─────────────────────────────────────────────────────────────
function buildScenarioGrid() {
  (state.config.scenarios || []).forEach(sc => {
    const $col = renderTemplate('tmpl-scenario-card', {
      icon:        sc.icon,
      name:        sc.name,
      description: sc.description,
    });
    $col.find('.scenario-card').attr('data-id', sc.id);
    $('#scenario-grid').append($col);
  });
}

// ── Installed models ──────────────────────────────────────────────────────────
async function refreshInstalledModels() {
  try {
    const data      = await getModels();
    const installed = (data.models || []).map(m => m.name);
    const cfg       = state.config.availableModels || [];
    const present   = cfg.filter(m => installed.some(n => n === m.id || n.startsWith(m.id + ':')));

    const $sel = $('#model-select').empty();
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
    const data = await getModels();
    installed  = (data.models || []).map(m => m.name);
  } catch { /* offline */ }

  $body.empty();
  (state.config.availableModels || []).forEach(m => {
    const isInstalled = installed.some(n => n === m.id || n.startsWith(m.id + ':'));
    const sizeStr     = m.sizeMb >= 1000 ? `${(m.sizeMb / 1000).toFixed(1)} GB` : `${m.sizeMb} MB`;
    const $row = renderTemplate('tmpl-model-row', {
      name:      m.name,
      id:        m.id,
      size:      sizeStr,
      nsfwBadge: m.nsfw ? '<span class="badge bg-danger">18+</span>' : '',
    });
    $row.find('tr').attr('data-model-id', m.id);
    renderModelRowAction($row.find('tr'), m.id, isInstalled);
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
        await deleteModel(modelId);
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
        await pullModel(modelId, (msg) => {
          $progress.find('.pull-status').text(msg.status || '');
          if (msg.total && msg.completed) {
            $progress.find('progress')[0].max   = msg.total;
            $progress.find('progress')[0].value = msg.completed;
          }
          if (msg.status === 'success') $progress.find('.pull-status').text('Done ✓');
        });
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

// ── Game list ─────────────────────────────────────────────────────────────────
async function refreshGameList() {
  try {
    const games = await getGames();
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
      const sc         = (state.config.scenarios || []).find(s => s.id === g.scenario_id) || {};
      const icon       = sc.icon || '📖';
      const modelShort = (g.model_id || '').split(':')[0].split('/').pop();

      const $row = renderTemplate('tmpl-game-row', {
        title:      g.title,
        scenario:   `${icon} ${sc.name || g.scenario_id || '—'}`,
        model:      modelShort,
        lastPlayed: parseDate(g.last_played_at),
      });
      $row.find('tr').attr('data-game-id', g.id);

      $row.find('tr').on('click', function (e) {
        if ($(e.target).hasClass('delete-game-btn')) return;
        bootstrap.Modal.getInstance(document.getElementById('load-modal'))?.hide();
        window.location.href = `game.html?id=${g.id}`;
      });

      $row.find('.delete-game-btn').on('click', async function (e) {
        e.stopPropagation();
        if (!confirm(`Delete game "${g.title}"?`)) return;
        await deleteGame(g.id);
        await refreshGameList();
      });

      $tbody.append($row);
    });
    $list.append($table);
  } catch (e) {
    $('#load-game-list').html(`<div class="text-center text-danger py-4">Error: ${e.message}</div>`);
  }
}

// ── Stats modal ───────────────────────────────────────────────────────────────
async function openStatsModal() {
  const $body = $('#stats-table-body').html(
    '<tr><td colspan="6" class="text-center text-secondary py-3">Loading…</td></tr>'
  );
  try {
    const rows = await getStats();
    $body.empty();
    if (rows.length === 0) {
      $body.html('<tr><td colspan="6" class="text-center text-secondary py-3">No data yet.</td></tr>');
      return;
    }
    rows.forEach(s => {
      const $row = renderTemplate('tmpl-stats-row', {
        model_id:   s.model_id,
        total_turns:s.total_turns,
        prompt_tok: s.total_prompt_tok?.toLocaleString() ?? '—',
        compl_tok:  s.total_compl_tok?.toLocaleString() ?? '—',
        tps:        s.avg_tok_per_sec?.toFixed(1) ?? '—',
        last_used:  parseDate(s.last_used_at),
      });
      $body.append($row);
    });
  } catch (e) {
    $body.html(`<tr><td colspan="6" class="text-center text-danger py-3">${e.message}</td></tr>`);
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
    : (sc.scenarioPrompt || '');

  let game;
  try {
    game = await createGame({
      title,
      scenario_id:     sc.id,
      model_id:        state.modelId,
      system_prompt:   globalPrompt,
      scenario_prompt: scenarioPrompt,
      custom_prompt:   state.config.customSystemPrompt || '',
      opening_text:    sc.openingText || '',
    });
  } catch (e) {
    showToast(`Could not create game: ${e.message}`, 'danger');
    return;
  }

  const mc       = sc.mainCharacters?.[0];
  const charName = $('#char-name-input').val().trim();
  const charDesc = $('#char-desc-input').val().trim();
  const charClass = mc?.class || '';
  if (charName || charDesc || charClass) {
    await putCharacter(game.id, { name: charName, description: charDesc, class: charClass }).catch(() => {});
  }

  if (sc.cards?.length) {
    await Promise.all(
      sc.cards.map((c, i) => createCard(game.id, {
        type:        c.type || 'lore',
        name:        c.name,
        description: c.description || '',
        triggers:    c.triggers || '',
        active:      1,
        sort_order:  i,
      }).catch(() => {}))
    );
  }

  localStorage.setItem('dungeon_last_model', state.modelId);
  window.location.href = `game.html?id=${game.id}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function updateStartBtn() {
  const hasModel    = !!state.modelId && !!$('#model-select').val();
  const hasScenario = !!state.scenario;
  $('#start-btn').prop('disabled', !(hasModel && hasScenario));
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  $('#model-select').on('change', function () {
    state.modelId = $(this).val() || null;
    updateStartBtn();
  });

  $(document).on('click', '.scenario-card', function () {
    $('.scenario-card').removeClass('border-primary active').addClass('border-secondary');
    $(this).addClass('border-primary active').removeClass('border-secondary');
    const id = $(this).data('id');
    state.scenario = (state.config.scenarios || []).find(s => s.id === id) || null;
    $('#custom-prompt-area').toggleClass('d-none', id !== 'custom');

    const mc = state.scenario?.mainCharacters?.[0];
    $('#char-name-input').val(mc?.name || '');
    $('#char-desc-input').val(mc?.description || '');

    updateStartBtn();
  });

  $('#start-btn').on('click', startGame);

  document.getElementById('models-modal').addEventListener('show.bs.modal', openModelsModal);
  document.getElementById('load-modal').addEventListener('show.bs.modal', refreshGameList);
  document.getElementById('stats-modal').addEventListener('show.bs.modal', openStatsModal);
}
