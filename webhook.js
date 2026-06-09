// webhook.js — Envio de leads aprovados para o endpoint externo
// Endpoint e chave configuráveis pelo usuário nas Settings

const WEBHOOK_URL_DEFAULT = 'https://qeljsfjwrphrkabcqppc.supabase.co/functions/v1/lead-webhook';

// ─── Mapeamento IsiHunter → payload da API ────────────────────────────────

function buildPayload(settings, profile) {
  // Prefere score_local (novo pipeline); cai pra pontuacao_icp (modo legado / dados antigos)
  // Arredonda pra inteiro porque a Edge Function antiga espera int (compat retroativa)
  const scoreRaw = profile.score_local ?? profile.pontuacao_icp ?? 0;
  const score    = Math.round(scoreRaw);

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

  // Mensagens podem estar ausentes (novo pipeline geração opcional)
  const icebreaker = profile.mensagem_icebreaker || profile.mensagem_gerada || '';
  const hookMsg    = profile.mensagem_hook       || '';
  const comentario = profile.comentario_gerado   || '';

  // Contatos extraídos (Fase 5a) — vão pra general_notes como texto pra
  // manter compat com a Edge Function existente, que pode rejeitar campos
  // novos não previstos no schema.
  const contatoLinhas = [];
  if (profile.contatos?.emails?.length) {
    contatoLinhas.push(`Emails: ${profile.contatos.emails.join(', ')}`);
  }
  if (profile.contatos?.whatsapps?.length) {
    contatoLinhas.push(`WhatsApps: ${profile.contatos.whatsapps.join(', ')}`);
  }
  if (profile.contatos?.phones?.length) {
    const phonesExtras = profile.contatos.phones.filter(p => !profile.contatos.whatsapps?.includes(p));
    if (phonesExtras.length) contatoLinhas.push(`Telefones: ${phonesExtras.join(', ')}`);
  }
  if (profile.contatos?.grupos_whatsapp?.length) {
    contatoLinhas.push(`Grupos WA: ${profile.contatos.grupos_whatsapp.join(', ')}`);
  }

  // Observações gerais com dados do perfil + contatos extraídos
  const notes = [
    profile.bio        ? `Bio: ${profile.bio}`                : null,
    profile.seguidores ? `Seguidores: ${profile.seguidores}`  : null,
    profile.url_perfil ? `Perfil: ${profile.url_perfil}`      : null,
    ...contatoLinhas,
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

    // ── Conteúdo gerado (opcional — só se mensagens foram geradas) ─────
    recent_post_url:    profile.url_post_recente || undefined,
    suggested_comment:  comentario || undefined,
    icebreaker_message: icebreaker || undefined,
    hook_message:       hookMsg    || undefined,

    // ── Funil e posicionamento ─────────────────────────────────
    funnel_name:        settings.webhookFunnel || undefined,
    stage_name:         settings.webhookStage  || undefined,

    // ── Notas e tags ───────────────────────────────────────────
    general_notes:      notes || undefined,
    tags,
  };

  // Remove campos undefined pra não poluir o payload nem trombar com schema strict
  return Object.fromEntries(
    Object.entries(payload).filter(([_, v]) => v !== undefined)
  );
}

// ─── Envio ────────────────────────────────────────────────────────────────

export async function sendLead(settings, profile) {
  const apiKey   = settings.webhookApiKey?.trim();
  const endpoint = settings.webhookEndpoint?.trim() || WEBHOOK_URL_DEFAULT;

  if (!apiKey)    throw new Error('Chave de API do Webhook não configurada');
  if (!endpoint)  throw new Error('Endpoint do Webhook não configurado');

  const payload = buildPayload(settings, profile);

  let res;
  try {
    res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    apiKey,
      },
      body: JSON.stringify(payload),
    });
  } catch (netErr) {
    console.error('[IsiHunter Webhook] Erro de rede:', netErr, '| endpoint:', endpoint);
    throw new Error(`Webhook: erro de rede (${netErr?.message || 'connection failed'})`);
  }

  if (!res.ok) {
    // Lê body como texto pra log; tenta parse JSON pra mensagem amigável
    let bodyText = '';
    try { bodyText = await res.text(); } catch (_) {}

    // Log detalhado no console do service worker
    console.error('[IsiHunter Webhook] HTTP', res.status, res.statusText,
                  '\nEndpoint:', endpoint,
                  '\nPayload:', payload,
                  '\nResposta:', bodyText);

    // Tenta extrair mensagem amigável
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(bodyText);
      msg = parsed.message || parsed.error || parsed.msg || msg;
      // Se a resposta tem detalhes de campos inválidos, inclui
      if (parsed.errors) msg += ` — ${JSON.stringify(parsed.errors)}`;
      else if (parsed.details) msg += ` — ${JSON.stringify(parsed.details)}`;
    } catch (_) {
      // Body não era JSON — usa snippet do texto
      if (bodyText) msg += ` — ${bodyText.slice(0, 200)}`;
    }
    throw new Error(`Webhook: ${msg}`);
  }

  return res.json().catch(() => ({}));
}
