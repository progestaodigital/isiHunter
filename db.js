// db.js — módulo de persistência usando chrome.storage.local
// Importado como ES Module por background.js e popup.js

const KEY_SETTINGS  = 'isi_settings';
const KEY_PROFILES  = 'isi_profiles';
const KEY_STATS     = 'isi_stats';
const KEY_LOG       = 'isi_log';
const KEY_BLACKLIST = 'isi_blacklist'; // Perfis aprovados — nunca processar de novo
const KEY_GRAYLIST  = 'isi_graylist';  // Perfis descartados — ignorar por 30 dias
const KEY_HISTORY   = 'isi_history';   // Todos os perfis analisados (aprovados + descartados)

const GRAYLIST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias em ms

// ─── Helpers ───────────────────────────────────────────────────────────────

function get(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function set(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

function remove(keys) {
  return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
}

// ─── Settings ──────────────────────────────────────────────────────────────

export async function getSettings() {
  const r = await get(KEY_SETTINGS);
  return r[KEY_SETTINGS] || {};
}

export async function saveSettings(settings) {
  await set({ [KEY_SETTINGS]: settings });
}

// ─── Profiles ──────────────────────────────────────────────────────────────

export async function getProfiles() {
  const r = await get(KEY_PROFILES);
  return r[KEY_PROFILES] || [];
}

export async function saveProfile(profile) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex(p => p.username === profile.username);

  if (idx >= 0) {
    profiles[idx] = { ...profiles[idx], ...profile };
  } else {
    profiles.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      status: 'coletado',
      coletado_em: Date.now(),
      ...profile,
    });
  }

  await set({ [KEY_PROFILES]: profiles });
}

export async function updateProfileStatus(username, status) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex(p => p.username === username);
  if (idx >= 0) {
    profiles[idx].status = status;
    await set({ [KEY_PROFILES]: profiles });
  }
}

export async function clearProfiles() {
  await remove(KEY_PROFILES);
}

// ─── Prospecting stats ─────────────────────────────────────────────────────

export async function getStats() {
  const r = await get(KEY_STATS);
  return r[KEY_STATS] || { active: false, processed: 0, approved: 0 };
}

export async function saveStats(partial) {
  const current = await getStats();
  await set({ [KEY_STATS]: { ...current, ...partial } });
}

// ─── Progress log (últimas 100 entradas) ──────────────────────────────────

export async function getLog() {
  const r = await get(KEY_LOG);
  return r[KEY_LOG] || [];
}

export async function appendLog(entry) {
  const log = await getLog();
  log.push({ ...entry, ts: Date.now() });
  if (log.length > 100) log.splice(0, log.length - 100);
  await set({ [KEY_LOG]: log });
}

export async function clearLog() {
  await remove(KEY_LOG);
}

// ─── Blacklist (perfis aprovados — ignora para sempre) ────────────────────

export async function getBlacklist() {
  const r = await get(KEY_BLACKLIST);
  return r[KEY_BLACKLIST] || {};           // { username: true }
}

export async function addToBlacklist(username) {
  const list = await getBlacklist();
  list[username] = true;
  await set({ [KEY_BLACKLIST]: list });
}

export async function saveBlacklist(data) {
  await set({ [KEY_BLACKLIST]: data });
}

export async function isBlacklisted(username) {
  const list = await getBlacklist();
  return !!list[username];
}

// ─── Graylist (perfis descartados — ignora por 30 dias) ──────────────────

export async function getGraylist() {
  const r = await get(KEY_GRAYLIST);
  return r[KEY_GRAYLIST] || {};            // { username: timestamp_expiry }
}

export async function addToGraylist(username) {
  const list = await getGraylist();
  list[username] = Date.now() + GRAYLIST_TTL_MS;
  await set({ [KEY_GRAYLIST]: list });
}

export async function isGreylisted(username) {
  const list = await getGraylist();
  const expiry = list[username];
  if (!expiry) return false;
  if (Date.now() < expiry) return true;
  // Expirado — remove e retorna false
  delete list[username];
  await set({ [KEY_GRAYLIST]: list });
  return false;
}

export async function saveGraylist(data) {
  await set({ [KEY_GRAYLIST]: data });
}

export async function clearExpiredGraylist() {
  const list = await getGraylist();
  const now = Date.now();
  let changed = false;
  for (const u of Object.keys(list)) {
    if (list[u] <= now) { delete list[u]; changed = true; }
  }
  if (changed) await set({ [KEY_GRAYLIST]: list });
}

// ─── Histórico completo (aprovados + descartados) ────────────────────────

export async function getHistory() {
  const r = await get(KEY_HISTORY);
  return r[KEY_HISTORY] || [];
}

export async function addToHistory(entry) {
  // entry: { username, nome, seguidores, pontuacao, resultado: 'aprovado'|'descartado', ts }
  const history = await getHistory();
  // Evita duplicatas
  if (!history.find(h => h.username === entry.username)) {
    history.unshift({ ...entry, ts: Date.now() }); // mais recente primeiro
    if (history.length > 500) history.splice(500);
    await set({ [KEY_HISTORY]: history });
  }
}

export async function clearHistory() {
  await remove(KEY_HISTORY);
}
