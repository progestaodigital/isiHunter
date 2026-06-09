// openai.js — módulo de integração com a API da OpenAI
// Importado como ES Module por background.js. Usado SOMENTE pra gerar
// mensagens sob demanda (quebra-gelo, gancho, comentário) — qualificação
// de perfil é feita 100% localmente em filters.js + score.js.

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const MODEL    = 'gpt-4o';

// ─── Mensagem quebra-gelo ─────────────────────────────────────────────────

export async function generateIcebreaker(settings, profile, justificativa) {
  const fitLine = justificativa ? `Motivo do fit com o ICP: ${justificativa}\n` : '';
  const basePrompt = `Você é um especialista em prospecção humanizada no Instagram.

Gere uma mensagem de Direct QUEBRA-GELO para enviar ao perfil abaixo.

Produto/Serviço oferecido: ${settings.produto}
ICP: ${settings.icp}
${fitLine}
Dados do perfil:
- Nome: ${profile.nome}
- Username: @${profile.username}
- Bio: ${profile.bio}
- Legenda do último post: ${profile.ultimo_post_legenda || '(não disponível)'}

Regras absolutas:
- NÃO vender, NÃO mencionar produto, NÃO fazer proposta
- Seja intimista, informal e conversacional
- Demonstre interesse genuíno pelo que a pessoa faz
- Mencione algo específico do perfil ou do conteúdo recente
- Termine com UMA pergunta aberta que revele a principal dor da pessoa
- Máximo 6 linhas no total
- Não mencione que é automação ou IA`;

  // Usa prompt customizado se o usuário configurou
  const finalPrompt = settings.promptIcebreaker
    ? `${settings.promptIcebreaker}\n\n---\nDados do perfil:\n- Nome: ${profile.nome}\n- Bio: ${profile.bio}\n- Legenda do último post: ${profile.ultimo_post_legenda || '(não disponível)'}${justificativa ? `\n- Motivo do fit: ${justificativa}` : ''}\n\nRetorne APENAS a mensagem.`
    : `${basePrompt}\n\nRetorne APENAS a mensagem, sem comentários adicionais.`;

  const data = await callOpenAI(settings.openaiKey, finalPrompt, { temperature: 0.8 });
  return data.choices[0].message.content.trim();
}

// ─── Mensagem gancho ──────────────────────────────────────────────────────

export async function generateHook(settings, profile, justificativa) {
  const fitLine = justificativa ? `Motivo do fit com o ICP: ${justificativa}\n` : '';
  const basePrompt = `Você é um especialista em copywriting de alta conversão no Instagram.

Gere uma mensagem de Direct GANCHO para enviar ao perfil abaixo.

Produto/Serviço oferecido: ${settings.produto}
ICP: ${settings.icp}
${fitLine}
Dados do perfil:
- Nome: ${profile.nome}
- Username: @${profile.username}
- Bio: ${profile.bio}
- Legenda do último post: ${profile.ultimo_post_legenda || '(não disponível)'}

Regras absolutas:
- Seja direto desde o início, respeitando o tempo da pessoa
- Apresente brevemente quem você é e o que oferece
- Mostre um caminho personalizado e específico para ESTE perfil
- Conecte o que você oferece a uma oportunidade concreta para a pessoa
- Termine com uma pergunta que convide à reflexão ou ação
- Máximo 10 linhas
- Tom profissional mas próximo, sem jargões excessivos
- Não mencione que é automação ou IA`;

  const finalPrompt = settings.promptHook
    ? `${settings.promptHook}\n\n---\nDados do perfil:\n- Nome: ${profile.nome}\n- Bio: ${profile.bio}\n- Legenda do último post: ${profile.ultimo_post_legenda || '(não disponível)'}${justificativa ? `\n- Motivo do fit: ${justificativa}` : ''}\n\nRetorne APENAS a mensagem.`
    : `${basePrompt}\n\nRetorne APENAS a mensagem, sem comentários adicionais.`;

  const data = await callOpenAI(settings.openaiKey, finalPrompt, { temperature: 0.75 });
  return data.choices[0].message.content.trim();

}

// ─── Mantido para compatibilidade interna ────────────────────────────────
export const generateMessage = generateIcebreaker;

// ─── Geração de comentário no post recente ────────────────────────────────

export async function generateComment(settings, profile) {
  const prompt = `Você é especialista em engajamento orgânico no Instagram.

Gere um comentário para o post mais recente do perfil abaixo.

Instrução de abordagem: ${settings.instrucaoAbordagem || 'Natural, breve e genuíno'}
Produto/Serviço: ${settings.produto}
ICP: ${settings.icp}

Dados do perfil:
- Nome: ${profile.nome}
- Username: @${profile.username}
- Bio: ${profile.bio}
- Legenda do último post: ${profile.ultimo_post_legenda || '(não disponível)'}
- Motivo do fit com ICP: ${profile.justificativa_icp || ''}

Requisitos do comentário:
- Máximo 2 linhas curtas
- Genuíno, diretamente relacionado ao conteúdo do post
- Não parecer spam ou automação
- Não incluir links ou @ de outros perfis
- Pode usar 1–2 emojis se ficar natural
- NÃO mencionar produto, venda, parceria ou oferta
- NÃO revelar que é automatizado

Retorne APENAS o comentário, sem aspas ou explicações adicionais.`;

  const data = await callOpenAI(settings.openaiKey, prompt, { temperature: 0.85 });
  return data.choices[0].message.content.trim();
}

// ─── Helper HTTP ──────────────────────────────────────────────────────────

async function callOpenAI(apiKey, prompt, extra = {}) {
  if (!apiKey) throw new Error('Chave da API OpenAI não configurada');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      ...extra,
    }),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      msg = err.error?.message || msg;
    } catch (_) {}
    throw new Error(`OpenAI: ${msg}`);
  }

  return res.json();
}
