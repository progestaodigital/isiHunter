// offscreen.js — Documento offscreen para parsing seguro de HTML externo.
// Recebe HTML do background, parseia com DOMParser (sem renderizar scripts),
// extrai apenas href de <a> e devolve a lista. Toda a regex de contato roda
// no background — aqui só fazemos o trabalho que o SW não consegue fazer
// sozinho: ter um DOMParser confiável.

const MAX_LINKS = 200; // limite defensivo

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.type === 'PARSE_HTML') {
    try {
      const result = parseHtml(msg.html || '', msg.baseUrl || '');
      sendResponse({ ok: true, ...result });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return true; // canal síncrono — mas devolve true por segurança
  }
  return false;
});

function parseHtml(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Coleta hrefs (resolve relativos via base se disponível)
  const hrefs = [];
  const anchors = doc.querySelectorAll('a[href]');
  for (let i = 0; i < anchors.length && hrefs.length < MAX_LINKS; i++) {
    const raw = anchors[i].getAttribute('href');
    if (!raw) continue;
    hrefs.push(resolveUrl(raw, baseUrl));
  }

  // Texto visível (sem scripts/styles) — fonte secundária pra regex de email/phone
  // Remove tags ruidosas antes de extrair texto
  doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());
  const text = (doc.body?.innerText || doc.body?.textContent || '').slice(0, 50000);

  return { hrefs, text };
}

function resolveUrl(raw, baseUrl) {
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch (_) {
    return raw;
  }
}
