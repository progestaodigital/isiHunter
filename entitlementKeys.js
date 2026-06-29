// entitlementKeys.js — chaves públicas Ed25519 confiáveis para verificar o
// token `entitlement` (JWT EdDSA) que o isipanel retorna no estado `valid`.
//
// BUILD ÚNICO (dev + prod). Os kids de dev e prod são namespaced e NÃO colidem
// (`isi-ed25519-2026-06` vs `isi-ed25519-prod-2026-06`), então um mesmo binário
// verifica tokens dos dois ambientes — sem troca de arquivo por build.
//
// Tradeoff aceito: a chave de DEV é confiável neste build de prod. Se a chave
// privada de dev vazar, ela poderia forjar um entitlement aceito em produção.
// (Decisão registrada com o painel: kids distintos, build único.)
//
// Rotação: o `kid` é gerado por data (isi-ed25519[-prod]-AAAA-MM). Para rotacionar,
// ADICIONE o novo kid+pubkey aqui (mantendo o antigo durante a transição) e
// remova o velho quando o painel parar de assiná-lo. Mapa { kid -> pubkey }
// suporta N chaves conhecidas simultâneas.
//
// pubkey = base64url do campo `x` (32 bytes) da chave Ed25519 (OKP), formato raw
// que o @noble/ed25519 consome direto. NÃO é o SPKI PEM.

export const BUILD_ENV = 'multi';

export const PUBKEYS = {
  // DEV — servidor de desenvolvimento do isipanel
  'isi-ed25519-2026-06':      'uJNVaOJjkbyJwluIk7n46kbkzUvkr9zgFa0xEuHiCns',

  // PROD — api.isitools.com.br
  'isi-ed25519-prod-2026-06': 'YoNbolc1ExyQJlXY2opb5RG7qxNLz5yqX45Gt-x0ZjE',
};
