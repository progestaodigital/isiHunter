// contactExtractor.js — Extração de dados de contato de bio e bio_links.
// Pure functions: sem deps de chrome.* ou network. Roda no service worker.
//
// Cobertura (Fase 5a, sem fetch externo):
//   - Email direto na bio (incl. ofuscado "x (at) y (dot) com")
//   - Telefone BR na bio (com prefixo +55/55 ou palavra-chave de contexto)
//   - WhatsApp direto em bio_links (wa.me, api.whatsapp.com, web.whatsapp.com)
//   - Grupo de WhatsApp em bio_links (chat.whatsapp.com/...)
//   - mailto: em bio_links
//
// Fase 5b adiciona helpers para extrair contatos de páginas externas:
//   - mergeContacts() — combina dois resultados de extractFromProfile() shape
//   - extractFromUrlsAndText() — recebe lista de hrefs (de page link-in-bio)
//     + texto visível e devolve contatos no mesmo shape de extractFromProfile

// ─── Regex helpers ────────────────────────────────────────────────────────

// Email padrão
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Email ofuscado: "joao (at) gmail (dot) com" / "joao [arroba] gmail [ponto] com"
const EMAIL_OBFUSC_RE = /([A-Za-z0-9._%+-]+)\s*[\(\[]?\s*(?:at|arroba|@)\s*[\)\]]?\s*([A-Za-z0-9.-]+)\s*[\(\[]?\s*(?:dot|ponto|\.)\s*[\)\]]?\s*([A-Za-z]{2,})/gi;

// Telefone com prefixo internacional +55 ou 55 explícito
// Captura: +55 11 99999-9999 / 55 11 99999-9999 / 55 (11) 99999-9999
const PHONE_STRICT_RE = /\+?\s*55[\s.\-]*\(?\s*(\d{2})\s*\)?[\s.\-]*(\d{4,5})[\s.\-]*(\d{4})/g;

// Telefone com palavra-chave de contexto: "tel:", "whats:", emoji 📱, etc.
const PHONE_HINT_RE = /(?:tel(?:efone)?|fone|whats(?:app)?|wpp|cel(?:ular)?|contato|📱|📞|☎️?)[:\s.\-]*\(?\s*(\d{2})\s*\)?[\s.\-]*(\d{4,5})[\s.\-]*(\d{4})/gi;

// URLs diretas do WhatsApp pra número
const WA_DIRECT_REGEXES = [
  /wa\.me\/(\d{8,15})/i,
  /api\.whatsapp\.com\/send\/?\?phone=(\d{8,15})/i,
  /web\.whatsapp\.com\/send\/?\?phone=(\d{8,15})/i,
  /whatsapp\.com\/send\/?\?phone=(\d{8,15})/i,
];

// Convite de grupo WhatsApp
const WA_GROUP_RE = /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i;

// ─── Extractors granulares ────────────────────────────────────────────────

export function extractEmails(text) {
  if (!text) return [];
  const found = new Set();

  const direct = text.match(EMAIL_RE) || [];
  direct.forEach(e => found.add(e.toLowerCase()));

  let mo;
  EMAIL_OBFUSC_RE.lastIndex = 0;
  while ((mo = EMAIL_OBFUSC_RE.exec(text)) !== null) {
    found.add(`${mo[1]}@${mo[2]}.${mo[3]}`.toLowerCase());
  }

  return [...found];
}

export function extractPhones(text) {
  if (!text) return [];
  const found = new Set();
  const collect = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const ddd = m[1];
      const mid = m[2];
      const end = m[3];
      const digits = ddd + mid + end;
      // BR: fixo = 10 dígitos, celular = 11 dígitos
      if (digits.length === 10 || digits.length === 11) {
        found.add('+55' + digits);
      }
    }
  };
  collect(PHONE_STRICT_RE);
  collect(PHONE_HINT_RE);
  return [...found];
}

// Identifica se uma URL é link direto pro WhatsApp.
// Retorna { type: 'phone'|'group', value } ou null.
export function extractWhatsAppFromUrl(url) {
  if (!url) return null;
  const str = String(url);

  for (const re of WA_DIRECT_REGEXES) {
    const m = str.match(re);
    if (m) return { type: 'phone', value: '+' + m[1] };
  }

  const gm = str.match(WA_GROUP_RE);
  if (gm) return { type: 'group', value: `https://chat.whatsapp.com/${gm[1]}` };

  return null;
}

// Extrai email de URL mailto:
export function extractMailtoFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/^mailto:([^\s?]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────

export function extractFromProfile(profile) {
  const emails    = new Set();
  const phones    = new Set();
  const whatsapps = new Set();
  const grupos    = new Set();

  // 1) Texto da bio
  if (profile.bio) {
    extractEmails(profile.bio).forEach(e => emails.add(e));
    extractPhones(profile.bio).forEach(p => phones.add(p));
  }

  // 2) Links da bio (external_url legado + bio_links novo formato)
  const links = [];
  if (profile.external_url) links.push(profile.external_url);
  if (Array.isArray(profile.bio_links)) {
    for (const l of profile.bio_links) {
      if (l?.url) links.push(l.url);
    }
  }

  for (const url of links) {
    const wa = extractWhatsAppFromUrl(url);
    if (wa) {
      if (wa.type === 'phone') whatsapps.add(wa.value);
      else                     grupos.add(wa.value);
      continue;
    }
    const mailto = extractMailtoFromUrl(url);
    if (mailto) emails.add(mailto);
  }

  // 3) Heurística: telefone BR celular na bio é provavelmente WhatsApp
  // Celular BR: +55 + DDD (2) + 9 + 8 dígitos = 14 chars total
  for (const phone of phones) {
    if (phone.length === 14 && /^\+55\d{2}9\d{8}$/.test(phone)) {
      whatsapps.add(phone);
    }
  }

  return {
    emails:           [...emails],
    phones:           [...phones],
    whatsapps:        [...whatsapps],
    grupos_whatsapp:  [...grupos],
    has_contact:      emails.size > 0 || phones.size > 0 || whatsapps.size > 0 || grupos.size > 0,
  };
}

// ─── Fase 5b: extração de URLs + texto coletados de uma página externa ────

// Recebe hrefs (já resolvidos pra absolutos) + texto visível da página.
// Devolve o mesmo shape de extractFromProfile.
export function extractFromUrlsAndText(hrefs, text) {
  const emails    = new Set();
  const phones    = new Set();
  const whatsapps = new Set();
  const grupos    = new Set();

  for (const url of (hrefs || [])) {
    const wa = extractWhatsAppFromUrl(url);
    if (wa) {
      if (wa.type === 'phone') whatsapps.add(wa.value);
      else                     grupos.add(wa.value);
      continue;
    }
    const mailto = extractMailtoFromUrl(url);
    if (mailto) emails.add(mailto);
  }

  if (text) {
    extractEmails(text).forEach(e => emails.add(e));
    extractPhones(text).forEach(p => phones.add(p));
  }

  // Celular BR detectado no texto → também é WhatsApp candidato
  for (const phone of phones) {
    if (phone.length === 14 && /^\+55\d{2}9\d{8}$/.test(phone)) {
      whatsapps.add(phone);
    }
  }

  return {
    emails:           [...emails],
    phones:           [...phones],
    whatsapps:        [...whatsapps],
    grupos_whatsapp:  [...grupos],
    has_contact:      emails.size > 0 || phones.size > 0 || whatsapps.size > 0 || grupos.size > 0,
  };
}

// Combina dois resultados (shape de extractFromProfile) em um só,
// deduplicando. Útil pra mesclar contatos da bio com contatos da página externa.
export function mergeContacts(a, b) {
  const A = a || { emails: [], phones: [], whatsapps: [], grupos_whatsapp: [] };
  const B = b || { emails: [], phones: [], whatsapps: [], grupos_whatsapp: [] };
  const emails    = [...new Set([...(A.emails    || []), ...(B.emails    || [])])];
  const phones    = [...new Set([...(A.phones    || []), ...(B.phones    || [])])];
  const whatsapps = [...new Set([...(A.whatsapps || []), ...(B.whatsapps || [])])];
  const grupos    = [...new Set([...(A.grupos_whatsapp || []), ...(B.grupos_whatsapp || [])])];
  return {
    emails, phones, whatsapps,
    grupos_whatsapp: grupos,
    has_contact: emails.length > 0 || phones.length > 0 || whatsapps.length > 0 || grupos.length > 0,
  };
}
