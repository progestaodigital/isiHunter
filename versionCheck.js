// versionCheck.js — Detecta novas versões via GitHub Releases API.
// Cache de 1h em chrome.storage.local pra evitar bater no rate limit do GitHub
// (60 req/hour sem auth).
//
// Shape de isi_update_info:
//   { current, latest, available, checkedAt, downloadUrl, name?, body? }

const REPO       = 'progestaodigital/isiHunter';
const CACHE_TTL  = 60 * 60 * 1000; // 1h
const KEY        = 'isi_update_info';
const DISMISS_KEY = 'isi_update_dismissed'; // versão que o user dispensou

export async function checkLatestVersion({ force = false } = {}) {
  const current = chrome.runtime.getManifest().version;

  if (!force) {
    const cached = await getCached();
    if (cached && Date.now() - (cached.checkedAt || 0) < CACHE_TTL) {
      return cached;
    }
  }

  const info = await fetchRelease(current) || await fetchTag(current);
  if (info) {
    await chrome.storage.local.set({ [KEY]: info });
  }
  return info;
}

async function fetchRelease(current) {
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const latest = String(data.tag_name || '').replace(/^v/, '');
    if (!latest) return null;

    // Preferência de download: asset .zip anexado à release > zipball do source code
    const zipAsset = (data.assets || []).find(a =>
      /\.zip$/i.test(a.name || '') && a.browser_download_url
    );
    const zipUrl = zipAsset?.browser_download_url
      || data.zipball_url
      || `https://github.com/${REPO}/archive/refs/tags/v${latest}.zip`;

    return {
      current,
      latest,
      available:   semverGt(latest, current),
      checkedAt:   Date.now(),
      downloadUrl: data.html_url || `https://github.com/${REPO}/releases/tag/v${latest}`,
      zipUrl,
      name:        data.name || `v${latest}`,
      body:        (data.body || '').slice(0, 800),
      publishedAt: data.published_at || null,
    };
  } catch (_) { return null; }
}

async function fetchTag(current) {
  // Fallback se ainda não houver releases formais — usa a tag mais recente
  try {
    const resp = await fetch(`https://api.github.com/repos/${REPO}/tags`, {
      headers: { 'Accept': 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!resp.ok) return null;
    const tags = await resp.json();
    if (!tags?.length) return null;
    // Tags vêm ordenadas (mais recentes primeiro) — ainda assim, pega a maior versão
    const latest = tags
      .map(t => String(t.name || '').replace(/^v/, ''))
      .filter(Boolean)
      .sort(semverCmp)
      .pop();
    if (!latest) return null;
    return {
      current,
      latest,
      available:   semverGt(latest, current),
      checkedAt:   Date.now(),
      downloadUrl: `https://github.com/${REPO}/releases/tag/v${latest}`,
      zipUrl:      `https://github.com/${REPO}/archive/refs/tags/v${latest}.zip`,
      name:        `v${latest}`,
    };
  } catch (_) { return null; }
}

export async function getUpdateInfo() {
  return getCached();
}

export async function dismissUpdate(version) {
  if (!version) return;
  await chrome.storage.local.set({ [DISMISS_KEY]: version });
}

export async function isDismissed(version) {
  if (!version) return false;
  const r = await chrome.storage.local.get(DISMISS_KEY);
  return r[DISMISS_KEY] === version;
}

async function getCached() {
  const r = await chrome.storage.local.get(KEY);
  return r[KEY] || null;
}

// Compara dois semvers ("1.4.0", "1.5.0"). Retorna true se a > b.
function semverGt(a, b) {
  return semverCmp(a, b) > 0;
}

function semverCmp(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
