// background.js — Service Worker (ES Module)
// Orquestra toda a comunicação entre popup, content script e APIs externas

import {
  getSettings,
  getProfiles,
  saveProfile,
  updateProfileStatus,
  getStats,
  saveStats,
  appendLog,
  clearProfiles,
  clearLog,
  addToBlacklist,
  addToGraylist,
  addToHistory,
  clearHistory,
  getHistory,
  getBlacklist,
  getGraylist,
  clearExpiredGraylist,
  incrementStat,
} from './db.js';
import { generateIcebreaker, generateHook, generateComment } from './openai.js';
import { sendLead } from './webhook.js';
import { validateLicense, gateAction, pulse, ensureAlarm, ALARM as LICENSE_ALARM } from './sync.js';
import { passesFilters } from './filters.js';
import { calculateScore } from './score.js';
import { classifyFailure, shouldTriggerBlock, blockMessage } from './igBlockDetector.js';
import { extractFromProfile } from './contactExtractor.js';

// ─── Estado em memória ────────────────────────────────────────────────────
let igTabId = null;
const _failureBuffer = []; // últimas 10 falhas de fetch do IG (classificadas)

// ─── Keep-alive + alarms ──────────────────────────────────────────────────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
ensureAlarm();
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'keepAlive') {
    chrome.storage.local.get('isi_stats', () => {});
  } else if (alarm.name === LICENSE_ALARM) {
    const r = await validateLicense({ force: true });
    if (r?.status !== 'valid') await __interruptOnRevocation(r);
  } else if (alarm.name === 'blockResume') {
    await resumeFromBlock();
  }
});

// Validação no boot do service worker (silent: usa cache fresco se houver)
(async () => {
  try {
    const r = await validateLicense({ silent: true });
    if (r?.status && r.status !== 'valid' && r.status !== 'no_key') {
      await __interruptOnRevocation(r);
    }
  } catch (_) {}
})();

// Interrompe prospecção em curso se a licença for revogada
async function __interruptOnRevocation(status) {
  const stats = await getStats();
  if (!stats.active) return;
  await saveStats({ active: false });

  if (igTabId) {
    try { await sendToContent(igTabId, { type: 'STOP_COLLECTION' }); } catch (_) {}
  }
  try {
    const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
    for (const t of igTabs) {
      try { await sendToContent(t.id, { type: 'STOP_COLLECTION' }); } catch (_) {}
    }
  } catch (_) {}

  broadcast({ type: 'LICENSE_REVOKED', license_status: status?.status || 'invalid' });
}

// ─── Roteador de mensagens ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const result = await route(msg, sender);
      sendResponse({ ok: true, ...(result || {}) });
    } catch (err) {
      console.error('[IsiHunter BG]', err);
      const payload = { ok: false, error: err.message };
      if (err.license_status) payload.license_status = err.license_status;
      sendResponse(payload);
    }
  })();
  return true; // Canal assíncrono
});

// Ações que exigem licença válida (gate antes de processar)
const GATED_ACTIONS = new Set([
  'START_PROSPECTING', 'START_LIST_PROSPECTING',
  'SEND_DM', 'POST_COMMENT', 'SEND_WEBHOOK',
  'GENERATE_MESSAGES',
]);

async function route(msg, _sender) {
  // Gate de licença pra ações sensíveis
  if (GATED_ACTIONS.has(msg.type)) {
    const r = await validateLicense({ force: true });
    if (r?.status !== 'valid') {
      const err = new Error('license_required');
      err.license_status = r?.status || 'unknown';
      throw err;
    }
  }

  switch (msg.type) {
    case 'START_PROSPECTING':       return startProspecting();
    case 'START_LIST_PROSPECTING':  return startListProspecting(msg.usernames);
    case 'STOP_PROSPECTING':        return stopProspecting();
    case 'RESUME_PROSPECTING':      return resumeProspecting();
    case 'GET_PROFILES':            return { profiles: await getProfiles() };
    case 'GET_STATS':               return { stats: await getStats() };
    case 'UPDATE_STATUS':           return updateStatus(msg.username, msg.status);
    case 'CLEAR_PROFILES':          return clearAll();
    case 'GET_HISTORY':             return { history: await getHistory() };
    case 'GET_BLACKLIST':           return { blacklist: await getBlacklist() };
    case 'GET_GRAYLIST':            return { graylist: await getGraylist() };
    case 'PROFILE_DATA':            return processProfile(msg.profileData);
    case 'SEND_DM':                 return initiateDM(msg.username, msg.message);
    case 'DM_SENT':                 return onDmSent(msg.username);
    case 'POST_COMMENT':            return initiatePostComment(msg.username, msg.postUrl, msg.comment);
    case 'COMMENT_POSTED':          return onCommentPosted(msg.username);
    case 'SEND_WEBHOOK':            return dispatchWebhook(msg.username);
    case 'GENERATE_MESSAGES':       return generateMessagesFor(msg.usernames);
    case 'IG_FETCH_FAILED':         return reportIgFetchFailure(msg);
    case 'COLLECTION_DONE':         return onCollectionDone();
    case 'COLLECTION_ERROR':        return onCollectionError(msg.error);
    case 'CHECK_ACTIVE':            return checkActiveState();
    case 'CHECK_LICENSE':           return { status: (await validateLicense({ silent: true }))?.status };
    case 'PROGRESS':                return {};
    case 'PING':                    return { pong: true };
    default:                        throw new Error(`Mensagem desconhecida: ${msg.type}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROSPECÇÃO — INÍCIO
// ═══════════════════════════════════════════════════════════════════════════

async function startProspecting() {
  const cfg = await getSettings();

  // Constrói a lista de sources ativas, em ordem
  const sources = [];

  if (cfg.fonteHashtagAtiva !== false && cfg.fonteHashtagLista?.trim()) {
    const hashtags = parseHashtagList(cfg.fonteHashtagLista);
    if (hashtags.length) sources.push({ type: 'hashtag', list: hashtags });
  }

  if (cfg.fonteSeguidoresAtiva && cfg.fonteSeguidoresPerfil?.trim()) {
    const perfil = cfg.fonteSeguidoresPerfil.trim().replace(/^@/, '').toLowerCase();
    if (perfil) sources.push({ type: 'seguidores', perfil });
  }

  if (cfg.fonteEngajamentoAtiva && cfg.fonteEngajamentoPerfil?.trim()) {
    const perfil = cfg.fonteEngajamentoPerfil.trim().replace(/^@/, '').toLowerCase();
    const nPosts = Math.max(1, Math.min(12, Number(cfg.fonteEngajamentoNPosts) || 12));
    if (perfil) sources.push({ type: 'engajamento', perfil, nPosts });
  }

  if (cfg.fontePalavrasChaveAtiva && cfg.fontePalavrasChaveLista?.trim()) {
    const keywords = parseCsvList(cfg.fontePalavrasChaveLista).slice(0, 10);
    if (keywords.length) sources.push({ type: 'palavras_chave', keywords });
  }

  if (!sources.length) {
    throw new Error('Configure ao menos uma fonte na aba Busca (Hashtags ou Seguidores)');
  }

  // Reset stats + abre nova sessão
  await saveStats({
    active: true,
    processed: 0,
    approved: 0,
    descartados_local: 0,
    aprovados_local: 0,
    mensagens_geradas: 0,
    sources,
    source_idx: 0,
    hashtag_idx: 0,
    bloqueio_count: 0,
    bloqueio_paused_until: null,
    bloqueio_definitivo: false,
    bloqueio_last_reason: null,
  });
  await clearExpiredGraylist();
  _failureBuffer.length = 0;

  return runNextSource();
}

// ═══ Dispatcher de sources — roda a próxima da lista ═══════════════════════
async function runNextSource() {
  const stats = await getStats();
  const sources = stats.sources || [];
  const idx = stats.source_idx || 0;

  if (idx >= sources.length) {
    // Acabou — fecha sessão
    await saveStats({ active: false });
    broadcast({ type: 'PROGRESS', action: 'collection_done', approved: stats.approved });
    appendLog({ action: 'collection_done', approved: stats.approved });
    return { done: true };
  }

  const source = sources[idx];
  if (source.type === 'hashtag')        return runHashtagSource(source);
  if (source.type === 'seguidores')     return runSeguidoresSource(source);
  if (source.type === 'engajamento')    return runEngajamentoSource(source);
  if (source.type === 'palavras_chave') return runPalavrasChaveSource(source);

  // Tipo desconhecido — pula
  await saveStats({ source_idx: idx + 1, hashtag_idx: 0 });
  return runNextSource();
}

async function runHashtagSource(source) {
  const stats = await getStats();
  const list = source.list || [];
  const hidx = stats.hashtag_idx || 0;

  if (hidx >= list.length) {
    // Source de hashtags terminou — avança pra próxima
    appendLog({ action: 'source_done', source: 'hashtag' });
    broadcast({ type: 'PROGRESS', action: 'source_done', source: 'hashtag' });
    await saveStats({ source_idx: (stats.source_idx || 0) + 1, hashtag_idx: 0 });
    return runNextSource();
  }

  const hashtag = list[hidx];
  const url = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/`;

  const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (igTabs.length > 0) {
    igTabId = igTabs[0].id;
    await chrome.tabs.update(igTabId, { url, active: true });
  } else {
    const tab = await chrome.tabs.create({ url });
    igTabId = tab.id;
  }
  await waitForTabLoad(igTabId);

  try {
    await pingContentScript(igTabId);
    await sendToContent(igTabId, { type: 'START_COLLECTION', hashtag });
  } catch (err) {
    await chrome.scripting.executeScript({
      target: { tabId: igTabId },
      files: ['content.js'],
    });
    await delay(1500);
    await sendToContent(igTabId, { type: 'START_COLLECTION', hashtag });
  }

  broadcast({ type: 'PROGRESS', action: 'hashtag_start', hashtag, idx: hidx + 1, total: list.length });
  appendLog({ action: 'hashtag_start', hashtag, idx: hidx + 1, total: list.length });
  return { started: true, hashtag, idx: hidx };
}

async function runSeguidoresSource(source) {
  const perfil = source.perfil;

  const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (igTabs.length > 0) {
    igTabId = igTabs[0].id;
    await chrome.tabs.update(igTabId, { active: true });
  } else {
    const tab = await chrome.tabs.create({ url: 'https://www.instagram.com/' });
    igTabId = tab.id;
    await waitForTabLoad(igTabId);
  }

  try {
    await pingContentScript(igTabId);
    await sendToContent(igTabId, { type: 'START_FOLLOWERS_COLLECTION', perfil });
  } catch (err) {
    await chrome.scripting.executeScript({
      target: { tabId: igTabId },
      files: ['content.js'],
    });
    await delay(1500);
    await sendToContent(igTabId, { type: 'START_FOLLOWERS_COLLECTION', perfil });
  }

  broadcast({ type: 'PROGRESS', action: 'source_start', source: 'seguidores', perfil });
  appendLog({ action: 'source_start', source: 'seguidores', perfil });
  return { started: true, source: 'seguidores', perfil };
}

async function runEngajamentoSource(source) {
  const perfil = source.perfil;
  const nPosts = source.nPosts || 12;

  const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (igTabs.length > 0) {
    igTabId = igTabs[0].id;
    await chrome.tabs.update(igTabId, { active: true });
  } else {
    const tab = await chrome.tabs.create({ url: 'https://www.instagram.com/' });
    igTabId = tab.id;
    await waitForTabLoad(igTabId);
  }

  try {
    await pingContentScript(igTabId);
    await sendToContent(igTabId, { type: 'START_ENGAJAMENTO_COLLECTION', perfil, nPosts });
  } catch (err) {
    await chrome.scripting.executeScript({
      target: { tabId: igTabId },
      files: ['content.js'],
    });
    await delay(1500);
    await sendToContent(igTabId, { type: 'START_ENGAJAMENTO_COLLECTION', perfil, nPosts });
  }

  broadcast({ type: 'PROGRESS', action: 'source_start', source: 'engajamento', perfil, nPosts });
  appendLog({ action: 'source_start', source: 'engajamento', perfil, nPosts });
  return { started: true, source: 'engajamento', perfil, nPosts };
}

async function runPalavrasChaveSource(source) {
  const keywords = source.keywords || [];

  const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (igTabs.length > 0) {
    igTabId = igTabs[0].id;
    await chrome.tabs.update(igTabId, { active: true });
  } else {
    const tab = await chrome.tabs.create({ url: 'https://www.instagram.com/' });
    igTabId = tab.id;
    await waitForTabLoad(igTabId);
  }

  try {
    await pingContentScript(igTabId);
    await sendToContent(igTabId, { type: 'START_KEYWORDS_COLLECTION', keywords });
  } catch (err) {
    await chrome.scripting.executeScript({
      target: { tabId: igTabId },
      files: ['content.js'],
    });
    await delay(1500);
    await sendToContent(igTabId, { type: 'START_KEYWORDS_COLLECTION', keywords });
  }

  broadcast({ type: 'PROGRESS', action: 'source_start', source: 'palavras_chave', keywords });
  appendLog({ action: 'source_start', source: 'palavras_chave', keywords });
  return { started: true, source: 'palavras_chave', keywords };
}

// ─── Triagem por lista de usuários ───────────────────────────────────────
async function startListProspecting(usernames) {
  if (!usernames?.length) throw new Error('Lista de usuários vazia');

  await saveStats({
    active: true,
    processed: 0,
    approved: 0,
    descartados_local: 0,
    aprovados_local: 0,
    hashtag_list: [],
    hashtag_idx: 0,
    bloqueio_count: 0,
    bloqueio_paused_until: null,
    bloqueio_definitivo: false,
  });
  await clearExpiredGraylist();
  _failureBuffer.length = 0;

  const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (igTabs.length > 0) {
    igTabId = igTabs[0].id;
    await chrome.tabs.update(igTabId, { active: true });
    await waitForTabLoad(igTabId);
  } else {
    const tab = await chrome.tabs.create({ url: 'https://www.instagram.com/' });
    igTabId = tab.id;
    await waitForTabLoad(igTabId);
  }

  try {
    await pingContentScript(igTabId);
    await sendToContent(igTabId, { type: 'START_LIST_COLLECTION', usernames });
  } catch (err) {
    await chrome.scripting.executeScript({ target: { tabId: igTabId }, files: ['content.js'] });
    await delay(1500);
    await sendToContent(igTabId, { type: 'START_LIST_COLLECTION', usernames });
  }

  return { started: true };
}

async function stopProspecting() {
  await saveStats({ active: false });
  chrome.alarms.clear('blockResume').catch(() => {});
  if (igTabId) {
    try { await sendToContent(igTabId, { type: 'STOP_COLLECTION' }); } catch (_) {}
  }
  return { stopped: true };
}

// Retoma manualmente — útil após bloqueio definitivo
async function resumeProspecting() {
  const stats = await getStats();
  if (!stats.sources?.length) {
    return { resumed: false, reason: 'no_session' };
  }
  await saveStats({
    active: true,
    bloqueio_paused_until: null,
    bloqueio_definitivo: false,
    bloqueio_count: 0,
  });
  _failureBuffer.length = 0;
  return runNextSource();
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROCESSAMENTO DE PERFIL
// ═══════════════════════════════════════════════════════════════════════════

async function processProfile(profileData) {
  const cfg   = await getSettings();
  const stats = await getStats();

  stats.processed = (stats.processed || 0) + 1;
  await saveStats(stats);

  broadcast({ type: 'PROGRESS', action: 'evaluating', username: profileData.username, ...stats });

  return processProfileLocal(profileData, cfg, stats);
}

// ─── Pipeline novo: filtros locais + score local, ZERO tokens OpenAI ──────
async function processProfileLocal(profileData, cfg, stats) {
  const filters = buildFiltersFromSettings(cfg);

  const gate = passesFilters(profileData, filters);
  if (!gate.passed) {
    await addToGraylist(profileData.username);
    await addToHistory({
      username:   profileData.username,
      nome:       profileData.nome,
      seguidores: profileData.seguidores,
      pontuacao:  0,
      resultado:  'descartado',
      motivo:     gate.reason,
      motivo_detail: gate.detail || null,
    });
    const newCount = await incrementStat('descartados_local');
    const entry = {
      action:    'filter_reject',
      username:  profileData.username,
      reason:    gate.reason,
      detail:    gate.detail || null,
      descartados_local: newCount,
      ...stats,
    };
    await appendLog(entry);
    broadcast({ type: 'PROGRESS', ...entry });
    return { approved: false, reason: gate.reason };
  }

  const { score, breakdown } = calculateScore(profileData, filters);

  // Extração de contatos (gated por toggle, default OFF)
  const contatos = cfg.extrairContatos ? extractFromProfile(profileData) : null;

  await saveProfile({
    ...profileData,
    score_local:     score,
    score_breakdown: breakdown,
    ...(contatos ? { contatos } : {}),
  });

  await addToBlacklist(profileData.username);
  await addToHistory({
    username:   profileData.username,
    nome:       profileData.nome,
    seguidores: profileData.seguidores,
    pontuacao:  score,
    resultado:  'aprovado',
  });
  const newApproved = await incrementStat('aprovados_local');
  stats.approved = (stats.approved || 0) + 1;
  await saveStats(stats);

  // Auto-webhook (envia mesmo sem mensagens — flag tem_mensagens=false)
  if (cfg.webhookAuto && cfg.webhookApiKey?.trim()) {
    const savedProfiles = await getProfiles();
    const saved = savedProfiles.find(p => p.username === profileData.username);
    if (saved) {
      sendLead(cfg, saved)
        .then(() => {
          updateProfileWebhookStatus(profileData.username, 'enviado');
          broadcast({ type: 'WEBHOOK_SENT', username: profileData.username });
        })
        .catch(err => {
          updateProfileWebhookStatus(profileData.username, 'erro', err.message);
          broadcast({ type: 'WEBHOOK_ERROR', username: profileData.username, error: err.message });
        });
    }
  }

  const entry = {
    action:   'local_approved',
    username: profileData.username,
    score,
    aprovados_local: newApproved,
    ...stats,
  };
  await appendLog(entry);
  broadcast({ type: 'PROGRESS', ...entry });

  return { approved: true, score };
}

// ═══════════════════════════════════════════════════════════════════════════
//  GERAÇÃO DE MENSAGENS SOB DEMANDA
// ═══════════════════════════════════════════════════════════════════════════
async function generateMessagesFor(usernames) {
  const cfg = await getSettings();
  if (!cfg.openaiKey?.trim()) throw new Error('Chave OpenAI não configurada nas Configurações');
  if (!Array.isArray(usernames) || !usernames.length) throw new Error('Nenhum perfil selecionado');

  const profiles = await getProfiles();
  const results = [];

  for (const username of usernames) {
    const profile = profiles.find(p => p.username === username);
    if (!profile) {
      results.push({ username, ok: false, error: 'perfil não encontrado' });
      continue;
    }
    if (profile.mensagem_icebreaker && profile.mensagem_hook) {
      results.push({ username, ok: true, skipped: 'já tem mensagens' });
      continue;
    }

    broadcast({ type: 'MESSAGES_GENERATING', username });
    try {
      const just = profile.justificativa_icp || null;
      const [ice, hook] = await Promise.all([
        generateIcebreaker(cfg, profile, just),
        generateHook(cfg, profile, just),
      ]);
      let comment = '';
      try { comment = await generateComment(cfg, profile); }
      catch (_) { comment = ''; }

      await saveProfile({
        username,
        mensagem_icebreaker:  ice,
        mensagem_hook:        hook,
        mensagem_gerada:      ice,
        comentario_gerado:    comment,
        mensagens_geradas_em: Date.now(),
      });
      await incrementStat('mensagens_geradas');
      results.push({ username, ok: true });
      broadcast({ type: 'MESSAGES_GENERATED', username });
    } catch (err) {
      results.push({ username, ok: false, error: err.message });
      broadcast({ type: 'MESSAGES_FAILED', username, error: err.message });
    }
  }

  return { results };
}

// ═══════════════════════════════════════════════════════════════════════════
//  DETECÇÃO DE BLOQUEIO DO INSTAGRAM (state machine 2h → retoma → definitivo)
// ═══════════════════════════════════════════════════════════════════════════
async function reportIgFetchFailure({ status, body }) {
  const classified = classifyFailure({ status, body });
  if (!classified) return { blocked: false };

  _failureBuffer.push(classified);
  if (_failureBuffer.length > 10) _failureBuffer.shift();

  const { blocked, reason } = shouldTriggerBlock(_failureBuffer);
  if (blocked) await triggerBlockPause(reason);
  return { blocked, reason };
}

async function triggerBlockPause(reason) {
  const stats = await getStats();
  const newCount = (stats.bloqueio_count || 0) + 1;
  const msg = blockMessage(reason);

  // Pede content.js pra parar a coleta em curso
  if (igTabId) {
    try { await sendToContent(igTabId, { type: 'STOP_COLLECTION' }); } catch (_) {}
  }
  chrome.alarms.clear('blockResume').catch(() => {});

  if (newCount >= 2) {
    // Segundo bloqueio na sessão → definitivo
    await saveStats({
      active: false,
      bloqueio_definitivo: true,
      bloqueio_count: newCount,
      bloqueio_last_reason: reason,
      bloqueio_paused_until: null,
    });
    appendLog({ action: 'ig_block_definitive', reason, message: msg });
    broadcast({ type: 'PROGRESS', action: 'ig_block_definitive', reason, message: msg });
    broadcast({ type: 'IG_BLOCK_DEFINITIVE', reason, message: msg });
  } else {
    const pauseMs = 2 * 60 * 60 * 1000; // 2h
    const until = Date.now() + pauseMs;
    await saveStats({
      active: false,
      bloqueio_count: newCount,
      bloqueio_paused_until: until,
      bloqueio_last_reason: reason,
    });
    chrome.alarms.create('blockResume', { when: until });
    appendLog({ action: 'ig_block_paused', reason, until, message: msg });
    broadcast({ type: 'PROGRESS', action: 'ig_block_paused', reason, until, message: msg });
    broadcast({ type: 'IG_BLOCK_PAUSED', reason, until, message: msg });
  }
}

async function resumeFromBlock() {
  const stats = await getStats();
  if (stats.bloqueio_definitivo) return;
  if (!stats.bloqueio_paused_until) return;

  await saveStats({ active: true, bloqueio_paused_until: null });
  _failureBuffer.length = 0;

  appendLog({ action: 'ig_block_resumed', count: stats.bloqueio_count });
  broadcast({ type: 'PROGRESS', action: 'ig_block_resumed', count: stats.bloqueio_count });
  broadcast({ type: 'IG_BLOCK_RESUMED' });

  runNextSource().catch(err => console.error('[IsiHunter BG] resume failed:', err));
}

// ═══════════════════════════════════════════════════════════════════════════
//  HANDLERS RESTANTES
// ═══════════════════════════════════════════════════════════════════════════

async function updateStatus(username, status) {
  await updateProfileStatus(username, status);
  return {};
}

async function clearAll() {
  await clearProfiles();
  await clearLog();
  await clearHistory();
  await saveStats({
    active: false, processed: 0, approved: 0,
    descartados_local: 0, aprovados_local: 0, mensagens_geradas: 0,
    hashtag_list: [], hashtag_idx: 0,
    bloqueio_count: 0, bloqueio_paused_until: null, bloqueio_definitivo: false,
  });
  return {};
}

async function initiateDM(username, message) {
  if (!igTabId) {
    const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
    if (igTabs.length > 0) {
      igTabId = igTabs[0].id;
    } else {
      const tab = await chrome.tabs.create({ url: 'https://www.instagram.com/direct/new/' });
      igTabId = tab.id;
      await waitForTabLoad(igTabId);
    }
  }

  await chrome.tabs.update(igTabId, {
    url: 'https://www.instagram.com/direct/new/',
    active: true,
  });
  await waitForTabLoad(igTabId);

  await sendToContent(igTabId, { type: 'SEND_DM', username, message });
  return {};
}

async function initiatePostComment(username, postUrl, comment) {
  if (!postUrl) throw new Error('URL do post não disponível para @' + username);

  if (!igTabId) {
    const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
    igTabId = igTabs.length > 0 ? igTabs[0].id : null;
  }

  if (!igTabId) {
    const tab = await chrome.tabs.create({ url: postUrl });
    igTabId = tab.id;
    await waitForTabLoad(igTabId);
  } else {
    await chrome.tabs.update(igTabId, { url: postUrl, active: true });
    await waitForTabLoad(igTabId);
  }

  await sendToContent(igTabId, { type: 'POST_COMMENT', username, comment });
  return {};
}

async function onCommentPosted(username) {
  await updateProfileStatus(username, 'comentario_enviado');
  broadcast({ type: 'COMMENT_POSTED', username });
  return {};
}

async function dispatchWebhook(username) {
  const cfg      = await getSettings();
  const profiles = await getProfiles();
  const profile  = profiles.find(p => p.username === username);
  if (!profile) throw new Error('Perfil não encontrado: ' + username);

  await sendLead(cfg, profile);
  await updateProfileWebhookStatus(username, 'enviado');
  broadcast({ type: 'WEBHOOK_SENT', username });
  return {};
}

async function updateProfileWebhookStatus(username, status, errorMsg) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex(p => p.username === username);
  if (idx >= 0) {
    profiles[idx].webhook_status = status;
    if (errorMsg) profiles[idx].webhook_error = errorMsg;
    await new Promise(resolve => chrome.storage.local.set({ isi_profiles: profiles }, resolve));
  }
}

async function onDmSent(username) {
  await updateProfileStatus(username, 'mensagem_enviada');
  broadcast({ type: 'DM_SENT', username });
  return {};
}

async function checkActiveState() {
  const stats = await getStats();

  // Bloqueio pendente — popup precisa saber pra mostrar countdown
  if (stats.bloqueio_paused_until && Date.now() < stats.bloqueio_paused_until) {
    return {
      active: false,
      blocked: true,
      until: stats.bloqueio_paused_until,
      reason: stats.bloqueio_last_reason,
    };
  }
  if (stats.bloqueio_definitivo) {
    return { active: false, blockedDefinitive: true, reason: stats.bloqueio_last_reason };
  }

  if (!stats.active) return { active: false };

  const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (!igTabs.length) {
    await saveStats({ active: false });
    return { active: false, reason: 'no_tab' };
  }

  for (const tab of igTabs) {
    try {
      const res = await sendToContent(tab.id, { type: 'PING' });
      if (res?.collectingActive) {
        igTabId = tab.id;
        return { active: true };
      }
    } catch (_) {}
  }

  await saveStats({ active: false });
  return { active: false, reason: 'not_collecting' };
}

// Coleta de UMA iteração terminou — avança dentro da source atual ou pra próxima
async function onCollectionDone() {
  const stats = await getStats();
  const sources = stats.sources || [];
  const sIdx = stats.source_idx || 0;
  const currentSource = sources[sIdx];

  if (!currentSource) {
    // Sem sessão ativa (ou triagem por lista) — encerra
    await saveStats({ active: false });
    appendLog({ action: 'collection_done', approved: stats.approved });
    broadcast({ type: 'PROGRESS', action: 'collection_done', approved: stats.approved });
    return {};
  }

  if (currentSource.type === 'hashtag') {
    const list = currentSource.list || [];
    const nextHidx = (stats.hashtag_idx || 0) + 1;

    if (nextHidx < list.length) {
      const done = list[nextHidx - 1];
      const next = list[nextHidx];
      await saveStats({ hashtag_idx: nextHidx });
      appendLog({ action: 'hashtag_done', hashtag: done, next });
      broadcast({ type: 'PROGRESS', action: 'hashtag_done', hashtag: done, next });
      setTimeout(() => runHashtagSource(currentSource).catch(console.error), 5000);
      return {};
    }
    // Hashtags exauridas — fecha source e avança
    await saveStats({ source_idx: sIdx + 1, hashtag_idx: 0 });
    appendLog({ action: 'source_done', source: 'hashtag' });
    broadcast({ type: 'PROGRESS', action: 'source_done', source: 'hashtag' });
  } else if (currentSource.type === 'seguidores') {
    await saveStats({ source_idx: sIdx + 1 });
    appendLog({ action: 'source_done', source: 'seguidores', perfil: currentSource.perfil });
    broadcast({ type: 'PROGRESS', action: 'source_done', source: 'seguidores', perfil: currentSource.perfil });
  } else if (currentSource.type === 'engajamento') {
    await saveStats({ source_idx: sIdx + 1 });
    appendLog({ action: 'source_done', source: 'engajamento', perfil: currentSource.perfil });
    broadcast({ type: 'PROGRESS', action: 'source_done', source: 'engajamento', perfil: currentSource.perfil });
  } else if (currentSource.type === 'palavras_chave') {
    await saveStats({ source_idx: sIdx + 1 });
    appendLog({ action: 'source_done', source: 'palavras_chave', keywords: currentSource.keywords });
    broadcast({ type: 'PROGRESS', action: 'source_done', source: 'palavras_chave', keywords: currentSource.keywords });
  } else {
    await saveStats({ source_idx: sIdx + 1 });
  }

  setTimeout(() => runNextSource().catch(console.error), 5000);
  return {};
}

async function onCollectionError(error) {
  await saveStats({ active: false });
  broadcast({ type: 'PROGRESS', action: 'collection_error', error });
  return {};
}

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function buildFiltersFromSettings(cfg) {
  return {
    seguidoresMin:      numOrNull(cfg.filtroSeguidoresMin),
    seguidoresMax:      numOrNull(cfg.filtroSeguidoresMax),
    keywords:           cfg.filtroKeywords || '',
    ultimoPostDiasMax:  numOrNull(cfg.filtroUltimoPostDias),
    postsMin:           numOrNull(cfg.filtroPostsMin),
    postsDias:          numOrNull(cfg.filtroPostsDias),
    engajamentoMin:     numOrNull(cfg.filtroEngajamentoMin),
  };
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseHashtagList(csv) {
  if (!csv) return [];
  return [...new Set(
    String(csv).split(',')
      .map(h => h.trim().replace(/^#/, '').replace(/\s+/g, '').toLowerCase())
      .filter(Boolean)
  )].slice(0, 10);
}

// Parse genérico de CSV (mantém espaços internos, usado para palavras-chave de busca)
function parseCsvList(csv) {
  if (!csv) return [];
  return [...new Set(
    String(csv).split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.toLowerCase())
  )];
}

function broadcast(data) {
  chrome.runtime.sendMessage(data).catch(() => {
    // Popup pode estar fechado; ignora silenciosamente
  });
}

function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function pingContentScript(tabId) {
  return sendToContent(tabId, { type: 'PING' });
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab) return resolve();
      if (tab.status === 'complete') return setTimeout(resolve, 1500);

      const fallback = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);

      function listener(id, info) {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(fallback);
          setTimeout(resolve, 2000);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
