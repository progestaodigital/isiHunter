// score.js — Algoritmo de score local (0-10), substitui o qualifyProfile do OpenAI.
// Pure function: sem deps de chrome.storage ou network.
//
// Cada dimensão contribui 0-2 pts baseado em "quão acima do mínimo aceitável".
// Keyword é binária (todo perfil que passa no filtro tem match) → omitida do score.
// Normalização: score final = (soma / max_possivel) * 10, arredondado a 1 decimal.
// Edge case: nenhum filtro configurado → score = 10 (sem base de comparação).

import { activeFilters } from './filters.js';

export function calculateScore(profile, filters) {
  const dims = [];

  // ── Seguidores: quanto mais perto do max definido, melhor ────────────────
  if (filters.seguidoresMin != null && filters.seguidoresMax != null
      && profile.seguidores_raw != null) {
    const range = filters.seguidoresMax - filters.seguidoresMin;
    if (range > 0) {
      const pos = profile.seguidores_raw - filters.seguidoresMin;
      const clamped = Math.max(0, Math.min(range, pos));
      dims.push({ name: 'seguidores', pts: 2 * (clamped / range) });
    } else {
      // min == max: faixa degenerada, perfil está exatamente no ponto → max pts
      dims.push({ name: 'seguidores', pts: 2 });
    }
  }

  // ── Última publicação: quanto mais recente, melhor ────────────────────────
  if (filters.ultimoPostDiasMax != null && profile.data_ultimo_post) {
    const X = filters.ultimoPostDiasMax;
    const dias = (Date.now() - profile.data_ultimo_post) / 86400000;
    const pts = Math.max(0, Math.min(2, 2 * (X - dias) / X));
    dims.push({ name: 'recencia', pts });
  }

  // ── Frequência de posts: quanto mais acima do mínimo, melhor ─────────────
  if (filters.postsMin != null && filters.postsDias != null
      && Array.isArray(profile.posts_recentes)) {
    const corte = Date.now() - (filters.postsDias * 86400000);
    const M = filters.postsMin;
    const posts = profile.posts_recentes.filter(p => p.ts > corte).length;
    if (M > 0) {
      const pts = Math.max(0, Math.min(2, 2 * (posts - M) / M));
      dims.push({ name: 'frequencia', pts });
    }
  }

  // ── Engajamento: quanto mais acima do mínimo, melhor ─────────────────────
  if (filters.engajamentoMin != null && profile.engajamento_pct != null) {
    const E = filters.engajamentoMin;
    if (E > 0) {
      const pts = Math.max(0, Math.min(2, 2 * (profile.engajamento_pct - E) / E));
      dims.push({ name: 'engajamento', pts });
    } else {
      // Min = 0: qualquer engajamento positivo é max
      dims.push({ name: 'engajamento', pts: profile.engajamento_pct > 0 ? 2 : 0 });
    }
  }

  // ── Edge case: nenhum filtro preenchido ──────────────────────────────────
  if (dims.length === 0) {
    return { score: 10, breakdown: {}, dims_count: 0 };
  }

  const sum = dims.reduce((acc, d) => acc + d.pts, 0);
  const max = dims.length * 2;
  const score = Math.round((sum / max) * 100) / 10;   // 1 casa decimal

  const breakdown = {};
  for (const d of dims) breakdown[d.name] = Math.round(d.pts * 10) / 10;

  return { score, breakdown, dims_count: dims.length };
}

// ─── Helper para UI/debug: mostra quais dimensões foram avaliadas ─────────
export function describeScore(filters) {
  return activeFilters(filters).filter(f => f !== 'keyword');
}
