// db.js — módulo de persistência usando chrome.storage.local
// Importado como ES Module por background.js e popup.js

const KEY_SETTINGS       = 'isi_settings';
const KEY_PROFILES       = 'isi_profiles';
const KEY_STATS          = 'isi_stats';
const KEY_LOG            = 'isi_log';
const KEY_BLACKLIST      = 'isi_blacklist'; // Perfis aprovados — nunca processar de novo
const KEY_GRAYLIST       = 'isi_graylist';  // Perfis descartados — ignorar por 30 dias
const KEY_HISTORY        = 'isi_history';   // Todos os perfis analisados (aprovados + descartados)
const KEY_BIO_LINK_CACHE = 'isi_bio_link_cache'; // Fase 5b — cache de extração profunda
const KEY_KANBAN_COLUMNS = 'isi_kanban_columns'; // CRM/Kanban — colunas customizadas

const DEFAULT_COLUMN_ID  = 'aprovados';
const DEFAULT_COLUMN_NAME = 'Aprovados';

const GRAYLIST_TTL_MS      = 30 * 24 * 60 * 60 * 1000; // 30 dias em ms
const BIO_LINK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const BIO_LINK_CACHE_MAX   = 500; // limite de entradas (evita storage crescer indefinidamente)

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
  const profiles = r[KEY_PROFILES] || [];
  // Migração lazy (1x): perfis aprovados antes da feature de Kanban auto-add
  // ganham as datas faltantes. Sem isso, "Adicionado em" / "Última ação"
  // ficam vazios pra perfis legados.
  let touched = false;
  for (const p of profiles) {
    if (!p.kanban_added_at) {
      // Fallback: kanban_moved_at (se já estava no kanban) ou coletado_em
      p.kanban_added_at = p.kanban_moved_at || p.coletado_em || Date.now();
      touched = true;
    }
    if (!p.kanban_last_action_at) {
      p.kanban_last_action_at = p.kanban_moved_at || p.kanban_added_at;
      touched = true;
    }
  }
  if (touched) await set({ [KEY_PROFILES]: profiles });
  return profiles;
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

// Limpa a aba "Aprovados" no popup:
//   - Perfis NO Kanban: marca hidden_from_list=true (somem da aba, mas continuam
//     no Kanban com todas as informações intactas).
//   - Perfis FORA do Kanban: removidos do storage de perfis.
//   - Blacklist NÃO é tocada — perfis limpos não voltam a ser processados.
// Retorna contadores pro popup mostrar feedback ao usuário.
export async function clearProfiles() {
  const profiles = await getProfiles();
  const now = Date.now();
  const kept = [];
  let hiddenCount  = 0;
  let removedCount = 0;
  for (const p of profiles) {
    if (p.kanban_column_id) {
      kept.push({ ...p, hidden_from_list: true, hidden_at: now });
      hiddenCount++;
    } else {
      removedCount++;
    }
  }
  if (kept.length) {
    await set({ [KEY_PROFILES]: kept });
  } else {
    await remove(KEY_PROFILES);
  }
  return { removed: removedCount, kept_in_kanban: hiddenCount };
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

// Increment atômico de um campo numérico de stats. Usado para telemetria
// (descartados_local, aprovados_local, mensagens_geradas, bloqueio_ocorrencias).
export async function incrementStat(field, by = 1) {
  const current = await getStats();
  const next = (current[field] || 0) + by;
  await set({ [KEY_STATS]: { ...current, [field]: next } });
  return next;
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

// ─── Bio-link cache (Fase 5b — extração profunda) ────────────────────────
// Shape: { [url]: { extracted: {emails, phones, whatsapps, grupos_whatsapp}, ts, status } }
// status: 'ok' | 'failed' | 'skipped' (mantemos miss também pra evitar re-fetch)

export async function getCachedBioLink(url) {
  const r = await get(KEY_BIO_LINK_CACHE);
  const cache = r[KEY_BIO_LINK_CACHE] || {};
  const entry = cache[url];
  if (!entry) return null;
  if (Date.now() - entry.ts > BIO_LINK_CACHE_TTL_MS) {
    // Expirado — limpa lazy
    delete cache[url];
    await set({ [KEY_BIO_LINK_CACHE]: cache });
    return null;
  }
  return entry;
}

export async function setCachedBioLink(url, extracted, status = 'ok') {
  const r = await get(KEY_BIO_LINK_CACHE);
  const cache = r[KEY_BIO_LINK_CACHE] || {};
  cache[url] = { extracted, status, ts: Date.now() };

  // LRU-ish: se ultrapassou limite, descarta os 50 mais antigos
  const keys = Object.keys(cache);
  if (keys.length > BIO_LINK_CACHE_MAX) {
    const sorted = keys
      .map(k => [k, cache[k].ts || 0])
      .sort((a, b) => a[1] - b[1]);
    const toDrop = sorted.slice(0, 50).map(([k]) => k);
    for (const k of toDrop) delete cache[k];
  }

  await set({ [KEY_BIO_LINK_CACHE]: cache });
}

export async function clearBioLinkCache() {
  await remove(KEY_BIO_LINK_CACHE);
}

// ─── Kanban / mini-CRM ────────────────────────────────────────────────────
// Colunas vivem em `isi_kanban_columns` como array { id, name, order, isDefault }.
// A primeira chamada cria a coluna padrão "Aprovados" (id: 'aprovados').
// Cada profile.kanban_column_id aponta pra coluna (null = não está no kanban).
// Cada profile.kanban_notes é array { id, ts, text }.

export const KANBAN_DEFAULT_COLUMN_ID = DEFAULT_COLUMN_ID;

export async function getKanbanColumns() {
  const r = await get(KEY_KANBAN_COLUMNS);
  let cols = r[KEY_KANBAN_COLUMNS];
  if (!Array.isArray(cols) || cols.length === 0) {
    cols = [{ id: DEFAULT_COLUMN_ID, name: DEFAULT_COLUMN_NAME, order: 0, isDefault: true }];
    await set({ [KEY_KANBAN_COLUMNS]: cols });
  }

  // Migração lazy: instalações anteriores tinham 'selecionados' como id padrão.
  // Renomeia pra 'aprovados' e migra perfis que apontavam pra coluna antiga.
  const legacy = cols.find(c => c.id === 'selecionados');
  if (legacy && !cols.find(c => c.id === DEFAULT_COLUMN_ID)) {
    legacy.id = DEFAULT_COLUMN_ID;
    legacy.name = DEFAULT_COLUMN_NAME;
    legacy.isDefault = true;
    const profiles = await getProfiles();
    let touched = false;
    for (const p of profiles) {
      if (p.kanban_column_id === 'selecionados') {
        p.kanban_column_id = DEFAULT_COLUMN_ID;
        touched = true;
      }
    }
    if (touched) await set({ [KEY_PROFILES]: profiles });
    await set({ [KEY_KANBAN_COLUMNS]: cols });
  }

  // Garante que a coluna default sempre existe (mesmo se user tentou apagar)
  if (!cols.find(c => c.id === DEFAULT_COLUMN_ID)) {
    cols.unshift({ id: DEFAULT_COLUMN_ID, name: DEFAULT_COLUMN_NAME, order: 0, isDefault: true });
    await set({ [KEY_KANBAN_COLUMNS]: cols });
  }
  return cols.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function saveKanbanColumns(columns) {
  if (!Array.isArray(columns)) throw new Error('columns deve ser array');
  // Garante default presente
  if (!columns.find(c => c.id === DEFAULT_COLUMN_ID)) {
    columns.unshift({ id: DEFAULT_COLUMN_ID, name: DEFAULT_COLUMN_NAME, order: 0, isDefault: true });
  }
  await set({ [KEY_KANBAN_COLUMNS]: columns });
}

export async function addKanbanColumn(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Nome da coluna obrigatório');
  const cols = await getKanbanColumns();
  // Slug + sufixo único
  const baseId = trimmed.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
  let id = baseId;
  let suffix = 1;
  while (cols.find(c => c.id === id)) {
    suffix++;
    id = `${baseId}_${suffix}`;
  }
  const maxOrder = cols.reduce((m, c) => Math.max(m, c.order || 0), 0);
  cols.push({ id, name: trimmed, order: maxOrder + 1, isDefault: false });
  await set({ [KEY_KANBAN_COLUMNS]: cols });
  return id;
}

export async function renameKanbanColumn(id, newName) {
  const trimmed = String(newName || '').trim();
  if (!trimmed) throw new Error('Nome obrigatório');
  const cols = await getKanbanColumns();
  const col = cols.find(c => c.id === id);
  if (!col) throw new Error('Coluna não encontrada');
  col.name = trimmed;
  await set({ [KEY_KANBAN_COLUMNS]: cols });
}

export async function removeKanbanColumn(id) {
  if (id === DEFAULT_COLUMN_ID) throw new Error('Coluna padrão não pode ser removida');
  const cols = await getKanbanColumns();
  const next = cols.filter(c => c.id !== id);
  await set({ [KEY_KANBAN_COLUMNS]: next });

  // Move cards órfãos da coluna removida pra coluna default
  const profiles = await getProfiles();
  let touched = false;
  for (const p of profiles) {
    if (p.kanban_column_id === id) {
      p.kanban_column_id = DEFAULT_COLUMN_ID;
      touched = true;
    }
  }
  if (touched) await set({ [KEY_PROFILES]: profiles });
}

export async function reorderKanbanColumns(orderedIds) {
  const cols = await getKanbanColumns();
  const byId = Object.fromEntries(cols.map(c => [c.id, c]));
  const next = orderedIds.map((id, idx) => {
    const c = byId[id];
    if (!c) return null;
    return { ...c, order: idx };
  }).filter(Boolean);
  // Anexa qualquer coluna que ficou de fora (defensivo)
  for (const c of cols) {
    if (!orderedIds.includes(c.id)) next.push({ ...c, order: next.length });
  }
  await set({ [KEY_KANBAN_COLUMNS]: next });
}

// ─── Operações em cards (profile.kanban_column_id + notes) ─────────────────

export async function moveProfileToColumn(username, columnId) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex(p => p.username === username);
  if (idx < 0) throw new Error('Perfil não encontrado: ' + username);
  const now = Date.now();
  profiles[idx].kanban_column_id      = columnId;
  profiles[idx].kanban_moved_at       = now;
  profiles[idx].kanban_last_action_at = now; // mudar de coluna conta como ação
  if (!profiles[idx].kanban_added_at) {
    profiles[idx].kanban_added_at = now;
  }
  await set({ [KEY_PROFILES]: profiles });
}

export async function addProfilesToKanban(usernames, columnId = DEFAULT_COLUMN_ID) {
  const profiles = await getProfiles();
  const set_usernames = new Set(usernames || []);
  const now = Date.now();
  let touched = false;
  for (const p of profiles) {
    if (set_usernames.has(p.username)) {
      p.kanban_column_id      = columnId;
      p.kanban_moved_at       = now;
      p.kanban_last_action_at = now;
      if (!p.kanban_added_at) p.kanban_added_at = now; // preserva data do primeiro add
      touched = true;
    }
  }
  if (touched) await set({ [KEY_PROFILES]: profiles });
}

export async function removeFromKanban(username) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex(p => p.username === username);
  if (idx < 0) return;
  profiles[idx].kanban_column_id = null;
  await set({ [KEY_PROFILES]: profiles });
}

export async function addKanbanNote(username, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Nota vazia');
  const profiles = await getProfiles();
  const idx = profiles.findIndex(p => p.username === username);
  if (idx < 0) throw new Error('Perfil não encontrado: ' + username);
  const now = Date.now();
  const notes = profiles[idx].kanban_notes || [];
  notes.unshift({ id: `${now}_${Math.random().toString(36).slice(2,7)}`, ts: now, text: trimmed });
  if (notes.length > 100) notes.length = 100;
  profiles[idx].kanban_notes = notes;
  profiles[idx].kanban_last_action_at = now;
  if (!profiles[idx].kanban_added_at) profiles[idx].kanban_added_at = now;
  await set({ [KEY_PROFILES]: profiles });
  return notes[0];
}

export async function deleteKanbanNote(username, noteId) {
  const profiles = await getProfiles();
  const idx = profiles.findIndex(p => p.username === username);
  if (idx < 0) return;
  const notes = profiles[idx].kanban_notes || [];
  profiles[idx].kanban_notes = notes.filter(n => n.id !== noteId);
  await set({ [KEY_PROFILES]: profiles });
}
