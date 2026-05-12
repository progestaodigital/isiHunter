// webhook.js — Envio de leads aprovados para o endpoint externo
// Endpoint e chave configuráveis pelo usuário nas Settings

const WEBHOOK_URL_DEFAULT = 'https://qeljsfjwrphrkabcqppc.supabase.co/functions/v1/lead-webhook';

// ─── Mapeamento IsiHunter → payload da API ────────────────────────────────

function buildPayload(settings, profile) {
  const score = profile.pontuacao_icp || 0;

  // Temperatura baseada na pontuação de fit
  const temperature =
    score >= 9 ? 'quente' :
    score >= 7 ? 'morno'  : 'frio';

  // Tags base + tags configuradas pelo usuário
  const baseTags = ['IsiHunter'];
  const userTags = settings.webhookTags
    ? settings.webhookTags.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  const tags = [...new Set([...baseTags, ...userTags])];

  // Observações gerais com dados do perfil
  const notes = [
    profile.bio        ? `Bio: ${profile.bio}`                : null,
    profile.seguidores ? `Seguidores: ${profile.seguidores}`  : null,
    profile.url_perfil ? `Perfil: ${profile.url_perfil}`      : null,
  ].filter(Boolean).join('\n');

  const payload = {
    // ── Identificação ──────────────────────────────────────────
    full_name:          profile.nome        || undefined,
    instagram:          profile.username    || undefined,

    // ── Qualificação ───────────────────────────────────────────
    fit_score:          score               || undefined,
    is_qualified:       true,
    temperature,
    lead_status:        'novo',
    origin:             'mineração',

    // ── Contexto de negócio ────────────────────────────────────
    // nicho_detectado vem da análise da IA sobre o perfil do lead
    niche:              profile.nicho_detectado || undefined,
    main_pain:          profile.justificativa_icp || undefined,

    // ── Conteúdo gerado ────────────────────────────────────────
    recent_post_url:    profile.url_post_recente    || undefined,
    suggested_comment:  profile.comentario_gerado   || undefined,
    icebreaker_message: profile.mensagem_icebreaker || profile.mensagem_gerada || undefined,
    hook_message:       profile.mensagem_hook       || undefined,

    // ── Funil e posicionamento ─────────────────────────────────
    funnel_name:        settings.webhookFunnel || undefined,
    stage_name:         settings.webhookStage  || undefined,

    // ── Notas e tags ───────────────────────────────────────────
    general_notes:      notes || undefined,
    tags,
  };

  // Remove campos undefined para não poluir o payload
  return Object.fromEntries(
    Object.entries(payload).filter(([, v]) => v !== undefined)
  );
}

// ─── Envio ────────────────────────────────────────────────────────────────

export async function sendLead(settings, profile) {
  const apiKey   = settings.webhookApiKey?.trim();
  const endpoint = settings.webhookEndpoint?.trim() || WEBHOOK_URL_DEFAULT;

  if (!apiKey)    throw new Error('Chave de API do Webhook não configurada');
  if (!endpoint)  throw new Error('Endpoint do Webhook não configurado');

  const payload = buildPayload(settings, profile);

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      msg = err.message || err.error || msg;
    } catch (_) {}
    throw new Error(`Webhook: ${msg}`);
  }

  return res.json();
}
