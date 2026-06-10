// popup.js — Controlador do popup (ES Module)

import { getSettings, saveSettings, getStats, getLog, clearLog, getHistory, clearHistory, getBlacklist, saveBlacklist, getGraylist, saveGraylist } from './db.js';
import {
  validateLicense, gateAction, normalizeKey, isKeyFormatValid,
  saveLicenseKey, clearLicense, getCurrentStatus,
} from './sync.js';
import { updateKanbanBadge } from './kanbanUI.js';

// ─── Inicialização ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  await loadSettings();
  await restoreState();
  initForms();
  initBackup();
  initProspecting();
  initList();
  initBulkActions();
  initHistory();
  initKanbanLauncher();
  initLicense();
  listenForProgress();
  updateKanbanBadge();

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
  if (name === 'list')     { refreshList(); updateKanbanBadge(); }
  if (name === 'history')  refreshHistory();
}

// ─── Kanban launcher (abre a UI completa em nova aba do navegador) ───────
function initKanbanLauncher() {
  document.getElementById('btn-open-kanban')?.addEventListener('click', openKanbanPage);
}

function openKanbanPage() {
  const url = chrome.runtime.getURL('kanban.html');
  // Reaproveita aba existente se já estiver aberta
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows?.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIGURAÇÕES
// ═══════════════════════════════════════════════════════════════════════════
async function loadSettings() {
  const cfg = await getSettings();
  [
    // Mensagens
    'icp', 'produto', 'instrucaoAbordagem', 'openaiKey', 'promptIcebreaker', 'promptHook',
    // Webhook
    'webhookEndpoint', 'webhookApiKey', 'webhookFunnel', 'webhookStage', 'webhookTags',
    // Avançado (anti-detecção)
    'delayMinPerfil', 'delayMaxPerfil', 'pausaMinGrupo', 'pausaMaxGrupo', 'tamanhoGrupo',
    // Fontes de busca
    'fonteHashtagLista', 'fonteSeguidoresPerfil', 'fonteEngajamentoPerfil', 'fonteEngajamentoNPosts', 'fontePalavrasChaveLista',
    // Filtros pré-qualificação
    'filtroSeguidoresMin', 'filtroSeguidoresMax', 'filtroKeywords',
    'filtroUltimoPostDias', 'filtroPostsMin', 'filtroPostsDias', 'filtroEngajamentoMin',
    // Meta da sessão
    'metaLeads',
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el && cfg[id] !== undefined) el.value = cfg[id];
  });

  // Checkboxes
  [
    ['webhookAuto',             cfg.webhookAuto],
    ['fonteHashtagAtiva',       cfg.fonteHashtagAtiva !== false],   // default true
    ['fonteSeguidoresAtiva',    cfg.fonteSeguidoresAtiva],
    ['fonteEngajamentoAtiva',   cfg.fonteEngajamentoAtiva],
    ['fontePalavrasChaveAtiva', cfg.fontePalavrasChaveAtiva],
    ['extrairContatos',         cfg.extrairContatos],
  ].forEach(([id, v]) => {
    const cb = document.getElementById(id);
    if (cb) cb.checked = !!v;
  });

  // Migração silenciosa: se 'hashtags' antigo tem valor mas fonteHashtagLista está vazio, herda
  const hlNew = document.getElementById('fonteHashtagLista');
  if (hlNew && !hlNew.value && cfg.hashtags) hlNew.value = cfg.hashtags;

  // Cacheia meta de leads — usado pela stats-row pra mostrar progresso
  _metaCached = Number(cfg.metaLeads) || null;
}

function initForms() {
  document.getElementById('search-form')?.addEventListener('submit', e => {
    e.preventDefault();
    saveSearchSettings();
  });
  document.getElementById('messages-form')?.addEventListener('submit', e => {
    e.preventDefault();
    saveMessagesSettings();
  });
  document.getElementById('webhook-form')?.addEventListener('submit', e => {
    e.preventDefault();
    saveWebhookSettings();
  });
  document.getElementById('settings-form')?.addEventListener('submit', e => {
    e.preventDefault();
    saveAdvancedSettings();
  });
}

// Cada save lê o cfg completo, sobrescreve só os campos da própria aba, e salva.
// Preserva os outros campos mesmo que o usuário tenha mudado entre abas sem salvar.

async function saveSearchSettings() {
  const cfg = await getSettings();
  cfg.fonteHashtagAtiva       = document.getElementById('fonteHashtagAtiva')?.checked ?? true;
  cfg.fonteHashtagLista       = val('fonteHashtagLista');
  cfg.fonteSeguidoresAtiva    = document.getElementById('fonteSeguidoresAtiva')?.checked || false;
  cfg.fonteSeguidoresPerfil   = val('fonteSeguidoresPerfil').replace(/^@/, '');
  cfg.fonteEngajamentoAtiva   = document.getElementById('fonteEngajamentoAtiva')?.checked || false;
  cfg.fonteEngajamentoPerfil  = val('fonteEngajamentoPerfil').replace(/^@/, '');
  cfg.fonteEngajamentoNPosts  = Number(val('fonteEngajamentoNPosts')) || 12;
  cfg.fontePalavrasChaveAtiva = document.getElementById('fontePalavrasChaveAtiva')?.checked || false;
  cfg.fontePalavrasChaveLista = val('fontePalavrasChaveLista');
  cfg.filtroSeguidoresMin     = val('filtroSeguidoresMin');
  cfg.filtroSeguidoresMax     = val('filtroSeguidoresMax');
  cfg.filtroKeywords          = val('filtroKeywords');
  cfg.filtroUltimoPostDias    = val('filtroUltimoPostDias');
  cfg.filtroPostsMin          = val('filtroPostsMin');
  cfg.filtroPostsDias         = val('filtroPostsDias');
  cfg.filtroEngajamentoMin    = val('filtroEngajamentoMin');
  cfg.metaLeads               = val('metaLeads');
  _metaCached                 = Number(cfg.metaLeads) || null;
  await saveSettings(cfg);
  showToast('search-toast', 'Configurações de busca salvas!', 'success');
}

async function saveMessagesSettings() {
  const cfg = await getSettings();
  cfg.icp                = val('icp');
  cfg.produto            = val('produto');
  cfg.instrucaoAbordagem = val('instrucaoAbordagem');
  cfg.openaiKey          = val('openaiKey');
  cfg.promptIcebreaker   = val('promptIcebreaker');
  cfg.promptHook         = val('promptHook');
  await saveSettings(cfg);
  showToast('messages-toast', 'Mensagens salvas!', 'success');
  // Atualiza o estado do bulk-generate (pode ter ativado/desativado a key OpenAI)
  if (document.getElementById('tab-list')?.classList.contains('active')) refreshList();
}

async function saveWebhookSettings() {
  const cfg = await getSettings();
  cfg.webhookEndpoint = val('webhookEndpoint');
  cfg.webhookApiKey   = val('webhookApiKey');
  cfg.webhookFunnel   = val('webhookFunnel');
  cfg.webhookStage    = val('webhookStage');
  cfg.webhookTags     = val('webhookTags');
  cfg.webhookAuto     = document.getElementById('webhookAuto')?.checked || false;
  await saveSettings(cfg);
  showToast('webhook-toast', 'Webhook salvo!', 'success');
}

async function saveAdvancedSettings() {
  const cfg = await getSettings();
  cfg.delayMinPerfil   = Number(val('delayMinPerfil')) || 3;
  cfg.delayMaxPerfil   = Number(val('delayMaxPerfil')) || 7;
  cfg.pausaMinGrupo    = Number(val('pausaMinGrupo'))  || 30;
  cfg.pausaMaxGrupo    = Number(val('pausaMaxGrupo'))  || 90;
  cfg.tamanhoGrupo     = Number(val('tamanhoGrupo'))   || 10;
  cfg.extrairContatos  = document.getElementById('extrairContatos')?.checked || false;
  await saveSettings(cfg);
  showToast('settings-toast', 'Configurações avançadas salvas!', 'success');
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
  hideBlockBanner();
  hideBlockDefinitiveBanner();

  // Validação client-side antes de mandar pro bg (UX mais rápido)
  const validationError = await validateSearchConfig();
  if (validationError) {
    showError(validationError);
    btnStart.disabled = false;
    return;
  }

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
  showCollectionBanner();
  clearLogUI();
}

// Valida configuração de busca client-side antes de iniciar.
// Retorna null se OK ou string de erro pra mostrar no banner.
async function validateSearchConfig() {
  const cfg = await getSettings();
  const errors = [];
  const handleRe = /^[a-zA-Z0-9._]{1,30}$/;
  let anyActive = false;

  if (cfg.fonteHashtagAtiva !== false && cfg.fonteHashtagLista?.trim()) {
    anyActive = true;
  }

  if (cfg.fonteSeguidoresAtiva) {
    const perfil = (cfg.fonteSeguidoresPerfil || '').trim().replace(/^@/, '');
    if (!perfil) errors.push('Fonte "Seguidores": preencha o @perfil');
    else if (!handleRe.test(perfil)) errors.push(`Fonte "Seguidores": "${perfil}" não é um username válido do Instagram`);
    else anyActive = true;
  }

  if (cfg.fonteEngajamentoAtiva) {
    const perfil = (cfg.fonteEngajamentoPerfil || '').trim().replace(/^@/, '');
    const nPosts = Number(cfg.fonteEngajamentoNPosts) || 12;
    if (!perfil) errors.push('Fonte "Engajamento": preencha o @perfil');
    else if (!handleRe.test(perfil)) errors.push(`Fonte "Engajamento": "${perfil}" não é um username válido`);
    else if (nPosts < 1 || nPosts > 12) errors.push('Fonte "Engajamento": N posts deve estar entre 1 e 12');
    else anyActive = true;
  }

  if (cfg.fontePalavrasChaveAtiva) {
    const keywords = (cfg.fontePalavrasChaveLista || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!keywords.length) errors.push('Fonte "Palavras-chave": preencha ao menos 1 termo');
    else anyActive = true;
  }

  if (!anyActive && !errors.length) {
    errors.push('Configure ao menos uma fonte de busca na aba Busca');
  }

  return errors.length ? errors.join(' · ') : null;
}

async function stopProspecting() {
  const btnStart = document.getElementById('btn-start');
  const btnStop  = document.getElementById('btn-stop');

  await sendToBg({ type: 'STOP_PROSPECTING' });

  btnStop.classList.add('hidden');
  btnStart.classList.remove('hidden');
  btnStart.disabled = false;
  hideCollectionBanner();

  addLogEntry({ action: 'stopped', message: 'Prospecção interrompida pelo usuário.' });
}

// ─── Restaura estado ao abrir o popup ────────────────────────────────────
async function restoreState() {
  const [stats, log] = await Promise.all([getStats(), getLog()]);

  if (stats.approved > 0 || stats.processed > 0) {
    showStatsRow();
    showLogHeader();
    updateStatsUI({
      processed:   stats.processed,
      approved:    stats.approved,
      descartados: stats.descartados_local,
      mensagens:   stats.mensagens_geradas,
      meta:        _metaCached,
    });
  }

  // Verifica com o background o estado real (active / blocked / blockedDefinitive / zumbi)
  const check = await sendToBg({ type: 'CHECK_ACTIVE' });
  if (check?.blocked && check?.until) {
    // Pausa em curso por bloqueio do IG — mostra countdown
    showBlockBanner('Coleta pausada pelo bloqueio anti-bot do Instagram. Retomando automaticamente.', check.until);
  } else if (check?.blockedDefinitive) {
    showBlockDefinitiveBanner(`Instagram bloqueou 2x nesta sessão. Aguarde e clique em "Reiniciar Coleta".`);
  } else if (check?.active) {
    document.getElementById('btn-start').classList.add('hidden');
    document.getElementById('btn-stop').classList.remove('hidden');
    showCollectionBanner();
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
    if (msg.type === 'PROGRESS')              handleProgress(msg);
    if (msg.type === 'DM_SENT')               handleDmSent(msg.username);
    if (msg.type === 'COMMENT_POSTED')        handleCommentPosted(msg.username);
    if (msg.type === 'WEBHOOK_SENT')          handleWebhookSent(msg.username);
    if (msg.type === 'WEBHOOK_ERROR')         handleWebhookError(msg.username, msg.error);
    if (msg.type === 'LICENSE_REVOKED')       handleLicenseRevoked(msg.license_status);
    if (msg.type === 'IG_BLOCK_PAUSED')       handleBlockPaused(msg);
    if (msg.type === 'IG_BLOCK_DEFINITIVE')   handleBlockDefinitive(msg);
    if (msg.type === 'IG_BLOCK_RESUMED')      handleBlockResumed();
    if (msg.type === 'GOAL_REACHED')          handleGoalReached(msg);
    if (msg.type === 'MESSAGES_GENERATING')   handleMessagesGenerating(msg.username);
    if (msg.type === 'MESSAGES_GENERATED')    handleMessagesGenerated(msg.username);
    if (msg.type === 'MESSAGES_FAILED')       handleMessagesFailed(msg.username, msg.error);
  });
}

// ─── Handlers dos novos eventos ───────────────────────────────────────────
function handleBlockPaused({ message, until, pause_min }) {
  const dur = pause_min ? `${pause_min}min` : 'pausa anti-detecção';
  showBlockBanner(message || `Coleta pausada (${dur}).`, until);
  resetProspectingButtons();
}

function handleBlockDefinitive({ message }) {
  showBlockDefinitiveBanner(message || 'Instagram bloqueou 2x — pausa definitiva.');
  resetProspectingButtons();
}

function handleBlockResumed() {
  hideBlockBanner();
  showCollectionBanner();
  document.getElementById('btn-start').classList.add('hidden');
  document.getElementById('btn-stop').classList.remove('hidden');
}

function handleGoalReached({ meta, approved }) {
  hideCollectionBanner();
  hideBlockBanner();
  hideBlockDefinitiveBanner();
  resetProspectingButtons();
  addLogEntry({
    action:  'complete',
    message: `🎯 Meta atingida: ${approved}/${meta} aprovados. Coleta encerrada.`,
  });
  refreshList();
}

function handleMessagesGenerating(username) {
  // Apenas visual — o card fica num estado "gerando" via PROGRESS log
}

function handleMessagesGenerated(username) {
  // Re-renderiza pra mostrar as novas mensagens no card
  if (document.getElementById('tab-list')?.classList.contains('active')) refreshList();
}

function handleMessagesFailed(username, error) {
  showError(`Falha ao gerar mensagens para @${username}: ${error}`);
}

function handleLicenseRevoked(status) {
  resetProspectingButtons();
  addLogEntry({ action: 'error', message: 'Licença revogada — prospecção interrompida.' });
  refreshLicenseUI({ silent: true });
  switchTab('license');
}

function handleProgress(msg) {
  const { action, username, pontuacao, score, processed, approved, error, reason } = msg;

  // Atualiza contadores (a partir das stats spreadadas na msg pelo bg)
  if (processed !== undefined) {
    updateStatsUI({
      processed,
      approved:    approved || 0,
      descartados: msg.descartados_local,
      mensagens:   msg.mensagens_geradas,
      meta:        _metaCached,
    });
  }

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
      if (document.getElementById('tab-history')?.classList.contains('active')) refreshHistory();
      break;

    case 'local_approved':
      addLogEntry({
        action: 'local_approved',
        message: `@${username} — score ${score}/10 — Aprovado pelos filtros ✓`,
      });
      updateListBadge(approved);
      if (document.getElementById('tab-history')?.classList.contains('active')) refreshHistory();
      if (document.getElementById('tab-list')?.classList.contains('active')) refreshList();
      break;

    case 'filter_reject':
      addLogEntry({
        action: 'filter_reject',
        message: `@${username} — descartado: ${filterReasonLabel(reason, msg.detail)}`,
      });
      if (document.getElementById('tab-history')?.classList.contains('active')) refreshHistory();
      break;

    case 'rejected':
      addLogEntry({
        action: 'rejected',
        message: `@${username} — ${pontuacao}/10 — Descartado`,
      });
      if (document.getElementById('tab-history')?.classList.contains('active')) refreshHistory();
      break;

    case 'hashtag_start':
      addLogEntry({
        action: 'hashtag_start',
        message: `▶ Iniciando #${msg.hashtag} (${msg.idx}/${msg.total})`,
      });
      showCollectionBanner();
      break;

    case 'hashtag_done':
      addLogEntry({
        action: 'hashtag_done',
        message: `✓ #${msg.hashtag} concluída${msg.next ? `. Próxima: #${msg.next}` : ''}`,
      });
      break;

    case 'source_start':
      addLogEntry({
        action: 'hashtag_start',
        message: sourceStartLabel(msg),
      });
      showCollectionBanner();
      break;

    case 'source_done':
      addLogEntry({
        action: 'hashtag_done',
        message: sourceDoneLabel(msg),
      });
      break;

    case 'ig_block_paused':
      addLogEntry({
        action: 'ig_block_paused',
        reason:    msg.reason,
        until:     msg.until,
        pause_min: msg.pause_min,
        message:   msg.message,
      });
      break;

    case 'ig_block_definitive':
      addLogEntry({
        action: 'ig_block_definitive',
        message: `🛑 Bloqueio definitivo (2x): ${msg.message || reason}. Reinicie manualmente.`,
      });
      break;

    case 'ig_block_resumed':
      addLogEntry({
        action: 'ig_block_resumed',
        message: '▶ Coleta retomada após pausa de bloqueio',
      });
      break;

    case 'complete':
      addLogEntry({
        action: 'complete',
        message: `Meta atingida! ${approved} perfis aprovados. Prospecção encerrada.`,
      });
      resetProspectingButtons();
      hideCollectionBanner();
      break;

    case 'stopped':
      resetProspectingButtons();
      hideCollectionBanner();
      break;

    case 'long_pause':
      addLogEntry({
        action: 'long_pause',
        pausaSeg: msg.pausaSeg,
        until:    msg.until,
        kind:     msg.kind,
      });
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
      addLogEntry({ action: 'collection_done', message: `Prospecção encerrada. ${msg.approved || 0} aprovados.` });
      resetProspectingButtons();
      hideCollectionBanner();
      break;

    case 'goal_reached':
      addLogEntry({
        action: 'complete',
        message: `🎯 Meta atingida: ${msg.approved}/${msg.meta} aprovados. Coleta encerrada.`,
      });
      break;

    case 'collection_error':
      showError(error || 'Erro na coleta de dados');
      resetProspectingButtons();
      hideCollectionBanner();
      break;
  }
}

// Mensagem de início de source (engajamento, seguidores, palavras-chave, etc)
function sourceStartLabel(e) {
  if (e.source === 'seguidores')     return `▶ Coletando seguidores de @${e.perfil}`;
  if (e.source === 'engajamento')    return `▶ Coletando engajadores dos últimos ${e.nPosts || 12} posts de @${e.perfil}`;
  if (e.source === 'palavras_chave') return `▶ Buscando perfis por palavras-chave: ${(e.keywords || []).join(', ')}`;
  return `▶ Iniciando fonte: ${e.source}`;
}

function sourceDoneLabel(e) {
  if (e.source === 'seguidores')     return `✓ Seguidores de @${e.perfil || ''} concluídos`;
  if (e.source === 'engajamento')    return `✓ Engajadores de @${e.perfil || ''} concluídos`;
  if (e.source === 'palavras_chave') return `✓ Palavras-chave concluídas (${(e.keywords || []).length} termos)`;
  return `✓ Fonte ${e.source} concluída`;
}

// Tradução amigável de motivos de descarte de filtro — usa detail quando disponível
function filterReasonLabel(reason, detail) {
  if (detail) {
    switch (reason) {
      case 'seguidores_min':
        return `seguidores ${fmtNumber(detail.actual)} < mín ${fmtNumber(detail.threshold)}`;
      case 'seguidores_max':
        return `seguidores ${fmtNumber(detail.actual)} > máx ${fmtNumber(detail.threshold)}`;
      case 'keyword':
        return `nenhuma palavra-chave (${(detail.keywords || []).join(', ')}) no nome/@/bio`;
      case 'ultimo_post':
        return `última publicação há ${detail.actual}d > limite ${detail.threshold}d`;
      case 'frequencia':
        return `${detail.actual} posts em ${detail.dias}d < mín ${detail.threshold}`;
      case 'engajamento':
        return `engajamento ${(detail.actual ?? 0).toFixed(2)}% < mín ${detail.threshold}%`;
    }
  }
  // Fallback simples (sem detail)
  const fallback = {
    seguidores_min: 'menos seguidores que o mínimo',
    seguidores_max: 'mais seguidores que o máximo',
    keyword:        'sem palavra-chave no nome/@/bio',
    ultimo_post:    'última publicação muito antiga',
    frequencia:     'poucos posts no período',
    engajamento:    'engajamento abaixo do mínimo',
  };
  return fallback[reason] || reason || 'motivo desconhecido';
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
    if (!confirm('Limpar todo o histórico de perfis analisados?\n\nNão afeta os perfis aprovados nem os que estão no Kanban.')) return;
    await clearHistory();
    refreshHistory();
  });

  document.getElementById('btn-export-history')?.addEventListener('click', exportHistoryCsv);

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

async function exportHistoryCsv() {
  if (!await gateAction()) { onLicenseDeniedDuringAction(); return; }
  const history = await getHistory();
  if (!history.length) {
    showToast('license-toast', 'Histórico vazio — nada pra exportar', 'error');
    return;
  }

  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = ['data', 'username', 'nome', 'seguidores', 'pontuacao', 'resultado', 'motivo', 'detalhe'];
  const rows = history.map(h => [
    new Date(h.ts || Date.now()).toISOString(),
    h.username || '',
    h.nome || '',
    h.seguidores || '',
    h.pontuacao ?? '',
    h.resultado || '',
    h.motivo || '',
    h.motivo_detail ? JSON.stringify(h.motivo_detail) : '',
  ].map(esc).join(','));

  const csv = [header.join(','), ...rows].join('\n');
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(csv, `isihunter-historico-${stamp}.csv`, 'text/csv');
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

    // Motivo do descarte (perfis descartados) — usa motivo + motivo_detail salvos no histórico
    const motivoLine = entry.resultado === 'descartado' && entry.motivo
      ? `<div class="history-motivo">↳ ${escHtml(filterReasonLabel(entry.motivo, entry.motivo_detail))}</div>`
      : '';

    row.innerHTML = `
      <div class="history-result">${entry.resultado === 'aprovado' ? '✓' : '✕'}</div>
      <div class="history-info">
        <div class="history-name">@${escHtml(entry.username)}${entry.nome && entry.nome !== entry.username ? ` · ${escHtml(entry.nome)}` : ''}</div>
        <div class="history-meta">${escHtml(entry.seguidores || '')} seguidores · ${timeAgo}</div>
        ${motivoLine}
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
  const score      = profile.score_local ?? profile.pontuacao_icp ?? 0;
  const scoreColor = scoreToColor(score);
  const initial    = (profile.nome || profile.username || '?')[0].toUpperCase();

  const cdAvatar = document.getElementById('cd-avatar');
  const cdPic = profile.profile_pic_data || profile.profile_pic_url;
  if (cdPic) {
    cdAvatar.innerHTML = `<img src="${escHtml(cdPic)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.textContent='${escHtml(initial)}'">`;
  } else {
    cdAvatar.textContent = initial;
  }
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

let _listSortBy = 'score-desc';
let _listFilter = 'all';

function initListToolbar() {
  document.querySelectorAll('[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-sort]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _listSortBy = btn.dataset.sort;
      refreshList();
    });
  });
  document.querySelectorAll('[data-list-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-list-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _listFilter = btn.dataset.listFilter;
      refreshList();
    });
  });
}

function applyListSortAndFilter(profiles) {
  // Filtro
  let filtered = profiles;
  if (_listFilter === 'with-msgs') {
    filtered = profiles.filter(p => p.mensagem_icebreaker && p.mensagem_hook);
  } else if (_listFilter === 'without-msgs') {
    filtered = profiles.filter(p => !p.mensagem_icebreaker || !p.mensagem_hook);
  } else if (_listFilter === 'dm-sent') {
    filtered = profiles.filter(p => p.status === 'mensagem_enviada');
  } else if (_listFilter === 'with-contact') {
    filtered = profiles.filter(p => p.contatos?.has_contact);
  }

  // Ordenação
  const sorted = [...filtered];
  switch (_listSortBy) {
    case 'score-desc':
      sorted.sort((a, b) => (b.score_local ?? b.pontuacao_icp ?? 0) - (a.score_local ?? a.pontuacao_icp ?? 0));
      break;
    case 'date-desc':
      sorted.sort((a, b) => (b.coletado_em || 0) - (a.coletado_em || 0));
      break;
    case 'name-asc':
      sorted.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
      break;
  }
  return sorted;
}

function initList() {
  document.getElementById('card-detail-back').addEventListener('click', closeCardDetail);
  initListToolbar();

  document.getElementById('btn-clear-all').addEventListener('click', async () => {
    if (!confirm('Limpar a lista de aprovados, o histórico e o log?\n\n' +
                 '• Perfis no Kanban: continuam lá, intactos (só somem desta lista).\n' +
                 '• Perfis fora do Kanban: excluídos definitivamente.\n' +
                 '• Todos seguem na blacklist (não voltam em novas buscas).')) return;
    const res = await sendToBg({ type: 'CLEAR_PROFILES' });
    await refreshList();
    clearLogUI();
    updateStatsUI({ processed: 0, approved: 0, descartados: 0, mensagens: 0 });
    document.getElementById('stats-row').style.display = 'none';
    await updateKanbanBadge();

    const kept    = res?.kept_in_kanban || 0;
    const removed = res?.removed || 0;
    let msg;
    if (kept > 0 && removed > 0) {
      msg = `${removed} excluído(s) · ${kept} mantido(s) no Kanban`;
    } else if (kept > 0) {
      msg = `${kept} perfil(is) mantido(s) no Kanban`;
    } else if (removed > 0) {
      msg = `${removed} perfil(is) excluído(s)`;
    } else {
      msg = 'Nada para limpar';
    }
    showToast('settings-toast', msg, 'success');
  });
}

async function refreshList() {
  const res      = await sendToBg({ type: 'GET_PROFILES' });
  // Esconde perfis marcados como "limpos" pelo botão "Limpar tudo" (continuam
  // no Kanban, só somem da aba Aprovados).
  const profiles = (res?.profiles || []).filter(p => !p.hidden_from_list);
  renderProfiles(profiles);
}

async function renderProfiles(profiles) {
  const container    = document.getElementById('profiles-list');
  const counter      = document.getElementById('list-counter');
  const bulkActions  = document.getElementById('bulk-actions');
  const toolbar      = document.getElementById('list-toolbar');
  const selectAll    = document.getElementById('bulk-select-all');

  if (profiles.length === 0) {
    container.innerHTML = '<div class="list-empty">Nenhum perfil aprovado ainda.<br>Inicie a prospecção na aba Busca.</div>';
    counter.textContent = 'Nenhum perfil aprovado ainda';
    if (bulkActions) bulkActions.classList.add('hidden');
    if (toolbar) toolbar.classList.add('hidden');
    return;
  }

  // Aplica sort + filter
  const displayed = applyListSortAndFilter(profiles);

  counter.textContent = displayed.length === profiles.length
    ? `${profiles.length} perfil${profiles.length > 1 ? 's' : ''} aprovado${profiles.length > 1 ? 's' : ''}`
    : `${displayed.length} de ${profiles.length} (filtrados)`;

  const cfg       = await getSettings();
  const hasOpenAI = !!cfg.openaiKey?.trim();
  _hasOpenAICached = hasOpenAI;

  if (toolbar) toolbar.classList.remove('hidden');

  container.innerHTML = '';
  if (displayed.length === 0) {
    container.innerHTML = '<div class="list-empty">Nenhum perfil bate com o filtro selecionado.</div>';
  } else {
    displayed.forEach(p => container.appendChild(buildProfileCard(p, hasOpenAI)));
  }

  // Bulk-actions: visível se há perfis; estado depende da chave OpenAI
  if (bulkActions) bulkActions.classList.remove('hidden');
  if (selectAll) selectAll.checked = false;
  // Filtra _selectedUsernames pra remover usernames que não estão mais na lista
  const validUsernames = new Set(profiles.map(p => p.username));
  for (const u of [..._selectedUsernames]) {
    if (!validUsernames.has(u)) _selectedUsernames.delete(u);
  }
  updateBulkUI();
  const btnBulk = document.getElementById('btn-bulk-generate');
  if (btnBulk) {
    btnBulk.title = hasOpenAI
      ? 'Gera quebra-gelo, gancho e comentário para os selecionados'
      : 'Configure a chave OpenAI nas Configurações pra habilitar';
  }

  // Re-aplica gate de licença em botões recém-criados
  if (_lastLicenseStatus) applyLicenseGating(_lastLicenseStatus);
}

function buildProfileCard(profile, hasOpenAI = false) {
  const card = document.createElement('div');
  card.className = 'profile-card';
  card.dataset.username = profile.username;

  // score_local (novo pipeline) com fallback pra pontuacao_icp (modo legado / dados antigos)
  const score        = profile.score_local ?? profile.pontuacao_icp ?? 0;
  const breakdown    = profile.score_breakdown || {};
  const initial      = (profile.nome || profile.username || '?')[0].toUpperCase();
  const isSent       = profile.status === 'mensagem_enviada';
  const isCommented  = profile.status === 'comentario_enviado';
  const webhookSt    = profile.webhook_status;
  const scoreColor   = scoreToColor(score);
  const iceText      = (profile.mensagem_icebreaker || profile.mensagem_gerada || '').trim();
  const hookText     = (profile.mensagem_hook       || '').trim();
  const cmmText      = (profile.comentario_gerado   || '').trim();
  const just         = (profile.justificativa_icp || '').trim();
  const postUrl      = profile.url_post_recente || '';
  const hasMessages  = !!(iceText && hookText);
  const isSelected   = _selectedUsernames.has(profile.username);

  // Métricas do perfil (novas — pipeline com filtros locais)
  const seguidoresN  = profile.seguidores_raw;
  const engPct       = profile.engajamento_pct;
  const ultimoPostMs = profile.data_ultimo_post;
  const postsCount   = Array.isArray(profile.posts_recentes) ? profile.posts_recentes.length : null;
  const hasBreakdown = Object.keys(breakdown).length > 0;
  const hasMetrics   = seguidoresN != null || engPct != null || ultimoPostMs != null || postsCount;

  const chevron = `<svg class="card-chevron" width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
  </svg>`;

  const msgBadge = hasMessages
    ? `<span class="msg-status-badge has-msg" title="Mensagens prontas">✓ msgs</span>`
    : `<span class="msg-status-badge" title="Sem mensagens — clique em Gerar mensagens">sem msgs</span>`;

  const generateBtnTitle = !hasOpenAI
    ? 'Configure a chave OpenAI nas Configurações'
    : 'Gera quebra-gelo, gancho e comentário via OpenAI';

  card.innerHTML = `
    <input type="checkbox" class="card-select" data-username="${escHtml(profile.username)}" ${isSelected ? 'checked' : ''} />

    <div class="card-header">
      <div class="card-avatar">${(() => { const pic = profile.profile_pic_data || profile.profile_pic_url; return pic ? `<img src="${escHtml(pic)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.textContent='${escHtml(initial)}'">` : initial; })()}</div>
      <div class="card-info">
        <div class="card-name">${escHtml(profile.nome || profile.username)}</div>
        <div class="card-username">@${escHtml(profile.username)} · ${escHtml(profile.seguidores || '')} seguidores</div>
      </div>
      ${msgBadge}
      <span class="score-badge" style="background:${scoreColor}22;color:${scoreColor};border:1px solid ${scoreColor}44">
        ${score}/10
      </span>
      ${chevron}
    </div>

    <div class="card-body">
      ${hasBreakdown ? `
        <div class="card-section-label">📊 Análise de aprovação <span style="font-weight:400;color:var(--text-dim);font-size:.65rem">(local — zero tokens)</span></div>
        <div class="card-breakdown">
          <div class="bd-row"><span>Score final</span><strong style="color:${scoreColor}">${score}/10</strong></div>
          ${breakdown.seguidores != null ? `<div class="bd-row"><span>Seguidores</span><strong>${fmtPts(breakdown.seguidores)}</strong></div>` : ''}
          ${breakdown.recencia != null ? `<div class="bd-row"><span>Recência</span><strong>${fmtPts(breakdown.recencia)}</strong></div>` : ''}
          ${breakdown.frequencia != null ? `<div class="bd-row"><span>Frequência</span><strong>${fmtPts(breakdown.frequencia)}</strong></div>` : ''}
          ${breakdown.engajamento != null ? `<div class="bd-row"><span>Engajamento</span><strong>${fmtPts(breakdown.engajamento)}</strong></div>` : ''}
        </div>
      ` : ''}

      ${hasMetrics ? `
        <div class="card-section-label">📈 Dados coletados</div>
        <div class="card-breakdown">
          ${seguidoresN != null ? `<div class="bd-row"><span>Seguidores</span><strong>${fmtNumber(seguidoresN)}</strong></div>` : ''}
          ${engPct != null ? `<div class="bd-row"><span>Engajamento médio</span><strong>${engPct.toFixed(2)}%</strong></div>` : ''}
          ${ultimoPostMs ? `<div class="bd-row"><span>Última publicação</span><strong>${fmtDiasAtras(ultimoPostMs)}</strong></div>` : ''}
          ${postsCount ? `<div class="bd-row"><span>Posts analisados</span><strong>${postsCount}</strong></div>` : ''}
        </div>
      ` : ''}

      ${profile.contatos?.has_contact ? `
        <div class="card-section-label">📇 Contatos extraídos</div>
        <div class="contact-row">
          ${(profile.contatos.emails || []).map(e => `
            <span class="contact-badge email" data-copy="${escHtml(e)}" title="Clicar pra copiar">📧 ${escHtml(e)}</span>
          `).join('')}
          ${(profile.contatos.whatsapps || []).map(w => `
            <a class="contact-badge whatsapp" href="https://wa.me/${escHtml(w.replace(/^\+/, ''))}" target="_blank" rel="noopener" title="Abrir WhatsApp">📱 ${escHtml(w)}</a>
          `).join('')}
          ${(profile.contatos.phones || []).filter(p => !(profile.contatos.whatsapps || []).includes(p)).map(p => `
            <span class="contact-badge phone" data-copy="${escHtml(p)}" title="Clicar pra copiar">☎️ ${escHtml(p)}</span>
          `).join('')}
          ${(profile.contatos.grupos_whatsapp || []).map(g => `
            <a class="contact-badge whatsapp" href="${escHtml(g)}" target="_blank" rel="noopener" title="Abrir grupo">👥 Grupo WA</a>
          `).join('')}
        </div>
      ` : ''}

      ${just ? `
        <div class="card-section-label" style="opacity:.7">📜 Análise legacy <span style="font-weight:400;font-size:.65rem">(perfil antigo — coletado antes do refactor com IA)</span></div>
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

      ${!hasMessages ? `
        <div class="card-actions" style="margin-top:8px">
          <button class="btn btn-sm btn-generate-msg btn-generate-individual"
                  ${!hasOpenAI ? 'disabled' : ''}
                  title="${escHtml(generateBtnTitle)}">
            ✨ Gerar mensagens
          </button>
        </div>
      ` : ''}

      <div class="card-actions" style="margin-top:8px">
        <button class="btn btn-secondary btn-sm btn-view-profile">Ver Perfil</button>
        ${postUrl ? `<button class="btn btn-secondary btn-sm btn-view-post">Ver Post</button>` : ''}
      </div>

      <div class="card-actions">
        <button class="btn btn-primary btn-sm btn-send-dm"
                ${isSent || !iceText ? 'disabled' : ''}
                title="${!iceText ? 'Gere as mensagens primeiro' : ''}">
          ${isSent ? 'DM Enviado' : !iceText ? 'Sem mensagem' : 'Enviar DM'}
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

  // ── Checkbox de seleção (bulk-actions) ────────────────────────
  card.querySelector('.card-select')?.addEventListener('click', e => e.stopPropagation());
  card.querySelector('.card-select')?.addEventListener('change', e => {
    const username = e.target.dataset.username;
    if (e.target.checked) _selectedUsernames.add(username);
    else _selectedUsernames.delete(username);
    updateBulkUI();
  });

  // ── Click-to-copy nos badges de contato (email/phone) ─────────
  card.querySelectorAll('.contact-badge[data-copy]').forEach(el => {
    el.addEventListener('click', async e => {
      e.stopPropagation();
      const value = e.currentTarget.dataset.copy;
      try {
        await navigator.clipboard.writeText(value);
        const original = e.currentTarget.textContent;
        e.currentTarget.textContent = '✓ copiado';
        setTimeout(() => { e.currentTarget.textContent = original; }, 1500);
      } catch (_) {}
    });
  });

  // Stop propagation nos badges de link (WhatsApp/grupo) — abre em nova aba sem abrir overlay
  card.querySelectorAll('.contact-badge[href]').forEach(el => {
    el.addEventListener('click', e => e.stopPropagation());
  });

  // ── Botão "Gerar mensagens" individual ────────────────────────
  card.querySelector('.btn-generate-individual')?.addEventListener('click', async e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Gerando…';

    const res = await sendToBg({ type: 'GENERATE_MESSAGES', usernames: [profile.username] });

    // Falha de nível bg (sem licença, sem chave, etc.)
    if (res?.ok === false) {
      if (res.error === 'license_required') {
        onLicenseDeniedDuringAction(res.license_status);
      } else {
        showError(res.error || 'Erro ao gerar mensagens');
      }
      btn.disabled = false;
      btn.innerHTML = '✨ Gerar mensagens';
      return;
    }

    // res.ok === true mas precisa checar o resultado específico do username
    const myResult = (res.results || []).find(r => r.username === profile.username);
    if (myResult && !myResult.ok) {
      showError(myResult.error || 'Falha ao gerar mensagens');
      btn.disabled = false;
      btn.innerHTML = '✨ Gerar mensagens';
      return;
    }

    // Sucesso — fecha overlay (se estava aberto) e re-renderiza pra mostrar as msgs novas
    closeCardDetail();
    await refreshList();
  });

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
  const { action = 'info', username, pontuacao, score, error, pausaSeg, reason, detail, until, ts } = e;
  let { message = '' } = e;

  // Hora absoluta: usa ts da entrada (do storage) ou Date.now() pra eventos ao vivo
  const eventTs = ts || Date.now();
  const timeStr = formatHMSClock(eventTs);

  const untilStr = until ? formatHMSClock(until) : null;
  const pauseMin = e.pause_min || (pausaSeg ? Math.round(pausaSeg / 60) : null);

  // Reconstrói mensagem quando carregada do storage (não tem campo message)
  if (!message) {
    switch (action) {
      case 'evaluating':  message = username ? `Avaliando @${username}…` : '…'; break;
      case 'approved':    message = `@${username} — ${pontuacao}/10 — Aprovado ✓`; break;
      case 'local_approved':  message = `@${username} — score ${score}/10 — Aprovado ✓`; break;
      case 'filter_reject':   message = `@${username} — descartado: ${filterReasonLabel(reason, detail)}`; break;
      case 'rejected':    message = `@${username} — ${pontuacao}/10 — Descartado`; break;
      case 'collection_done':  message = `Prospecção encerrada. ${e.approved || 0} aprovados.`; break;
      case 'complete':    message = `Meta atingida! Prospecção encerrada.`; break;
      case 'stopped':     message = 'Prospecção interrompida pelo usuário.'; break;
      case 'long_pause':
        if (untilStr) {
          message = `⏸ Pausa anti-detecção${pausaSeg ? ` (~${pausaSeg}s)` : ''} — retoma às ${untilStr}`;
        } else {
          message = pausaSeg ? `⏸ Pausa: ${pausaSeg}s (anti-detecção)` : '⏸ Pausa…';
        }
        break;
      case 'hashtag_start':    message = `▶ Iniciando #${e.hashtag} (${e.idx}/${e.total})`; break;
      case 'hashtag_done':     message = `✓ #${e.hashtag} concluída${e.next ? `. Próxima: #${e.next}` : ''}`; break;
      case 'source_start':     message = sourceStartLabel(e); break;
      case 'source_done':      message = sourceDoneLabel(e); break;
      case 'ig_block_paused': {
        const dur = pauseMin ? `${pauseMin}min` : '~';
        const ret = untilStr ? ` — retoma às ${untilStr}` : '';
        message = `⛔ ${e.message || reason || 'Bloqueio detectado'}. Pausa de ${dur}${ret}.`;
        break;
      }
      case 'ig_block_definitive': message = `🛑 Bloqueio definitivo (2x): ${e.message || reason}.`; break;
      case 'ig_block_resumed': message = '▶ Coleta retomada após pausa de bloqueio'; break;
      case 'error':       message = `Erro em @${username || '?'}: ${error || ''}`; break;
      default:            message = action;
    }
  }

  const logArea = document.getElementById('log-area');
  const empty   = logArea.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = `log-entry ${action}`;
  entry.innerHTML = `<span class="log-dot"></span><span class="log-time">${timeStr}</span><span class="log-msg">${escHtml(message)}</span>`;
  logArea.appendChild(entry);

  if (scroll) scrollLogToBottom();
}

function formatHMSClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
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

function updateStatsUI(s) {
  // Compat: aceita (processed, approved) ou ({ processed, approved, descartados, mensagens, meta })
  if (typeof s === 'number') s = { processed: s, approved: arguments[1] || 0 };
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.textContent = v; };
  set('stat-processed', s.processed);
  // Aprovados: se houver meta configurada, mostra "X / Y"
  const meta = Number(s.meta);
  const approvedEl = document.getElementById('stat-approved');
  if (approvedEl && s.approved != null) {
    approvedEl.textContent = Number.isFinite(meta) && meta > 0
      ? `${s.approved} / ${meta}`
      : `${s.approved}`;
  }
  set('stat-discarded', s.descartados);
  set('stat-messages',  s.mensagens);
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
//  BANNERS DE STATUS — coleta ativa / bloqueio anti-bot
// ═══════════════════════════════════════════════════════════════════════════

let _blockCountdownInterval = null;
let _activityTicker         = null;

function showCollectionBanner() {
  document.getElementById('collection-banner')?.classList.remove('hidden');
  startActivityTicker();
}
function hideCollectionBanner() {
  document.getElementById('collection-banner')?.classList.add('hidden');
  stopActivityTicker();
  document.getElementById('activity-banner')?.classList.add('hidden');
}

// ─── Activity banner — mostra estado real da prospecção ───────────────────
// Decide entre: collecting / group_pause / long_pause / warning / stalled
// baseado em stats.pause_until e stats.last_activity_at.
function startActivityTicker() {
  stopActivityTicker();
  const tick = async () => {
    try {
      const res = await sendToBg({ type: 'GET_STATS' });
      const stats = res?.stats;
      // Se uma sessão de bloqueio explícito está ativa, o block-banner cobre — esconde o activity
      if (!stats || !stats.active || stats.bloqueio_paused_until || stats.bloqueio_definitivo) {
        document.getElementById('activity-banner')?.classList.add('hidden');
        return;
      }
      renderActivityBanner(stats);
    } catch (_) {}
  };
  tick();
  _activityTicker = setInterval(tick, 1500);
}

function stopActivityTicker() {
  if (_activityTicker) {
    clearInterval(_activityTicker);
    _activityTicker = null;
  }
}

function renderActivityBanner(stats) {
  const banner = document.getElementById('activity-banner');
  const title  = document.getElementById('activity-title');
  const sub    = document.getElementById('activity-sub');
  const timer  = document.getElementById('activity-timer');
  if (!banner || !title || !sub || !timer) return;

  const now             = Date.now();
  const pauseUntil      = stats.pause_until || 0;
  const lastActivityAt  = stats.last_activity_at || now;
  const idleMs          = now - lastActivityAt;

  banner.classList.remove('hidden');

  // 1) Pausa explícita (vinda do content.js) ainda no futuro
  if (pauseUntil && pauseUntil > now) {
    const remainingMs = pauseUntil - now;
    const kind = stats.pause_kind || 'group';
    banner.dataset.state = kind === 'long' ? 'long_pause' : 'group_pause';
    title.textContent = kind === 'long'
      ? '⏸ Pausa longa anti-detecção'
      : '⏸ Pausa entre grupos de perfis';
    sub.textContent   = kind === 'long'
      ? 'Pausa adicional pra parecer comportamento humano (2-5min).'
      : 'Intervalo aleatório entre grupos (anti-bot).';
    timer.textContent = formatMMSS(remainingMs);
    return;
  }

  // 2) Sem pausa registrada — usa heartbeat de atividade
  if (idleMs < 60_000) {
    // < 1 min: provavelmente coletando agora
    banner.dataset.state = 'collecting';
    title.textContent = '🟢 Coletando perfis';
    sub.textContent   = 'Última atividade ' + formatAgo(idleMs);
    timer.textContent = '';
  } else if (idleMs < 6 * 60_000) {
    // 1-6min: pode estar em delay entre perfis (3-7s default) — improvável demorar tanto
    // mas pode estar em pausa de grupo que perdemos o evento. Avisa em amarelo.
    banner.dataset.state = 'warning';
    title.textContent = '⏳ Aguardando próximo perfil';
    sub.textContent   = 'Pode estar em pausa entre grupos. Sem resposta há ' + formatAgo(idleMs) + '.';
    timer.textContent = '';
  } else if (idleMs < 30 * 60_000) {
    // 6-30min: provavelmente pausa longa não-rastreada
    banner.dataset.state = 'long_pause';
    title.textContent = '⏸ Provável pausa anti-detecção';
    sub.textContent   = 'Sem novos perfis há ' + formatAgo(idleMs) + '. Comum em pausas longas (até 5min) entre lotes de perfis.';
    timer.textContent = '';
  } else {
    // > 30min: travada. Provavelmente service worker reiniciou ou aba do IG quebrou.
    banner.dataset.state = 'stalled';
    title.textContent = '⚠ Sem resposta há ' + formatAgo(idleMs);
    sub.textContent   = 'Possível trava. Clique em "Parar" e inicie a prospecção novamente.';
    timer.textContent = '';
  }
}

function formatAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60)    return `${m} min atrás`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h${mm ? ' ' + mm + 'min' : ''} atrás`;
}

function formatMMSS(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}:${String(mm).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function showBlockBanner(message, untilTs) {
  hideBlockDefinitiveBanner();
  hideCollectionBanner();
  const banner = document.getElementById('block-banner');
  const msg    = document.getElementById('block-banner-msg');
  if (banner) banner.classList.remove('hidden');
  if (msg)    msg.textContent = message || 'Coleta pausada — aguarde o contador.';
  startBlockCountdown(untilTs);
}

function hideBlockBanner() {
  document.getElementById('block-banner')?.classList.add('hidden');
  stopBlockCountdown();
}

function showBlockDefinitiveBanner(message) {
  hideBlockBanner();
  hideCollectionBanner();
  const banner = document.getElementById('block-definitive-banner');
  const msg    = document.getElementById('block-definitive-msg');
  if (banner) banner.classList.remove('hidden');
  if (msg && message) msg.textContent = message;
}

function hideBlockDefinitiveBanner() {
  document.getElementById('block-definitive-banner')?.classList.add('hidden');
}

function startBlockCountdown(untilTs) {
  stopBlockCountdown();
  const el = document.getElementById('block-banner-countdown');
  if (!el || !untilTs) return;

  const tick = () => {
    const ms = untilTs - Date.now();
    if (ms <= 0) {
      el.textContent = '00:00:00';
      stopBlockCountdown();
      return;
    }
    el.textContent = formatHMS(ms);
  };
  tick();
  _blockCountdownInterval = setInterval(tick, 1000);
}

function stopBlockCountdown() {
  if (_blockCountdownInterval) {
    clearInterval(_blockCountdownInterval);
    _blockCountdownInterval = null;
  }
}

function formatHMS(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  GERAÇÃO DE MENSAGENS (sob demanda — popup → bg → OpenAI)
// ═══════════════════════════════════════════════════════════════════════════

async function generateMessagesForUsers(usernames) {
  if (!usernames?.length) return;

  const btn = document.getElementById('btn-bulk-generate');
  const originalLabel = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = `Gerando (${usernames.length})…`; }

  const res = await sendToBg({ type: 'GENERATE_MESSAGES', usernames });

  if (res?.ok === false) {
    if (res.error === 'license_required') {
      onLicenseDeniedDuringAction(res.license_status);
    } else {
      showError(res.error || 'Erro ao gerar mensagens');
    }
  } else {
    const okCount = (res.results || []).filter(r => r.ok).length;
    showToast('settings-toast', `Mensagens geradas para ${okCount} perfil(is)`, 'success');
    _selectedUsernames.clear();
    await refreshList();
  }

  if (btn && originalLabel) { btn.innerHTML = originalLabel; }
  updateBulkUI();
}

const _selectedUsernames = new Set();
let _hasOpenAICached = false;
let _metaCached      = null;

function updateBulkUI() {
  const count = _selectedUsernames.size;
  const countEl = document.getElementById('bulk-count');
  const btn = document.getElementById('btn-bulk-generate');
  if (countEl) countEl.textContent = count;
  if (btn) btn.disabled = count === 0 || !_hasOpenAICached;

  const countKanban = document.getElementById('bulk-count-kanban');
  const btnKanban   = document.getElementById('btn-bulk-kanban');
  if (countKanban) countKanban.textContent = count;
  if (btnKanban)   btnKanban.disabled = count === 0;
}

function initBulkActions() {
  document.getElementById('bulk-select-all')?.addEventListener('change', e => {
    const checked = e.target.checked;
    _selectedUsernames.clear();
    document.querySelectorAll('.card-select').forEach(cb => {
      cb.checked = checked;
      if (checked) _selectedUsernames.add(cb.dataset.username);
    });
    updateBulkUI();
  });
  document.getElementById('btn-bulk-generate')?.addEventListener('click', () => {
    if (_selectedUsernames.size === 0) return;
    generateMessagesForUsers([..._selectedUsernames]);
  });
  document.getElementById('btn-bulk-kanban')?.addEventListener('click', async () => {
    if (_selectedUsernames.size === 0) return;
    const usernames = [..._selectedUsernames];
    const res = await sendToBg({ type: 'KANBAN_ADD_PROFILES', usernames });
    if (res?.ok !== false) {
      _selectedUsernames.clear();
      showToast('settings-toast', `${usernames.length} perfil(is) enviado(s) pro Kanban`, 'success');
      await refreshList();
      await updateKanbanBadge();
    } else {
      showError(res?.error || 'Erro ao mover pro Kanban');
    }
  });
  document.getElementById('btn-resume-after-block')?.addEventListener('click', async () => {
    const res = await sendToBg({ type: 'RESUME_PROSPECTING' });
    if (res?.ok) {
      hideBlockDefinitiveBanner();
      hideBlockBanner();
      showCollectionBanner();
      document.getElementById('btn-start').classList.add('hidden');
      document.getElementById('btn-stop').classList.remove('hidden');
    } else {
      showError(res?.error || 'Não foi possível retomar');
    }
  });
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

// Formata pts da breakdown ex: 1.8 → "1.8 / 2 pts"
function fmtPts(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(1)} / 2 pts`;
}

// Formata número grande ex: 25500 → "25.500"
function fmtNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('pt-BR');
}

// Formata timestamp ms como "há X dias" / "hoje" / "há 1 hora"
function fmtDiasAtras(ts) {
  if (!ts) return '—';
  const diffMs = Date.now() - ts;
  if (diffMs < 0)            return 'futuro?';
  if (diffMs < 3600000)      return `há ${Math.max(1, Math.floor(diffMs / 60000))}min`;
  if (diffMs < 86400000)     return `há ${Math.floor(diffMs / 3600000)}h`;
  const dias = Math.floor(diffMs / 86400000);
  if (dias === 0) return 'hoje';
  if (dias === 1) return 'ontem';
  return `há ${dias} dias`;
}

