// popup.js — Controlador do popup (ES Module)

import { getSettings, saveSettings, getStats, getLog, clearLog, getHistory, clearHistory, getBlacklist, saveBlacklist, getGraylist, saveGraylist } from './db.js';
import {
  validateLicense, gateAction, normalizeKey, isKeyFormatValid,
  saveLicenseKey, clearLicense, getCurrentStatus,
} from './sync.js';

// ─── Inicialização ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  await loadSettings();
  await restoreState();
  initForms();
  initMessages();
  initBackup();
  initProspecting();
  initList();
  initHistory();
  initLicense();
  listenForProgress();

  // Refresca estado da licença ao abrir o popup (silent = usa cache fresco)
  await refreshLicenseUI({ silent: true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════════════════════════════
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  closeCardDetail();
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(s => {
    s.classList.toggle('active', s.id === `tab-${name}`);
  });
  if (name === 'list')     refreshList();
  if (name === 'history')  refreshHistory();
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES
// ═══════════════════════════════════════════════════════════════════════════
async function loadSettings() {
  const cfg = await getSettings();
  [
    'icp', 'produto', 'instrucaoAbordagem', 'hashtags', 'idiomaAlvo',
    'pontuacaoMinima', 'metaPerfis', 'openaiKey',
    'delayMinPerfil', 'delayMaxPerfil',
    'pausaMinGrupo', 'pausaMaxGrupo', 'tamanhoGrupo',
    'webhookEndpoint', 'webhookApiKey', 'webhookFunnel', 'webhookStage', 'webhookTags',
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el && cfg[id] !== undefined) el.value = cfg[id];
  });
  // Checkbox separado
  const cbAuto = document.getElementById('webhookAuto');
  if (cbAuto) cbAuto.checked = !!cfg.webhookAuto;

  // Prompts de mensagem (aba separada)
  const elIce  = document.getElementById('promptIcebreaker');
  const elHook = document.getElementById('promptHook');
  if (elIce  && cfg.promptIcebreaker !== undefined) elIce.value  = cfg.promptIcebreaker;
  if (elHook && cfg.promptHook       !== undefined) elHook.value = cfg.promptHook;
}

function initForms() {
  document.getElementById('settings-form').addEventListener('submit', async e => {
    e.preventDefault();
    const cfg = {
      icp:                val('icp'),
      produto:            val('produto'),
      instrucaoAbordagem: val('instrucaoAbordagem'),
      hashtags:           val('hashtags'),
      idiomaAlvo:         val('idiomaAlvo'),
      pontuacaoMinima:    Number(val('pontuacaoMinima')) || 7,
      metaPerfis:         Number(val('metaPerfis'))      || 20,
      openaiKey:          val('openaiKey'),
      delayMinPerfil:     Number(val('delayMinPerfil'))  || 3,
      delayMaxPerfil:     Number(val('delayMaxPerfil'))  || 7,
      pausaMinGrupo:      Number(val('pausaMinGrupo'))   || 30,
      pausaMaxGrupo:      Number(val('pausaMaxGrupo'))   || 90,
      tamanhoGrupo:       Number(val('tamanhoGrupo'))    || 10,
      webhookEndpoint:    val('webhookEndpoint'),
      webhookApiKey:      val('webhookApiKey'),
      webhookFunnel:      val('webhookFunnel'),
      webhookStage:       val('webhookStage'),
      webhookTags:        val('webhookTags'),
      webhookAuto:        document.getElementById('webhookAuto')?.checked || false,
    };
    await saveSettings(cfg);
    showToast('settings-toast', 'Configurações salvas!', 'success');
  });
}

function initMessages() {
  document.getElementById('messages-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const cfg = await getSettings();
    cfg.promptIcebreaker = val('promptIcebreaker');
    cfg.promptHook       = val('promptHook');
    await saveSettings(cfg);
    showToast('messages-toast', 'Prompts salvos!', 'success');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORT / IMPORT CONFIGURAÇÕES
// ═══════════════════════════════════════════════════════════════════════════
function initBackup() {
  document.getElementById('btn-export-settings')?.addEventListener('click', exportSettings);
  document.getElementById('import-file-input')?.addEventListener('change', importSettings);
  document.getElementById('btn-export-blacklist')?.addEventListener('click', exportBlacklist);
  document.getElementById('btn-export-graylist')?.addEventListener('click', exportGraylist);
  document.getElementById('import-blacklist-input')?.addEventListener('change', importBlacklist);
  document.getElementById('import-graylist-input')?.addEventListener('change', importGraylist);
}

async function exportSettings() {
  if (!await gateAction()) { onLicenseDeniedDuringAction(); return; }
  const cfg = await getSettings();
  downloadFile(JSON.stringify(cfg, null, 2), 'isihunter-config.json', 'application/json');
}

async function exportBlacklist() {
  if (!await gateAction()) { onLicenseDeniedDuringAction(); return; }
  const data = await getBlacklist();
  const usernames = Object.keys(data);
  const rows = ['username', ...usernames].join('\n');
  downloadFile(rows, 'isihunter-blacklist.csv', 'text/csv');
}

async function exportGraylist() {
  if (!await gateAction()) { onLicenseDeniedDuringAction(); return; }
  const data = await getGraylist();
  const lines = ['username,expira_em'];
  for (const [username, ts] of Object.entries(data)) {
    const expira = new Date(ts).toISOString();
    lines.push(`${username},${expira}`);
  }
  downloadFile(lines.join('\n'), 'isihunter-graylist.csv', 'text/csv');
}

async function importSettings(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!await gateAction()) { e.target.value = ''; onLicenseDeniedDuringAction(); return; }
  try {
    const text = await file.text();
    const cfg  = JSON.parse(text);
    await saveSettings(cfg);
    await loadSettings();
    showToast('settings-toast', 'Configurações importadas com sucesso!', 'success');
  } catch (err) {
    showToast('settings-toast', 'Erro ao importar: arquivo inválido.', 'error');
  }
  e.target.value = '';
}

async function importBlacklist(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!await gateAction()) { e.target.value = ''; onLicenseDeniedDuringAction(); return; }
  try {
    const text = await file.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // Remove header se presente
    const usernames = lines[0]?.toLowerCase() === 'username' ? lines.slice(1) : lines;
    const existing = await getBlacklist();
    for (const u of usernames) if (u) existing[u] = true;
    await saveBlacklist(existing);
    showToast('settings-toast', `Blacklist importada: ${usernames.length} entradas mescladas.`, 'success');
  } catch {
    showToast('settings-toast', 'Erro ao importar blacklist.', 'error');
  }
  e.target.value = '';
}

async function importGraylist(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!await gateAction()) { e.target.value = ''; onLicenseDeniedDuringAction(); return; }
  try {
    const text = await file.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // Remove header se presente
    const dataLines = lines[0]?.toLowerCase().startsWith('username') ? lines.slice(1) : lines;
    const existing = await getGraylist();
    let count = 0;
    for (const line of dataLines) {
      const [username, expiraStr] = line.split(',');
      if (!username) continue;
      const ts = expiraStr ? new Date(expiraStr).getTime() : 0;
      if (ts > Date.now()) { existing[username.trim()] = ts; count++; }
    }
    await saveGraylist(existing);
    showToast('settings-toast', `Graylist importada: ${count} entradas válidas mescladas.`, 'success');
  } catch {
    showToast('settings-toast', 'Erro ao importar graylist.', 'error');
  }
  e.target.value = '';
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROSPECÇÃO
// ═══════════════════════════════════════════════════════════════════════════
let _pendingUsernames = [];

function initProspecting() {
  document.getElementById('btn-start').addEventListener('click', startProspecting);
  document.getElementById('btn-stop').addEventListener('click', stopProspecting);
  document.getElementById('btn-clear-log').addEventListener('click', async () => {
    await clearLog();
    clearLogUI();
  });
  document.getElementById('list-file-input').addEventListener('change', handleListFile);
  document.getElementById('btn-start-list').addEventListener('click', startListProspecting);
}

async function handleListFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const usernames = parseUsernameList(text);
    _pendingUsernames = usernames;
    const textEl = document.getElementById('list-upload-text');
    const btn    = document.getElementById('btn-start-list');
    if (usernames.length === 0) {
      textEl.textContent = 'Nenhum usuário válido encontrado';
      btn.disabled = true;
    } else {
      textEl.textContent = `${usernames.length} usuário${usernames.length > 1 ? 's' : ''} carregado${usernames.length > 1 ? 's' : ''}`;
      btn.disabled = false;
    }
  } catch (_) {
    document.getElementById('list-upload-text').textContent = 'Erro ao ler o arquivo';
    document.getElementById('btn-start-list').disabled = true;
  }
}

function parseUsernameList(text) {
  return [...new Set(
    text.split(/\r?\n/)
      .map(line => line.split(/[,;\t]/)[0].trim().replace(/^@/, '').toLowerCase())
      .filter(u => u && /^[a-z0-9._]{1,30}$/.test(u))
  )];
}

async function startListProspecting() {
  if (!_pendingUsernames.length) return;
  const btnList = document.getElementById('btn-start-list');
  btnList.disabled = true;
  hideError();

  const res = await sendToBg({ type: 'START_LIST_PROSPECTING', usernames: _pendingUsernames });
  if (res?.ok === false) {
    if (res.error === 'license_required') { onLicenseDeniedDuringAction(res.license_status); btnList.disabled = false; return; }
    showError(res.error || 'Erro ao iniciar triagem');
    btnList.disabled = _pendingUsernames.length === 0;
    return;
  }

  document.getElementById('btn-start').classList.add('hidden');
  document.getElementById('btn-stop').classList.remove('hidden');
  showStatsRow();
  showLogHeader();
  clearLogUI();

  _pendingUsernames = [];
  document.getElementById('list-upload-text').textContent = 'Triar lista de usuários (.txt / .csv)';
}

async function startProspecting() {
  const btnStart = document.getElementById('btn-start');
  const btnStop  = document.getElementById('btn-stop');
  btnStart.disabled = true;

  hideError();

  const res = await sendToBg({ type: 'START_PROSPECTING' });
  if (res?.ok === false) {
    if (res.error === 'license_required') { onLicenseDeniedDuringAction(res.license_status); btnStart.disabled = false; return; }
    showError(res.error || 'Erro ao iniciar prospecção');
    btnStart.disabled = false;
    return;
  }

  btnStart.classList.add('hidden');
  btnStop.classList.remove('hidden');
  showStatsRow();
  showLogHeader();
  clearLogUI();
}

async function stopProspecting() {
  const btnStart = document.getElementById('btn-start');
  const btnStop  = document.getElementById('btn-stop');

  await sendToBg({ type: 'STOP_PROSPECTING' });

  btnStop.classList.add('hidden');
  btnStart.classList.remove('hidden');
  btnStart.disabled = false;

  addLogEntry({ action: 'stopped', message: 'Prospecção interrompida pelo usuário.' });
}

// ─── Restaura estado ao abrir o popup ────────────────────────────────────
async function restoreState() {
  const [stats, log] = await Promise.all([getStats(), getLog()]);

  if (stats.approved > 0 || stats.processed > 0) {
    showStatsRow();
    showLogHeader();
    updateStatsUI(stats.processed, stats.approved);
  }

  if (stats.active) {
    // Verifica com o background se a coleta realmente está viva ou se é estado zumbi
    const check = await sendToBg({ type: 'CHECK_ACTIVE' });
    if (check?.active) {
      document.getElementById('btn-start').classList.add('hidden');
      document.getElementById('btn-stop').classList.remove('hidden');
    }
    // Se não está ativo de verdade, o background já reseta stats.active — botão Iniciar fica visível
  }

  // Recarrega log salvo
  if (log.length) {
    clearLogUI();
    log.forEach(e => addLogEntry(e, false));
    scrollLogToBottom();
  }

  // Atualiza badge da aba Lista
  if (stats.approved > 0) updateListBadge(stats.approved);
}

// ─── Listener de atualizações do background ──────────────────────────────
function listenForProgress() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PROGRESS')         handleProgress(msg);
    if (msg.type === 'DM_SENT')          handleDmSent(msg.username);
    if (msg.type === 'COMMENT_POSTED')   handleCommentPosted(msg.username);
    if (msg.type === 'WEBHOOK_SENT')     handleWebhookSent(msg.username);
    if (msg.type === 'WEBHOOK_ERROR')    handleWebhookError(msg.username, msg.error);
    if (msg.type === 'LICENSE_REVOKED')  handleLicenseRevoked(msg.license_status);
  });
}

function handleLicenseRevoked(status) {
  resetProspectingButtons();
  addLogEntry({ action: 'error', message: 'Licença revogada — prospecção interrompida.' });
  refreshLicenseUI({ silent: true });
  switchTab('license');
}

function handleProgress(msg) {
  const { action, username, pontuacao, processed, approved, error } = msg;

  // Atualiza contadores
  if (processed !== undefined) updateStatsUI(processed, approved || 0);

  switch (action) {
    case 'evaluating':
      addLogEntry({ action: 'evaluating', message: `Avaliando @${username}…` });
      break;

    case 'approved':
      addLogEntry({
        action: 'approved',
        message: `@${username} — ${pontuacao}/10 — Aprovado ✓`,
      });
      updateListBadge(approved);
      // Atualiza histórico se a aba estiver visível
      if (document.getElementById('tab-history')?.classList.contains('active')) refreshHistory();
      break;

    case 'rejected':
      addLogEntry({
        action: 'rejected',
        message: `@${username} — ${pontuacao}/10 — Descartado`,
      });
      if (document.getElementById('tab-history')?.classList.contains('active')) refreshHistory();
      break;

    case 'complete':
      addLogEntry({
        action: 'complete',
        message: `Meta atingida! ${approved} perfis aprovados. Prospecção encerrada.`,
      });
      resetProspectingButtons();
      break;

    case 'stopped':
      resetProspectingButtons();
      break;

    case 'long_pause':
      addLogEntry({
        action: 'evaluating',
        message: `⏸ Pausa longa: ${msg.pausaSeg}s (anti-detecção)`,
      });
      break;

    case 'idioma_ignorado':
      addLogEntry({ action: 'idioma_ignorado', message: `@${username} — idioma ignorado (${msg.idioma || '?'})` });
      break;

    case 'checking':
      addLogEntry({ action: 'evaluating', message: `Verificando @${username}…` });
      break;

    case 'checking_login':
      addLogEntry({ action: 'evaluating', message: `Verificando sessão do Instagram…${msg.total ? ` (${msg.total} perfis na fila)` : ''}` });
      break;

    case 'fetch_failed':
      addLogEntry({ action: 'error', message: `@${username}: falha na API (${msg.error || 'sem dados'})` });
      break;

    case 'shortcode_failed':
      addLogEntry({ action: 'error', message: `Post ignorado (${msg.error || 'sem dados'})` });
      break;

    case 'private_profile':
      addLogEntry({ action: 'rejected', message: `@${username} — perfil privado, ignorado` });
      break;

    case 'skipped_blacklist':
      addLogEntry({ action: 'evaluating', message: `@${username} já foi aprovado antes — pulando` });
      break;

    case 'skipped_graylist':
      addLogEntry({ action: 'evaluating', message: `@${username} em graylist (30d) — pulando` });
      break;

    case 'error':
      addLogEntry({ action: 'error', message: `Erro em @${username || '?'}: ${error}` });
      break;

    case 'collection_done':
      addLogEntry({ action: 'collection_done', message: `Prospecção encerrada: sem mais perfis na hashtag. ${msg.approved || 0} aprovados.` });
      resetProspectingButtons();
      break;

    case 'collection_error':
      showError(error || 'Erro na coleta de dados');
      resetProspectingButtons();
      break;
  }
}

function handleDmSent(username) {
  const card = document.querySelector(`[data-username="${username}"]`);
  if (!card) return;
  const badge = card.querySelector('.status-badge-dm');
  if (badge) {
    badge.className = 'status-badge sent status-badge-dm';
    badge.innerHTML = checkIcon() + ' DM Enviado';
  }
  const btn = card.querySelector('.btn-send-dm');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviado'; }
}

function handleCommentPosted(username) {
  const card = document.querySelector(`[data-username="${username}"]`);
  if (!card) return;
  const badge = card.querySelector('.status-badge-comment');
  if (badge) {
    badge.className = 'status-badge commented status-badge-comment';
    badge.innerHTML = checkIcon() + ' Comentado';
  }
  const btn = card.querySelector('.btn-post-comment');
  if (btn) { btn.disabled = true; btn.textContent = 'Comentado'; }
}

function checkIcon() {
  return `<svg width="10" height="10" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;
}

function handleWebhookSent(username) {
  const card = document.querySelector(`[data-username="${username}"]`);
  if (!card) return;
  const badge = card.querySelector('.status-badge-webhook');
  if (badge) {
    badge.className = 'status-badge webhook-ok status-badge-webhook';
    badge.innerHTML = checkIcon() + ' Webhook OK';
  }
  const btn = card.querySelector('.btn-webhook');
  if (btn) { btn.disabled = true; btn.textContent = 'Enviado'; }
}

function handleWebhookError(username, error) {
  const card = document.querySelector(`[data-username="${username}"]`);
  if (!card) return;
  const badge = card.querySelector('.status-badge-webhook');
  if (badge) {
    badge.className = 'status-badge webhook-error status-badge-webhook';
    badge.title = error || 'Erro desconhecido';
    badge.innerHTML = '⚠ Webhook falhou';
  }
  const btn = card.querySelector('.btn-webhook');
  if (btn) { btn.disabled = false; btn.textContent = 'Reenviar'; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  HISTÓRICO
// ═══════════════════════════════════════════════════════════════════════════

let historyFilter = 'all';

function initHistory() {
  document.getElementById('btn-clear-history')?.addEventListener('click', async () => {
    if (!confirm('Limpar todo o histórico de perfis analisados?')) return;
    await clearHistory();
    refreshHistory();
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      historyFilter = btn.dataset.filter;
      refreshHistory();
    });
  });
}

async function refreshHistory() {
  const history = await getHistory();
  renderHistory(history);
}

function renderHistory(history) {
  const container = document.getElementById('history-list');
  const counter   = document.getElementById('history-counter');

  const filtered = historyFilter === 'all'
    ? history
    : history.filter(h => h.resultado === historyFilter);

  const total     = history.length;
  const aprovados = history.filter(h => h.resultado === 'aprovado').length;
  counter.textContent = `${total} analisados · ${aprovados} aprovados · ${total - aprovados} descartados`;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="list-empty">Nenhum registro encontrado.</div>';
    return;
  }

  container.innerHTML = '';
  filtered.forEach(entry => {
    const row = document.createElement('div');
    row.className = `history-row ${entry.resultado}`;
    const scoreColor = scoreToColor(entry.pontuacao || 0);
    const timeAgo = formatTimeAgo(entry.ts);

    row.innerHTML = `
      <div class="history-result">${entry.resultado === 'aprovado' ? '✓' : '✕'}</div>
      <div class="history-info">
        <div class="history-name">@${escHtml(entry.username)}${entry.nome && entry.nome !== entry.username ? ` · ${escHtml(entry.nome)}` : ''}</div>
        <div class="history-meta">${escHtml(entry.seguidores || '')} seguidores · ${timeAgo}</div>
      </div>
      <div class="history-score" style="color:${scoreColor}">${entry.pontuacao ?? '—'}/10</div>
      <span class="history-tag">${entry.resultado === 'aprovado' ? 'Blacklist' : 'Graylist 30d'}</span>
    `;
    container.appendChild(row);
  });
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'agora';
  if (m < 60)  return `${m}min atrás`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h atrás`;
  const d = Math.floor(h / 24);
  return `${d}d atrás`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LISTA DE PERFIS
// ═══════════════════════════════════════════════════════════════════════════
// ─── Overlay de detalhe do perfil ────────────────────────────────────────────
let _activeCardRef = null; // card cujo card-body foi movido para o overlay

function openCardDetail(card, profile) {
  const overlay  = document.getElementById('card-detail-overlay');
  const cdBody   = document.getElementById('cd-body');
  const cardBody = card.querySelector('.card-body');

  // Preenche o cabeçalho do overlay
  const score      = profile.pontuacao_icp || 0;
  const scoreColor = scoreToColor(score);
  const initial    = (profile.nome || profile.username || '?')[0].toUpperCase();

  document.getElementById('cd-avatar').textContent = initial;
  document.getElementById('cd-name').textContent   = profile.nome || profile.username;
  document.getElementById('cd-meta').textContent   = `@${profile.username} · ${profile.seguidores || ''} seguidores`;

  const scoreBadge = document.getElementById('cd-score');
  scoreBadge.textContent  = `${score}/10`;
  scoreBadge.style.cssText = `background:${scoreColor}22;color:${scoreColor};border:1px solid ${scoreColor}44`;

  // Move o card-body (com todos os event listeners) para o overlay
  if (_activeCardRef) closeCardDetail(); // fecha eventual anterior
  _activeCardRef = card;
  cdBody.appendChild(cardBody);

  overlay.classList.remove('hidden');
}

function closeCardDetail() {
  const overlay  = document.getElementById('card-detail-overlay');
  const cdBody   = document.getElementById('cd-body');

  if (_activeCardRef) {
    const cardBody = cdBody.querySelector('.card-body');
    if (cardBody) _activeCardRef.appendChild(cardBody);
    _activeCardRef = null;
  }

  overlay.classList.add('hidden');
}

function initList() {
  document.getElementById('card-detail-back').addEventListener('click', closeCardDetail);

  document.getElementById('btn-clear-all').addEventListener('click', async () => {
    if (!confirm('Limpar todos os perfis aprovados e o log?')) return;
    await sendToBg({ type: 'CLEAR_PROFILES' });
    await refreshList();
    clearLogUI();
    updateListBadge(0);
    document.getElementById('stat-processed').textContent = '0';
    document.getElementById('stat-approved').textContent  = '0';
    document.getElementById('stats-row').style.display = 'none';
  });
}

async function refreshList() {
  const res      = await sendToBg({ type: 'GET_PROFILES' });
  const profiles = res?.profiles || [];
  renderProfiles(profiles);
}

function renderProfiles(profiles) {
  const container = document.getElementById('profiles-list');
  const counter   = document.getElementById('list-counter');
  const notice    = document.getElementById('threshold-notice');

  if (profiles.length === 0) {
    container.innerHTML = '<div class="list-empty">Nenhum perfil aprovado ainda.<br>Inicie a prospecção na aba anterior.</div>';
    counter.textContent = 'Nenhum perfil aprovado ainda';
    notice.classList.add('hidden');
    return;
  }

  counter.textContent = `${profiles.length} perfil${profiles.length > 1 ? 's' : ''} aprovado${profiles.length > 1 ? 's' : ''}`;

  // Lê meta das settings para exibir aviso
  getSettings().then(cfg => {
    const meta = cfg.metaPerfis || 20;
    notice.classList.toggle('hidden', profiles.length >= meta);
    notice.querySelector('span') && (notice.querySelector('span').textContent =
      `Aguardando ${meta} perfis aprovados para habilitar ações em massa.`);
  });

  container.innerHTML = '';
  profiles.forEach(p => container.appendChild(buildProfileCard(p)));

  // Re-aplica gate de licença em botões recém-criados
  if (_lastLicenseStatus) applyLicenseGating(_lastLicenseStatus);
}

function buildProfileCard(profile) {
  const card = document.createElement('div');
  card.className = 'profile-card'; // não expanded por padrão
  card.dataset.username = profile.username;

  const score        = profile.pontuacao_icp || 0;
  const initial      = (profile.nome || profile.username || '?')[0].toUpperCase();
  const isSent       = profile.status === 'mensagem_enviada';
  const isCommented  = profile.status === 'comentario_enviado';
  const webhookSt    = profile.webhook_status; // 'enviado' | 'erro' | undefined
  const scoreColor = scoreToColor(score);
  const iceText    = (profile.mensagem_icebreaker || profile.mensagem_gerada || '').trim();
  const hookText   = (profile.mensagem_hook       || '').trim();
  const cmmText    = (profile.comentario_gerado   || '').trim();
  const just       = (profile.justificativa_icp || '').trim();
  const postUrl    = profile.url_post_recente || '';

  // Chevron SVG
  const chevron = `<svg class="card-chevron" width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
  </svg>`;

  card.innerHTML = `
    <div class="card-header">
      <div class="card-avatar">${initial}</div>
      <div class="card-info">
        <div class="card-name">${escHtml(profile.nome || profile.username)}</div>
        <div class="card-username">@${escHtml(profile.username)} · ${escHtml(profile.seguidores || '')} seguidores</div>
      </div>
      <span class="score-badge" style="background:${scoreColor}22;color:${scoreColor};border:1px solid ${scoreColor}44">
        ${score}/10
      </span>
      ${chevron}
    </div>

    <div class="card-body">
      ${just ? `
        <div class="card-section-label">Análise de fit</div>
        <div class="card-justification">${escHtml(just)}</div>
      ` : ''}

      ${iceText ? `
        <div class="card-section-label lbl-ice">💬 Quebra-Gelo</div>
        <div class="card-message collapsed card-icebreaker">${escHtml(iceText)}</div>
      ` : ''}

      ${hookText ? `
        <div class="card-section-label lbl-hook">🎯 Gancho</div>
        <div class="card-message collapsed card-hook">${escHtml(hookText)}</div>
      ` : ''}

      ${cmmText ? `
        <div class="card-section-label">Comentário no post</div>
        <div class="card-comment collapsed">${escHtml(cmmText)}</div>
      ` : ''}

      <div class="card-actions" style="margin-top:8px">
        <button class="btn btn-secondary btn-sm btn-view-profile">Ver Perfil</button>
        ${postUrl ? `<button class="btn btn-secondary btn-sm btn-view-post">Ver Post</button>` : ''}
      </div>

      <div class="card-actions">
        <button class="btn btn-primary btn-sm btn-send-dm" ${isSent ? 'disabled' : ''}>
          ${isSent ? 'DM Enviado' : 'Enviar DM'}
        </button>
        ${postUrl && cmmText ? `
          <button class="btn btn-secondary btn-sm btn-post-comment" ${isCommented ? 'disabled' : ''}>
            ${isCommented ? 'Comentado' : 'Comentar Post'}
          </button>
        ` : ''}
      </div>

      <div class="card-actions">
        <button class="btn btn-secondary btn-sm btn-webhook ${webhookSt === 'enviado' ? 'disabled' : ''}"
                ${webhookSt === 'enviado' ? 'disabled' : ''}>
          ${webhookSt === 'enviado' ? checkIcon() + ' Webhook Enviado' : webhookSt === 'erro' ? '↺ Reenviar Webhook' : '↑ Enviar para Webhook'}
        </button>
      </div>

      <div class="status-row">
        <span class="status-badge ${isSent ? 'sent' : 'waiting'} status-badge-dm">
          ${isSent ? checkIcon() + ' DM Enviado' : 'DM pendente'}
        </span>
        ${postUrl && cmmText ? `
          <span class="status-badge ${isCommented ? 'commented' : 'waiting'} status-badge-comment">
            ${isCommented ? checkIcon() + ' Comentado' : 'Comentário pendente'}
          </span>
        ` : ''}
        <span class="status-badge ${webhookSt === 'enviado' ? 'webhook-ok' : webhookSt === 'erro' ? 'webhook-error' : 'webhook-wait'} status-badge-webhook"
              title="${webhookSt === 'erro' ? escHtml(profile.webhook_error || '') : ''}">
          ${webhookSt === 'enviado' ? checkIcon() + ' Webhook OK' : webhookSt === 'erro' ? '⚠ Webhook falhou' : 'Webhook pendente'}
        </span>
      </div>
    </div>
  `;

  // ── Armazena referência do perfil para o overlay ──────────────
  card._profile = profile;

  // ── Clique no header: abre o overlay de detalhe ───────────────
  card.querySelector('.card-header').addEventListener('click', () => {
    openCardDetail(card, profile);
  });

  // ── Expandir mensagens ao clicar nelas ───────────────────────
  card.querySelectorAll('.card-message').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      e.currentTarget.classList.toggle('collapsed');
    });
  });
  card.querySelector('.card-comment')?.addEventListener('click', e => {
    e.stopPropagation();
    e.currentTarget.classList.toggle('collapsed');
  });

  // ── Ver perfil ────────────────────────────────────────────────
  card.querySelector('.btn-view-profile')?.addEventListener('click', e => {
    e.stopPropagation();
    chrome.tabs.create({ url: profile.url_perfil });
  });

  // ── Ver post recente ──────────────────────────────────────────
  card.querySelector('.btn-view-post')?.addEventListener('click', e => {
    e.stopPropagation();
    chrome.tabs.create({ url: postUrl });
  });

  // ── Enviar DM ─────────────────────────────────────────────────
  card.querySelector('.btn-send-dm')?.addEventListener('click', async e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    const res = await sendToBg({
      type:     'SEND_DM',
      username: profile.username,
      message:  profile.mensagem_icebreaker || profile.mensagem_gerada || '',
    });
    if (res?.ok === false) {
      if (res.error === 'license_required') { onLicenseDeniedDuringAction(res.license_status); btn.disabled = false; btn.textContent = 'Enviar DM'; return; }
      btn.disabled = false;
      btn.textContent = 'Enviar DM';
      showError(res.error || 'Erro ao enviar DM');
    }
  });

  // ── Enviar para Webhook ───────────────────────────────────────
  card.querySelector('.btn-webhook')?.addEventListener('click', async e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    const res = await sendToBg({ type: 'SEND_WEBHOOK', username: profile.username });
    if (res?.ok === false) {
      if (res.error === 'license_required') { onLicenseDeniedDuringAction(res.license_status); btn.disabled = false; btn.textContent = '↺ Reenviar Webhook'; return; }
      btn.disabled = false;
      btn.textContent = '↺ Reenviar Webhook';
      showError(res.error || 'Erro ao enviar para o Webhook');
    }
  });

  // ── Comentar post recente ─────────────────────────────────────
  card.querySelector('.btn-post-comment')?.addEventListener('click', async e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Comentando…';
    const res = await sendToBg({
      type:     'POST_COMMENT',
      username: profile.username,
      postUrl:  postUrl,
      comment:  profile.comentario_gerado || '',
    });
    if (res?.ok === false) {
      if (res.error === 'license_required') { onLicenseDeniedDuringAction(res.license_status); btn.disabled = false; btn.textContent = 'Comentar Post'; return; }
      btn.disabled = false;
      btn.textContent = 'Comentar Post';
      showError(res.error || 'Erro ao postar comentário');
    }
  });

  return card;
}

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS DE UI
// ═══════════════════════════════════════════════════════════════════════════

function addLogEntry(e = {}, scroll = true) {
  const { action = 'info', username, pontuacao, error, pausaSeg } = e;
  let { message = '' } = e;

  // Reconstrói mensagem quando carregada do storage (não tem campo message)
  if (!message) {
    switch (action) {
      case 'evaluating':  message = username ? `Avaliando @${username}…` : '…'; break;
      case 'approved':    message = `@${username} — ${pontuacao}/10 — Aprovado ✓`; break;
      case 'rejected':    message = `@${username} — ${pontuacao}/10 — Descartado`; break;
      case 'idioma_ignorado':  message = `@${username} — idioma ignorado (${e.idioma || '?'})`; break;
      case 'collection_done': message = `Prospecção encerrada: sem mais perfis na hashtag. ${e.approved || 0} aprovados.`; break;
      case 'complete':    message = `Meta atingida! Prospecção encerrada.`; break;
      case 'stopped':     message = 'Prospecção interrompida pelo usuário.'; break;
      case 'long_pause':  message = pausaSeg ? `⏸ Pausa longa: ${pausaSeg}s (anti-detecção)` : '⏸ Pausa longa…'; break;
      case 'error':       message = `Erro em @${username || '?'}: ${error || ''}`; break;
      default:            message = action;
    }
  }

  const logArea = document.getElementById('log-area');
  const empty   = logArea.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = `log-entry ${action}`;
  entry.innerHTML = `<span class="log-dot"></span><span>${escHtml(message)}</span>`;
  logArea.appendChild(entry);

  if (scroll) scrollLogToBottom();
}

function scrollLogToBottom() {
  const logArea = document.getElementById('log-area');
  logArea.scrollTop = logArea.scrollHeight;
}

function clearLogUI() {
  document.getElementById('log-area').innerHTML =
    '<div class="log-empty">Inicie a prospecção para ver o progresso aqui.</div>';
}

function showStatsRow() {
  document.getElementById('stats-row').style.display = 'flex';
}

function showLogHeader() {
  document.getElementById('log-header').style.display = 'flex';
}

function updateStatsUI(processed, approved) {
  document.getElementById('stat-processed').textContent = processed;
  document.getElementById('stat-approved').textContent  = approved;
  const pct = Math.min(100, Math.round((approved / 20) * 100));
  document.getElementById('progress-bar').style.width = `${pct}%`;
}

function updateListBadge(count) {
  const badge = document.getElementById('list-badge');
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

function resetProspectingButtons() {
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').classList.add('hidden');
}

function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

function showToast(id, message, type = 'success') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.className = `toast ${type}`;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ═══════════════════════════════════════════════════════════════════════════
//  LICENÇA — UI da aba + gating
// ═══════════════════════════════════════════════════════════════════════════

let _lastLicenseStatus = null;
let _countdownInterval = null;

function initLicense() {
  // Input com auto-format
  const input = document.getElementById('lic-input');
  input?.addEventListener('input', e => {
    const norm = normalizeKey(e.target.value);
    if (norm !== e.target.value) e.target.value = norm;
  });
  input?.addEventListener('paste', e => {
    setTimeout(() => { e.target.value = normalizeKey(e.target.value); }, 0);
  });

  document.getElementById('btn-lic-activate')?.addEventListener('click', activateLicense);
  document.getElementById('btn-lic-revalidate')?.addEventListener('click', () => refreshLicenseUI({ force: true, toast: 'Revalidando…' }));
  document.getElementById('btn-lic-retry-net')?.addEventListener('click', () => refreshLicenseUI({ force: true }));
  document.getElementById('btn-lic-retry-srv')?.addEventListener('click', () => refreshLicenseUI({ force: true }));

  const changeButtons = ['btn-lic-change', 'btn-lic-change-2', 'btn-lic-change-3', 'btn-lic-change-4'];
  changeButtons.forEach(id => {
    document.getElementById(id)?.addEventListener('click', async () => {
      if (!confirm('Trocar a chave de licença? A chave atual será removida deste dispositivo.')) return;
      await clearLicense();
      await refreshLicenseUI({ silent: true });
      switchTab('license');
    });
  });
}

async function activateLicense() {
  const input    = document.getElementById('lic-input');
  const btn      = document.getElementById('btn-lic-activate');
  const hint     = document.getElementById('lic-input-hint');
  const rawValue = input.value.trim();
  const norm     = normalizeKey(rawValue);

  hint.textContent = '';
  hint.classList.remove('error');

  if (!isKeyFormatValid(norm)) {
    hint.textContent = 'Formato inválido. Use ISI-XXXX-XXXX-XXXX-XXXX';
    hint.classList.add('error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Validando…';

  try {
    await saveLicenseKey(norm);
  } catch (_) {
    hint.textContent = 'Formato inválido.';
    hint.classList.add('error');
    btn.disabled = false;
    btn.textContent = 'Ativar';
    return;
  }

  const result = await validateLicense({ force: true });
  renderLicenseScreen(result);
  applyLicenseGating(result);

  btn.disabled = false;
  btn.textContent = 'Ativar';
  input.value = '';
}

async function refreshLicenseUI({ force = false, silent = false, toast = null } = {}) {
  if (toast) showToast('license-toast', toast, 'success');

  let result;
  if (force) {
    result = await validateLicense({ force: true });
  } else if (silent) {
    // Lê cache primeiro pra pintar UI rapidamente, depois bate no servidor em background
    const cached = await getCurrentStatus();
    renderLicenseScreen(cached);
    applyLicenseGating(cached);
    result = await validateLicense({ silent: true });
  } else {
    result = await validateLicense({});
  }

  renderLicenseScreen(result);
  applyLicenseGating(result);
  return result;
}

function renderLicenseScreen(result) {
  _lastLicenseStatus = result;
  if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null; }

  const status = result?.status || 'no_key';
  const ids = ['no_key', 'valid', 'expired', 'blocked', 'invalid', 'rate_limited', 'network_error', 'server_error'];

  // hwid_mismatch e unknown caem no fluxo invalid
  let screenKey = status;
  if (status === 'hwid_mismatch') screenKey = 'invalid';
  if (status === 'unknown')       screenKey = 'no_key';
  if (!ids.includes(screenKey))   screenKey = 'invalid';

  ids.forEach(id => {
    const el = document.getElementById(`lic-screen-${id}`);
    if (el) el.classList.toggle('hidden', id !== screenKey);
  });

  // Detalhes específicos por tela
  if (screenKey === 'valid' && result.expires_at) {
    document.getElementById('lic-expires').textContent =
      'Expira em ' + formatDateBR(result.expires_at);
  }

  if (screenKey === 'expired' && result.expires_at) {
    document.getElementById('lic-expired-text').textContent =
      `Sua licença expirou em ${formatDateBR(result.expires_at)}. Renove pra continuar usando.`;
  }

  // URLs dinâmicas (subscription_url / support_url) — escondem botão se null/undefined
  const renewBtn = document.getElementById('btn-lic-renew');
  if (renewBtn) {
    const url = result?.subscription_url ?? null;
    if (url) {
      renewBtn.classList.remove('hidden');
      renewBtn.onclick = () => chrome.tabs.create({ url });
    } else {
      renewBtn.classList.add('hidden');
    }
  }

  const supportBtn = document.getElementById('btn-lic-support');
  if (supportBtn) {
    const url = result?.support_url ?? null;
    if (url) {
      supportBtn.classList.remove('hidden');
      supportBtn.onclick = () => chrome.tabs.create({ url });
    } else {
      supportBtn.classList.add('hidden');
    }
  }

  // Countdown pra rate_limited
  if (screenKey === 'rate_limited') {
    const secs = Math.max(1, parseInt(result.retry_after_s || 60, 10));
    let remaining = secs;
    const span = document.getElementById('lic-countdown');
    if (span) span.textContent = remaining;
    _countdownInterval = setInterval(() => {
      remaining -= 1;
      if (span) span.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(_countdownInterval);
        _countdownInterval = null;
        refreshLicenseUI({ force: true });
      }
    }, 1000);
  }
}

// Aplica/remove o gate visual nas outras abas
function applyLicenseGating(result) {
  const valid = result?.status === 'valid';
  const banner = document.getElementById('lic-banner');
  const actionButtons = [
    'btn-start', 'btn-start-list',
    'btn-export-settings', 'btn-export-blacklist', 'btn-export-graylist',
    'btn-save-settings', 'btn-save-messages',
  ];

  if (valid) {
    banner?.classList.add('hidden');
    actionButtons.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.remove('disabled-license');
    });
    document.querySelectorAll('.btn-send-dm, .btn-post-comment, .btn-webhook, .btn-clear-all, .btn-clear-history').forEach(b => b.classList.remove('disabled-license'));
  } else {
    banner?.classList.remove('hidden');
    actionButtons.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.add('disabled-license');
    });
    document.querySelectorAll('.btn-send-dm, .btn-post-comment, .btn-webhook').forEach(b => b.classList.add('disabled-license'));

    // Se está na primeira vez sem chave OU acabou de invalidar, vai pra aba Licença
    const onLicenseTab = document.getElementById('tab-license')?.classList.contains('active');
    if (!onLicenseTab && result?.status && result.status !== 'unknown') {
      switchTab('license');
    }
  }
}

// Chamado quando uma ação retorna license_required do background
function onLicenseDeniedDuringAction(statusFromBg) {
  refreshLicenseUI({ force: true }).then(result => {
    // Se a UI já mostra o motivo, ótimo. Senão, força ir pra aba Licença.
    switchTab('license');
  });
}

function formatDateBR(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (_) { return iso; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  UTILITÁRIOS
// ═══════════════════════════════════════════════════════════════════════════

function sendToBg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, response => {
      resolve(response || {});
    });
  });
}

function val(id) {
  return (document.getElementById(id)?.value || '').trim();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function scoreToColor(score) {
  if (score >= 9) return '#10b981'; // emerald
  if (score >= 7) return '#22c55e'; // green
  if (score >= 5) return '#f59e0b'; // amber
  return '#ef4444';                 // red
}
