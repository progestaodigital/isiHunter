// sync.js — módulo interno de sincronização (ES Module)
// Importado por background.js e popup.js

import { verifyEntitlement } from './entitlement.js';

// URL construída em runtime via array de char codes
const __u = [104,116,116,112,115,58,47,47,97,112,105,46,105,115,105,116,111,111,108,115,46,99,111,109,46,98,114,47,118,49,47,108,105,99,101,110,115,101,47,118,97,108,105,100,97,116,101];
const __p = [105,115,105,104,117,110,116,101,114];
function __endpoint() { return String.fromCharCode.apply(null, __u); }
function __slug()     { return String.fromCharCode.apply(null, __p); }

// Storage keys
const K_DEVICE = 'device_uuid';
const K_KEY    = 'license_key';
const K_CACHE  = 'license_status';

// TTLs (ms)
const CACHE_FRESH_MS  = 5  * 60 * 1000;        // 5min — cache considerado "fresco" pra boot
const REFRESH_AHEAD_MS = 30 * 60 * 1000;       // re-arma o token quando faltam <30min pro exp
const ALARM_NAME      = 'licenseCheck';

// Single-flight
let _inflight = null;

// ─── Storage helpers (inline pra não depender de db.js) ───────────────────

function __get(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r));
}
function __set(obj) {
  return new Promise(r => chrome.storage.local.set(obj, r));
}
function __del(keys) {
  return new Promise(r => chrome.storage.local.remove(keys, r));
}

// ─── Fingerprint (device_uuid → SHA-256 hex lowercase) ────────────────────

async function __fp() {
  let { [K_DEVICE]: uuid } = await __get(K_DEVICE);
  if (!uuid) {
    uuid = crypto.randomUUID();
    await __set({ [K_DEVICE]: uuid });
  }
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uuid));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Normalização da chave ─────────────────────────────────────────────────

const KEY_REGEX = /^ISI-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

export function normalizeKey(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!s.startsWith('ISI')) return s; // deixa o regex pegar
  const groups = [s.slice(3, 7), s.slice(7, 11), s.slice(11, 15), s.slice(15, 19)].filter(Boolean);
  return 'ISI-' + groups.join('-');
}

export function isKeyFormatValid(key) {
  return KEY_REGEX.test(key);
}

// ─── Cache ────────────────────────────────────────────────────────────────

async function __readCache() {
  const { [K_CACHE]: c } = await __get(K_CACHE);
  return c || null;
}

async function __writeCache(payload) {
  await __set({ [K_CACHE]: { payload, fetched_at: Date.now() } });
}

async function __dropCache() {
  await __del(K_CACHE);
}

// ─── Validação principal ──────────────────────────────────────────────────

// opts.force: ignora frescor do cache; sempre vai ao servidor (gates de ação)
// opts.silent: usa cache se fresco, evita network desnecessário (boot, popup)
export async function validateLicense(opts = {}) {
  if (_inflight) return _inflight;
  _inflight = __doValidate(opts).finally(() => { _inflight = null; });
  return _inflight;
}

async function __doValidate(opts) {
  const { [K_KEY]: license_key } = await __get(K_KEY);
  if (!license_key) return { status: 'no_key' };

  // Modo silent: se cache fresco e valid, retorna sem fetch
  if (opts.silent) {
    const c = await __readCache();
    if (c && c.payload?.status === 'valid' && (Date.now() - c.fetched_at) < CACHE_FRESH_MS) {
      return c.payload;
    }
  }

  const hwid = await __fp();
  const body = JSON.stringify({ license_key, hwid, product_slug: __slug() });

  let res;
  try {
    res = await fetch(__endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (_) {
    // Network error — sem internet ou DNS falhando
    return { status: 'network_error' };
  }

  // Rate limited
  if (res.status === 429) {
    let retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
    try {
      const j = await res.json();
      retryAfter = retryAfter || j.retry_after_s || 60;
    } catch (_) { retryAfter = retryAfter || 60; }
    return { status: 'rate_limited', retry_after_s: retryAfter };
  }

  // Erro de servidor — tenta cache com grace
  if (res.status >= 500) {
    return await __serverErrorFallback();
  }

  // 400/413/outros 4xx
  if (!res.ok) {
    return { status: 'invalid', message: 'license_or_hardware_invalid' };
  }

  let payload;
  try { payload = await res.json(); }
  catch (_) { return await __serverErrorFallback(); }

  // Cache: só guarda valid; descarta tudo o resto
  if (payload?.status === 'valid') {
    await __writeCache(payload);
  } else {
    await __dropCache();
  }
  return payload;
}

async function __serverErrorFallback() {
  const c = await __readCache();
  if (!c || c.payload?.status !== 'valid') {
    return { status: 'server_error', message: 'isipanel_unavailable' };
  }
  const grace = c.payload.grace_until ? Date.parse(c.payload.grace_until) : 0;
  if (grace && Date.now() < grace) {
    return { ...c.payload, _from_cache: true };
  }
  return { status: 'server_error', message: 'isipanel_unavailable' };
}

// ─── Gates rápidos ────────────────────────────────────────────────────────

// Gate de ação LOCAL-FIRST: se houver um `entitlement` (JWT Ed25519) válido em
// cache, libera offline sem round-trip. Token presente mas reprovado/expirado,
// kid desconhecido, ou ausente → FALLBACK pra validação fresca (comportamento
// anterior; respeita grace_until via __serverErrorFallback).
// Retorna { ok, status, via }.
export async function checkGate() {
  const c = await __readCache();
  const token = c?.payload?.entitlement;

  if (token) {
    const hwid = await __fp();
    const v = await verifyEntitlement(token, hwid).catch(() => null);
    if (v?.valid) {
      // Perto de expirar → re-arma o token em background, sem bloquear a ação
      if (v.timeLeftMs < REFRESH_AHEAD_MS) {
        validateLicense({ force: true }).catch(() => {});
      }
      return { ok: true, status: 'valid', via: 'token' };
    }
    // token reprovado/expirado/kid desconhecido → cai pro fetch abaixo
  }

  // Fallback: validação fresca no servidor (igual ao fluxo anterior)
  const r = await validateLicense({ force: true });
  return { ok: r?.status === 'valid', status: r?.status || 'unknown', via: 'fetch' };
}

// Para gates de ação (compat com chamadas existentes no popup): bool simples
export async function gateAction() {
  return (await checkGate()).ok;
}

// Mascara a license-key pra log/diagnóstico: ISI-****-****-****-XXXX.
// A key NUNCA deve aparecer inteira em log algum.
export function maskKey(k) {
  const s = String(k || '');
  const m = s.match(/^ISI-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-([0-9A-Z]{4})$/i);
  if (m) return `ISI-****-****-****-${m[1].toUpperCase()}`;
  return s ? 'ISI-****-****-****-****' : '';
}

// Para checkpoints periódicos: silent (usa cache fresco)
export async function pulse() {
  const r = await validateLicense({ silent: true });
  return r?.status === 'valid';
}

// ─── Operações de licença ─────────────────────────────────────────────────

export async function saveLicenseKey(key) {
  const norm = normalizeKey(key);
  if (!isKeyFormatValid(norm)) throw new Error('invalid_format');
  await __set({ [K_KEY]: norm });
  return norm;
}

// Trocar chave: limpa license_key + cache, MANTÉM device_uuid
export async function clearLicense() {
  await __del([K_KEY, K_CACHE]);
}

export async function getCurrentStatus() {
  const { [K_KEY]: license_key } = await __get(K_KEY);
  if (!license_key) return { status: 'no_key' };
  const c = await __readCache();
  if (c?.payload) return { ...c.payload, _cached: true, _cached_at: c.fetched_at };
  return { status: 'unknown' };
}

export async function getLicenseKey() {
  const { [K_KEY]: license_key } = await __get(K_KEY);
  return license_key || null;
}

// ─── Bootstrap do alarm ───────────────────────────────────────────────────

export function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, a => {
    if (!a) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 360 });
  });
}

export const ALARM = ALARM_NAME;
