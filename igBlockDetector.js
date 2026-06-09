// igBlockDetector.js — Detecta sinais de bloqueio anti-bot do Instagram.
// Pure functions — chamado por background.js quando content.js reporta falhas.
//
// Sinais monitorados:
//   - HTTP 429 (rate limit explícito)
//   - HTTP 403 (acesso negado)
//   - Body JSON com require_login/checkpoint_required/challenge_required/feedback_required
//   - Sequência de falhas (≥ N erros consecutivos com status problemático)

// Strings que o IG retorna em response.message quando bloqueia
const BLOCK_STRINGS = [
  'checkpoint_required',
  'challenge_required',
  'login_required',
  'feedback_required',
  'please_wait_a_few_minutes',
];

// Classifica uma única falha de fetch. Retorna null se não é bloqueio claro,
// ou { reason, severity } se é.
// severity: 'hard' = bloqueio imediato (1 ocorrência basta)
//           'soft' = sinal fraco (precisa acumular)
export function classifyFailure({ status, body } = {}) {
  if (status === 429) return { reason: 'rate_limit_429', severity: 'hard' };
  if (status === 403) return { reason: 'forbidden_403',  severity: 'hard' };

  const bodyStr = typeof body === 'string' ? body.toLowerCase() : '';
  for (const s of BLOCK_STRINGS) {
    if (bodyStr.includes(s)) return { reason: s, severity: 'hard' };
  }

  // 4xx genérico (não 404) — sinal fraco
  if (status >= 400 && status < 500 && status !== 404) {
    return { reason: `http_${status}`, severity: 'soft' };
  }

  // Timeout, network error — sinal fraco
  if (status == null || status === 0) {
    return { reason: 'network', severity: 'soft' };
  }

  return null;
}

// Decide se uma sequência de falhas configura bloqueio.
// failures: array das últimas N classificações (ordem cronológica)
// Retorna { blocked: bool, reason?: string }
export function shouldTriggerBlock(failures, opts = {}) {
  const SOFT_THRESHOLD = opts.softThreshold ?? 5; // 5 soft seguidos = bloqueio

  if (!failures.length) return { blocked: false };

  // Qualquer hard recente = bloqueio imediato
  const lastHard = failures.find(f => f?.severity === 'hard');
  if (lastHard) return { blocked: true, reason: lastHard.reason };

  // N soft seguidos = bloqueio
  if (failures.length >= SOFT_THRESHOLD
      && failures.slice(-SOFT_THRESHOLD).every(f => f?.severity === 'soft')) {
    return { blocked: true, reason: 'sequencia_falhas' };
  }

  return { blocked: false };
}

// Mensagens user-friendly por motivo (mostradas no popup)
export function blockMessage(reason) {
  const map = {
    rate_limit_429:        'Instagram bloqueou por excesso de requisições (HTTP 429).',
    forbidden_403:         'Instagram bloqueou o acesso (HTTP 403).',
    checkpoint_required:   'Instagram pediu verificação de segurança (checkpoint).',
    challenge_required:    'Instagram pediu verificação adicional (challenge).',
    login_required:        'Sessão do Instagram expirou — faça login de novo.',
    feedback_required:     'Instagram acionou bloqueio anti-spam.',
    please_wait_a_few_minutes: 'Instagram pediu pra aguardar alguns minutos.',
    sequencia_falhas:      'Sequência de falhas detectada — possível bloqueio silencioso.',
    network:               'Falha de rede repetida.',
  };
  return map[reason] || `Bloqueio detectado: ${reason}`;
}
