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
  getBlacklist,
  getGraylist,
  clearExpiredGraylist,
} from './db.js';
import { qualifyProfile, generateIcebreaker, generateHook, generateComment } from './openai.js';
import { sendLead } from './webhook.js';

// ─── Estado em memória ────────────────────────────────────────────────────
let igTabId = null;

// ─── Keep-alive: evita que o service worker durma durante a prospecção ────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepAlive') {
    chrome.storage.local.get('isi_stats', () => {}); // Apenas acessa o storage
  }
});

// ─── Roteador de mensagens ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const result = await route(msg, sender);
      sendResponse({ ok: true, ...(result || {}) });
    } catch (err) {
      console.error('[IsiHunter BG]', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // Canal assíncrono
});

async function route(msg, _sender) {
  switch (msg.type) {
    case 'START_PROSPECTING':       return startProspecting();
    case 'START_LIST_PROSPECTING':  return startListProspecting(msg.usernames);
    case 'STOP_PROSPECTING':        return stopProspecting();
    case 'GET_PROFILES':        return { profiles: await getProfiles() };
    case 'GET_STATS':           return { stats: await getStats() };
    case 'UPDATE_STATUS':       return updateStatus(msg.username, msg.status);
    case 'CLEAR_PROFILES':      return clearAll();
    case 'GET_HISTORY':         return { history: await getHistory() };
    case 'GET_BLACKLIST':       return { blacklist: await getBlacklist() };
    case 'GET_GRAYLIST':        return { graylist: await getGraylist() };
    case 'PROFILE_DATA':        return processProfile(msg.profileData);
    case 'SEND_DM':             return initiateDM(msg.username, msg.message);
    case 'DM_SENT':             return onDmSent(msg.username);
    case 'POST_COMMENT':        return initiatePostComment(msg.username, msg.postUrl, msg.comment);
    case 'COMMENT_POSTED':      return onCommentPosted(msg.username);
    case 'SEND_WEBHOOK':        return dispatchWebhook(msg.username);
    case 'COLLECTION_DONE':     return onCollectionDone();
    case 'COLLECTION_ERROR':    return onCollectionError(msg.error);
    case 'CHECK_ACTIVE':        return checkActiveState();
    case 'PROGRESS':            return {}; // emitido por content.js, consumido pelo popup — no-op aqui
    case 'PING':                return { pong: true };
    default:                    throw new Error(`Mensagem desconhecida: ${msg.type}`);
  }
}

// ─── Iniciar prospecção ───────────────────────────────────────────────────
async function startProspecting() {
  const cfg = await getSettings();

  if (!cfg.openaiKey?.trim())  throw new Error('Configure a chave da API OpenAI nas Configurações');
  if (!cfg.icp?.trim())        throw new Error('Configure o ICP nas Configurações');
  if (!cfg.hashtags?.trim())   throw new Error('Configure as hashtags nas Configurações');

  // Reinicia estatísticas e log; limpa graylists expiradas
  await saveStats({ active: true, processed: 0, approved: 0 });
  await clearExpiredGraylist();

  // Primeira hashtag da lista — remove #, espaços e converte para minúsculas
  const hashtag = cfg.hashtags.split(',')[0].trim().replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
  if (!hashtag) throw new Error('Configure uma hashtag válida nas Configurações (ex: #afiliadosbrasil).');

  // Navega direto para a página da hashtag (abordagem DOM)
  const hashtagUrl = `https://www.instagram.com/explore/tags/${encodeURIComponent(hashtag)}/`;
  const igTabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  if (igTabs.length > 0) {
    igTabId = igTabs[0].id;
    await chrome.tabs.update(igTabId, { url: hashtagUrl, active: true });
  } else {
    const tab = await chrome.tabs.create({ url: hashtagUrl });
    igTabId = tab.id;
  }
  await waitForTabLoad(igTabId);

  // Dispara coleta no content script (resposta assíncrona — não bloqueia)
  try {
    await pingContentScript(igTabId); // Garante que o content script está ativo
    await sendToContent(igTabId, { type: 'START_COLLECTION', hashtag });
  } catch (err) {
    // Content script pode não estar carregado ainda; injeta manualmente
    await chrome.scripting.executeScript({
      target: { tabId: igTabId },
      files: ['content.js'],
    });
    await delay(1500);
    await sendToContent(igTabId, { type: 'START_COLLECTION', hashtag });
  }

  return { started: true };
}

// ─── Triagem por lista de usuários ───────────────────────────────────────
async function startListProspecting(usernames) {
  const cfg = await getSettings();
  if (!cfg.openaiKey?.trim()) throw new Error('Configure a chave da API OpenAI nas Configurações');
  if (!cfg.icp?.trim())       throw new Error('Configure o ICP nas Configurações');
  if (!usernames?.length)     throw new Error('Lista de usuários vazia');

  await saveStats({ active: true, processed: 0, approved: 0 });
  await clearExpiredGraylist();

  // Qualquer aba do Instagram serve — as chamadas de API não dependem da página atual
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

// ─── Parar prospecção ────────────────────────────────────────────────────
async function stopProspecting() {
  await saveStats({ active: false });
  if (igTabId) {
    try { await sendToContent(igTabId, { type: 'STOP_COLLECTION' }); } catch (_) {}
  }
  return { stopped: true };
}

// ─── Processar perfil recebido do content script ─────────────────────────
async function processProfile(profileData) {
  const cfg   = await getSettings();
  const stats = await getStats();

  stats.processed = (stats.processed || 0) + 1;
  await saveStats(stats);

  // Notifica popup: avaliando
  broadcast({ type: 'PROGRESS', action: 'evaluating', username: profileData.username, ...stats });

  // Qualifica com IA
  let qual;
  try {
    qual = await qualifyProfile(cfg, profileData);
  } catch (err) {
    const entry = { action: 'error', username: profileData.username, error: err.message, ...stats };
    await appendLog(entry);
    broadcast({ type: 'PROGRESS', ...entry });
    return { approved: false, error: err.message };
  }

  // Filtro de idioma — rejeita sem consumir mais chamadas de IA nem graylisting
  if (cfg.idiomaAlvo && qual.idioma && qual.idioma !== cfg.idiomaAlvo) {
    const entry = { action: 'idioma_ignorado', username: profileData.username, idioma: qual.idioma, ...stats };
    await appendLog(entry);
    broadcast({ type: 'PROGRESS', ...entry });
    return { approved: false, idioma_ignorado: true };
  }

  const minScore = cfg.pontuacaoMinima ?? 7;
  const approved = qual.pontuacao >= minScore;

  if (approved) {
    // Gera quebra-gelo e gancho em paralelo
    const profileWithQualPre = { ...profileData, justificativa_icp: qual.justificativa };
    let icebreaker = '';
    let hook = '';
    try {
      [icebreaker, hook] = await Promise.all([
        generateIcebreaker(cfg, profileWithQualPre, qual.justificativa),
        generateHook(cfg, profileWithQualPre, qual.justificativa),
      ]);
    } catch (err) {
      icebreaker = icebreaker || `(Erro ao gerar quebra-gelo: ${err.message})`;
      hook       = hook       || `(Erro ao gerar gancho: ${err.message})`;
    }

    // Gera comentário para o post recente
    const profileWithQual = { ...profileData, justificativa_icp: qual.justificativa };
    let comentario = '';
    try {
      comentario = await generateComment(cfg, profileWithQual);
    } catch (err) {
      comentario = `(Erro ao gerar comentário: ${err.message})`;
    }

    await saveProfile({
      ...profileData,
      pontuacao_icp:      qual.pontuacao,
      justificativa_icp:  qual.justificativa,
      nicho_detectado:    qual.nicho || null,
      mensagem_icebreaker: icebreaker,
      mensagem_hook:       hook,
      // mantém mensagem_gerada apontando para o icebreaker (compatibilidade com envio DM)
      mensagem_gerada:     icebreaker,
      comentario_gerado:   comentario,
    });

    // Envio automático ao webhook (se configurado)
    if (cfg.webhookAuto && cfg.webhookApiKey?.trim()) {
      const savedProfiles = await getProfiles();
      const savedProfile  = savedProfiles.find(p => p.username === profileData.username);
      if (savedProfile) {
        sendLead(cfg, savedProfile)
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

    // Blacklist: nunca processar de novo
    await addToBlacklist(profileData.username);

    // Histórico
    await addToHistory({
      username:   profileData.username,
      nome:       profileData.nome,
      seguidores: profileData.seguidores,
      pontuacao:  qual.pontuacao,
      resultado:  'aprovado',
    });

    stats.approved = (stats.approved || 0) + 1;
    await saveStats(stats);

    const entry = {
      action: 'approved',
      username: profileData.username,
      pontuacao: qual.pontuacao,
      ...stats,
    };
    await appendLog(entry);
    broadcast({ type: 'PROGRESS', ...entry });

    // Meta atingida
    const meta = cfg.metaPerfis || 20;
    if (stats.approved >= meta) {
      await stopProspecting();
      broadcast({ type: 'PROGRESS', action: 'complete', approved: stats.approved });
    }
  } else {
    // Graylist: ignorar por 30 dias
    await addToGraylist(profileData.username);

    // Histórico
    await addToHistory({
      username:   profileData.username,
      nome:       profileData.nome,
      seguidores: profileData.seguidores,
      pontuacao:  qual.pontuacao,
      resultado:  'descartado',
    });

    const entry = {
      action: 'rejected',
      username: profileData.username,
      pontuacao: qual.pontuacao,
      ...stats,
    };
    await appendLog(entry);
    broadcast({ type: 'PROGRESS', ...entry });
  }

  return { approved, pontuacao: qual.pontuacao };
}

// ─── Atualizar status de um perfil ───────────────────────────────────────
async function updateStatus(username, status) {
  await updateProfileStatus(username, status);
  return {};
}

// ─── Limpar todos os perfis ───────────────────────────────────────────────
async function clearAll() {
  await clearProfiles();
  await clearLog();
  await clearHistory();
  await saveStats({ active: false, processed: 0, approved: 0 });
  return {};
}

// ─── Iniciar envio de DM ─────────────────────────────────────────────────
async function initiateDM(username, message) {
  // Garante que temos uma aba do Instagram
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

  // Navega até a página de DM
  await chrome.tabs.update(igTabId, {
    url: 'https://www.instagram.com/direct/new/',
    active: true,
  });
  await waitForTabLoad(igTabId);

  // Diz ao content script para enviar a mensagem
  await sendToContent(igTabId, { type: 'SEND_DM', username, message });

  return {};
}

// ─── Iniciar comentário no post ──────────────────────────────────────────
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

// ─── Comentário postado com sucesso (reportado pelo content script) ───────
async function onCommentPosted(username) {
  await updateProfileStatus(username, 'comentario_enviado');
  broadcast({ type: 'COMMENT_POSTED', username });
  return {};
}

// ─── Envio manual de lead para webhook ───────────────────────────────────
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

// ─── Atualiza status do webhook no perfil ────────────────────────────────
async function updateProfileWebhookStatus(username, status, errorMsg) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex(p => p.username === username);
  if (idx >= 0) {
    profiles[idx].webhook_status = status;
    if (errorMsg) profiles[idx].webhook_error = errorMsg;
    await new Promise(resolve => chrome.storage.local.set({ isi_profiles: profiles }, resolve));
  }
}

// ─── DM enviado com sucesso (reportado pelo content script) ───────────────
async function onDmSent(username) {
  await updateProfileStatus(username, 'mensagem_enviada');
  broadcast({ type: 'DM_SENT', username });
  return {};
}

// ─── Verifica se o estado `active` é real ou zumbi ──────────────────────
// Chamado pelo popup ao abrir; se stats.active=true mas nenhum content script
// está coletando, reseta para false para destravar o botão "Iniciar".
async function checkActiveState() {
  const stats = await getStats();
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
        igTabId = tab.id; // refresca referência
        return { active: true };
      }
    } catch (_) { /* content script não responde nesta aba */ }
  }

  // Nenhuma aba está coletando — estado zumbi
  await saveStats({ active: false });
  return { active: false, reason: 'not_collecting' };
}

// ─── Coleta encerrada naturalmente (sem mais páginas) ────────────────────
async function onCollectionDone() {
  const stats = await getStats();
  await saveStats({ active: false });
  const entry = { action: 'collection_done', approved: stats.approved };
  await appendLog(entry);
  broadcast({ type: 'PROGRESS', ...entry });
  return {};
}

// ─── Erro na coleta ──────────────────────────────────────────────────────
async function onCollectionError(error) {
  await saveStats({ active: false });
  broadcast({ type: 'PROGRESS', action: 'collection_error', error });
  return {};
}

// ─── Utilitários ─────────────────────────────────────────────────────────

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
      // Aba já carregada — aguarda só o React inicializar
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
