// filters.js — Filtros locais de qualificação de perfis
// Pure functions: sem deps de chrome.storage, OpenAI ou DOM.
// Importado por background.js (e potencialmente popup.js para preview).
//
// Shape esperado do `profile`:
//   {
//     username, nome, bio,                  // strings
//     seguidores_raw,                       // number — total absoluto de seguidores
//     data_ultimo_post,                     // timestamp ms (Date.now()) | null
//     posts_recentes: [{ ts, likes, comentarios, eh_reel }, ...]  // últimos 12 posts
//     engajamento_pct,                      // number — % média dos posts_recentes | null
//   }
//
// Shape esperado do `filters` (todos opcionais — null/undefined = não filtra):
//   {
//     seguidoresMin, seguidoresMax,         // numbers
//     keywords,                             // array de strings OU CSV
//     ultimoPostDiasMax,                    // number — até X dias atrás
//     postsMin, postsDias,                  // number — >= N posts nos últimos M dias
//     engajamentoMin,                       // number — % mínimo
//   }

// ─── Normalização de texto (case + acento) ─────────────────────────────────

export function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos combinantes (á→a, ç→c)
    .toLowerCase()
    .trim();
}

// ─── Parser de keywords CSV → array ────────────────────────────────────────

export function parseKeywords(input) {
  if (Array.isArray(input)) return input.map(k => String(k).trim()).filter(Boolean);
  if (typeof input === 'string') return input.split(',').map(k => k.trim()).filter(Boolean);
  return [];
}

// ─── Match palavra inteira, case+acento-insensitive ────────────────────────
// Retorna true se QUALQUER keyword for encontrada como palavra inteira no texto.

export function matchesKeyword(text, keywords) {
  const list = parseKeywords(keywords);
  if (!list.length) return false;
  const normText = normalize(text);
  return list.some(kw => {
    const normKw = normalize(kw);
    if (!normKw) return false;
    const escaped = normKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    return re.test(normText);
  });
}

// ─── Gate de filtros ───────────────────────────────────────────────────────
// Retorna { passed: bool, reason?: string }
// Política: filtro só aplica se (a) está configurado E (b) o dado está disponível.
// Dado ausente em filtro configurado = pula esse filtro (não derruba o perfil).

export function passesFilters(profile, filters) {
  // Faixa de seguidores
  if (filters.seguidoresMin != null && profile.seguidores_raw != null
      && profile.seguidores_raw < filters.seguidoresMin) {
    return {
      passed: false,
      reason: 'seguidores_min',
      detail: { actual: profile.seguidores_raw, threshold: filters.seguidoresMin },
    };
  }
  if (filters.seguidoresMax != null && profile.seguidores_raw != null
      && profile.seguidores_raw > filters.seguidoresMax) {
    return {
      passed: false,
      reason: 'seguidores_max',
      detail: { actual: profile.seguidores_raw, threshold: filters.seguidoresMax },
    };
  }

  // Palavra-chave em nome, @ ou bio
  const kws = parseKeywords(filters.keywords);
  if (kws.length > 0) {
    const haystack = `${profile.nome || ''} ${profile.username || ''} ${profile.bio || ''}`;
    if (!matchesKeyword(haystack, kws)) {
      return { passed: false, reason: 'keyword', detail: { keywords: kws } };
    }
  }

  // Data da última publicação
  if (filters.ultimoPostDiasMax != null && profile.data_ultimo_post) {
    const dias = (Date.now() - profile.data_ultimo_post) / 86400000;
    if (dias > filters.ultimoPostDiasMax) {
      return {
        passed: false,
        reason: 'ultimo_post',
        detail: { actual: Math.round(dias), threshold: filters.ultimoPostDiasMax },
      };
    }
  }

  // Frequência de posts
  if (filters.postsMin != null && filters.postsDias != null
      && Array.isArray(profile.posts_recentes)) {
    const corte = Date.now() - (filters.postsDias * 86400000);
    const recentes = profile.posts_recentes.filter(p => p.ts > corte).length;
    if (recentes < filters.postsMin) {
      return {
        passed: false,
        reason: 'frequencia',
        detail: { actual: recentes, threshold: filters.postsMin, dias: filters.postsDias },
      };
    }
  }

  // Taxa de engajamento
  if (filters.engajamentoMin != null && profile.engajamento_pct != null
      && profile.engajamento_pct < filters.engajamentoMin) {
    return {
      passed: false,
      reason: 'engajamento',
      detail: { actual: profile.engajamento_pct, threshold: filters.engajamentoMin },
    };
  }

  return { passed: true };
}

// ─── Helper: lista de filtros que foram efetivamente preenchidos ──────────
// Usado por score.js pra normalizar e pelo popup pra preview/debug.

export function activeFilters(filters) {
  const active = [];
  if (filters.seguidoresMin != null || filters.seguidoresMax != null) active.push('seguidores');
  if (parseKeywords(filters.keywords).length > 0)                     active.push('keyword');
  if (filters.ultimoPostDiasMax != null)                              active.push('recencia');
  if (filters.postsMin != null && filters.postsDias != null)          active.push('frequencia');
  if (filters.engajamentoMin != null)                                 active.push('engajamento');
  return active;
}
