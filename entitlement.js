// entitlement.js — verificação local do token `entitlement` (JWT EdDSA/Ed25519)
// emitido pelo isipanel no corpo do estado `valid`.
//
// Objetivo: liberar features gated LOCALMENTE enquanto o token for válido,
// sem round-trip ao servidor a cada ação. Verificação 100% offline.
//
// Crypto: @noble/ed25519 vendado em ./vendor/noble-ed25519.js (pure-JS, sem
// eval → CSP-safe pra MV3; sem código remoto). `verifyAsync` usa WebCrypto
// só pro SHA-512 interno (universal entre versões de Chrome); a matemática
// da curva é o noble puro.
//
// NUNCA falhe duro por ausência de token: ausência != erro → fallback pro
// JSON `valid` (tratado em sync.js). Aqui só dizemos "este token confere ou
// não confere".

import * as ed from './vendor/noble-ed25519.js';
import { PUBKEYS } from './entitlementKeys.js';

// ─── Constantes do contrato (shape travado pelo painel) ───────────────────
const EXPECT_ALG  = 'EdDSA';
const EXPECT_ISS  = 'isipanel';
const EXPECT_SLUG = 'isihunter';
const SKEW_S      = 90; // tolerância de relógio adiantado pra iat (segundos)

// ─── base64url helpers (sem dependência de Buffer; atob existe em SW+popup) ─
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

// Resultado padrão
function fail(reason, fallback = false, payload = null) {
  return { valid: false, reason, fallback, payload, timeLeftMs: 0 };
}

/**
 * Núcleo testável: verifica um token contra um mapa { kid -> pubkeyB64url }.
 * @param {string} token       JWT compacto header.payload.signature (base64url)
 * @param {string} localHwid   a MESMA string hwid enviada no /validate
 * @param {object} keymap      { kid -> pubkey base64url (x de 32 bytes) }
 * @param {number} nowMs       relógio (Date.now()); injetável pra teste
 * @returns {Promise<{valid, reason, fallback, payload, timeLeftMs}>}
 *
 * `fallback: true` → caso ambíguo (sem token / kid desconhecido / malformado):
 *   o chamador deve cair pro JSON `valid`, NÃO conceder premium pelo token.
 * `fallback: false` com valid:false → token presente e REPROVADO (assinatura
 *   ruim ou claim inválido): rejeite o token (e caia pro fetch).
 */
export async function verifyWithKeys(token, localHwid, keymap, nowMs = Date.now()) {
  if (!token || typeof token !== 'string') return fail('no_token', true);

  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed', true);

  // 1) Header → kid + alg
  let header;
  try { header = JSON.parse(b64urlToString(parts[0])); }
  catch (_) { return fail('malformed', true); }

  if (header.alg !== EXPECT_ALG) return fail('bad_alg'); // anti alg-confusion
  const kid = header.kid;
  if (!kid) return fail('malformed', true);

  // 2) kid precisa estar no mapa confiável; desconhecido → tratar como ausência
  const pubB64 = keymap?.[kid];
  if (!pubB64) return fail('unknown_kid', true);

  // 3) Verificar ASSINATURA antes de confiar em qualquer claim
  let sig, pub, msg;
  try {
    sig = b64urlToBytes(parts[2]);
    pub = b64urlToBytes(pubB64);
  } catch (_) { return fail('malformed', true); }
  if (sig.length !== 64) return fail('bad_sig');
  if (pub.length !== 32) return fail('bad_key'); // chave embarcada inválida

  msg = new TextEncoder().encode(parts[0] + '.' + parts[1]);

  let sigOk = false;
  try { sigOk = await ed.verifyAsync(sig, msg, pub); }
  catch (_) { return fail('bad_sig'); } // ponto inválido / formato → reprova
  if (!sigOk) return fail('bad_sig');

  // 4) Claims (só depois da assinatura conferir)
  let payload;
  try { payload = JSON.parse(b64urlToString(parts[1])); }
  catch (_) { return fail('malformed', true); }

  const nowS = Math.floor(nowMs / 1000);

  if (payload.status       !== 'valid')        return fail('bad_status', false, payload);
  if (payload.iss          !== EXPECT_ISS)     return fail('bad_iss', false, payload);
  if (payload.product_slug !== EXPECT_SLUG)    return fail('bad_slug', false, payload);
  if (payload.hwid         !== localHwid)      return fail('hwid_mismatch', false, payload);

  if (typeof payload.exp !== 'number')         return fail('no_exp', false, payload);
  if (nowS > payload.exp)                      return fail('expired', false, payload);

  if (typeof payload.iat !== 'number')         return fail('no_iat', false, payload);
  if (payload.iat > nowS + SKEW_S)             return fail('iat_future', false, payload);

  // NÃO faz gating por `edition` — isihunter é single-tier.
  return {
    valid: true,
    reason: 'ok',
    fallback: false,
    payload,
    timeLeftMs: payload.exp * 1000 - nowMs,
  };
}

/**
 * Verificação contra o mapa de chaves embarcado neste build (dev OU prod).
 */
export function verifyEntitlement(token, localHwid, nowMs = Date.now()) {
  return verifyWithKeys(token, localHwid, PUBKEYS, nowMs);
}
