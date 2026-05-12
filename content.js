// content.js — Injetado em todas as páginas do instagram.com
// Responsável por: coletar dados via API interna do Instagram e enviar DMs

;(function () {
  'use strict';

  // Previne múltiplas instâncias por página
  if (window.__isiHunterLoaded) return;
  window.__isiHunterLoaded = true;

  // ─── Constantes ──────────────────────────────────────────────────────────
  const IG_APP_ID = '936619743392459';

  // ─── Estado local ────────────────────────────────────────────────────────
  let collectingActive = false;
  let stopRequested    = false;

  // ─── Helper para emitir eventos visíveis no log do popup ─────────────────
  function notify(action, extra = {}) {
    try { chrome.runtime.sendMessage({ type: 'PROGRESS', action, ...extra }); } catch (_) {}
  }

  // ─── Listener de mensagens do background ────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ pong: true, collectingActive });
      return;
    }

    if (msg.type === 'START_COLLECTION') {
      if (!collectingActive) {
        startCollection(msg.hashtag);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'START_LIST_COLLECTION') {
      if (!collectingActive) {
        startListCollection(msg.usernames);
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'STOP_COLLECTION') {
      stopRequested = true;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'SEND_DM') {
      sendDirectMessage(msg.username, msg.message)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true; // Canal assíncrono
    }

    if (msg.type === 'POST_COMMENT') {
      postCommentOnPage(msg.username, msg.comment)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true; // Canal assíncrono
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  COLETA DE PERFIS
  // ═══════════════════════════════════════════════════════════════════════════

  async function startListCollection(usernames) {
    collectingActive = true;
    stopRequested    = false;

    try {
      await collectProfilesFromList(usernames);
      chrome.runtime.sendMessage({ type: 'COLLECTION_DONE' });
    } catch (err) {
      console.error('[IsiHunter] Erro na triagem:', err);
      chrome.runtime.sendMessage({ type: 'COLLECTION_ERROR', error: err.message });
    }

    collectingActive = false;
  }

  async function collectProfilesFromList(usernames) {
    let perfilCount  = 0;
    let fetchFailSeq = 0;

    notify('checking_login', { total: usernames.length });
    if (isLoginWall()) {
      throw new Error('Você não está logado no Instagram. Faça login na aba e tente novamente.');
    }

    for (const username of usernames) {
      if (stopRequested) break;

      const statsCheck = await getStats();
      if (statsCheck.approved >= await getMeta()) break;

      if (await isBlacklisted(username)) { notify('skipped_blacklist', { username }); continue; }
      if (await isGreylisted(username))  { notify('skipped_graylist',  { username }); continue; }

      const delays = await getDelaySettings();

      // Pausa longa a cada N perfis
      if (perfilCount > 0 && perfilCount % delays.tamanhoGrupo === 0) {
        const pausaMs = randomInt(delays.pausaMinGrupo * 1000, delays.pausaMaxGrupo * 1000);
        notify('long_pause', { pausaSeg: Math.round(pausaMs / 1000) });
        await sleep(pausaMs);
        if (stopRequested) break;
      }

      await sleep(randomInt(delays.delayMinPerfil * 1000, delays.delayMaxPerfil * 1000));
      perfilCount++;

      notify('checking', { username });
      const { user, error: profileErr } = await fetchProfileInfo(username);
      if (!user) {
        fetchFailSeq++;
        notify('fetch_failed', { username, error: profileErr });
        if (fetchFailSeq >= 5) {
          throw new Error(`Instagram bloqueou a API (${profileErr || 'erro desconhecido'}). Aguarde e tente novamente, ou verifique se está logado.`);
        }
        continue;
      }
      fetchFailSeq = 0;
      if (user.is_private) { notify('private_profile', { username }); continue; }

      const latestPost = await fetchLatestPost(user.pk || user.id);

      const profileData = {
        username,
        nome:                user.full_name || username,
        url_perfil:          `https://www.instagram.com/${username}/`,
        bio:                 user.biography || '',
        seguidores:          formatFollowers(user.follower_count || user.edge_followed_by?.count || 0),
        ultimo_post_legenda: latestPost.caption,
        url_post_recente:    latestPost.url,
      };

      const result = await sendToBackground({ type: 'PROFILE_DATA', profileData });
      if (result?.ok === false && result?.error) {
        console.warn('[IsiHunter] Erro no background:', result.error);
      }
    }
  }

  async function startCollection(hashtag) {
    collectingActive = true;
    stopRequested    = false;

    try {
      await collectProfilesFromHashtag(hashtag);
      // Encerrou naturalmente (sem mais páginas, sem erro, sem meta atingida)
      chrome.runtime.sendMessage({ type: 'COLLECTION_DONE' });
    } catch (err) {
      console.error('[IsiHunter] Erro na coleta:', err);
      chrome.runtime.sendMessage({ type: 'COLLECTION_ERROR', error: err.message });
    }

    collectingActive = false;
  }

  async function collectProfilesFromHashtag(hashtag) {
    const seenShortcodes = new Set();
    const seenUsernames  = new Set();
    let perfilCount      = 0;
    let semNovos         = 0;
    let fetchFailSeq     = 0; // sequência de falhas em getUsernameFromShortcode

    notify('checking_login', { hashtag });

    // Detecta login wall / bloqueio: se a página tiver "Entrar" ou form de login, avisa
    if (isLoginWall()) {
      throw new Error('Você não está logado no Instagram. Faça login na aba e tente novamente.');
    }

    // Aguarda os posts renderizarem na página da hashtag (inclui reels)
    const primeiroPost = await waitForElement('a[href^="/p/"], a[href^="/reel/"]', 15000);
    if (!primeiroPost) {
      // Diagnostica: login wall, sem resultados, ou hashtag inexistente
      if (isLoginWall()) throw new Error('Você não está logado no Instagram. Faça login na aba e tente novamente.');
      const bodyText = document.body?.innerText?.toLowerCase() || '';
      if (bodyText.includes('esta página não está disponível') || bodyText.includes("page isn't available")) {
        throw new Error(`Hashtag #${hashtag} não disponível no Instagram.`);
      }
      throw new Error(`Nenhum post encontrado para #${hashtag}. O Instagram pode ter bloqueado a hashtag ou exibido captcha.`);
    }
    await sleep(1500);

    while (!stopRequested) {
      const stats = await getStats();
      const meta  = await getMeta();
      if (stats.approved >= meta) break;

      // Extrai shortcodes dos links de posts visíveis (estão no HTML simples)
      const shortcodes    = extractShortcodesFromDOM();
      const novosShortcodes = [...shortcodes].filter(s => !seenShortcodes.has(s));

      if (novosShortcodes.length === 0) {
        semNovos++;
        if (semNovos >= 4) break; // 4 scrolls sem novos posts = fim da hashtag
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(2500);
        continue;
      }

      semNovos = 0;
      novosShortcodes.forEach(s => seenShortcodes.add(s));

      for (const shortcode of novosShortcodes) {
        if (stopRequested) break;

        const statsCheck = await getStats();
        if (statsCheck.approved >= await getMeta()) { stopRequested = true; break; }

        // Delay entre posts (anti-detecção)
        const delays = await getDelaySettings();
        await sleep(randomInt(delays.delayMinPerfil * 1000, delays.delayMaxPerfil * 1000));

        // Obtém username via endpoint de info de mídia individual
        const { username, error: fetchErr } = await getUsernameFromShortcode(shortcode);
        if (!username) {
          fetchFailSeq++;
          notify('shortcode_failed', { shortcode, error: fetchErr });
          // Se falharmos 5x seguidas, é provável que a API esteja bloqueando — aborta
          if (fetchFailSeq >= 5) {
            throw new Error(`Instagram bloqueou a API (${fetchErr || 'erro desconhecido'}). Aguarde e tente novamente, ou verifique se está logado.`);
          }
          continue;
        }
        fetchFailSeq = 0;
        if (seenUsernames.has(username)) continue;
        seenUsernames.add(username);

        // Verifica blacklist e graylist
        if (await isBlacklisted(username) || await isGreylisted(username)) continue;

        // Pausa longa a cada N perfis
        perfilCount++;
        if (perfilCount % delays.tamanhoGrupo === 0) {
          const pausaMs = randomInt(delays.pausaMinGrupo * 1000, delays.pausaMaxGrupo * 1000);
          notify('long_pause', { pausaSeg: Math.round(pausaMs / 1000) });
          await sleep(pausaMs);
          if (stopRequested) break;
        }

        // Busca dados completos do perfil via API
        notify('checking', { username });
        const { user, error: profileErr } = await fetchProfileInfo(username);
        if (!user) { notify('fetch_failed', { username, error: profileErr }); continue; }
        if (user.is_private) { notify('private_profile', { username }); continue; }

        const latestPost = await fetchLatestPost(user.pk || user.id);

        const profileData = {
          username,
          nome:                user.full_name || username,
          url_perfil:          `https://www.instagram.com/${username}/`,
          bio:                 user.biography || '',
          seguidores:          formatFollowers(user.follower_count || user.edge_followed_by?.count || 0),
          ultimo_post_legenda: latestPost.caption,
          url_post_recente:    latestPost.url,
        };

        const result = await sendToBackground({ type: 'PROFILE_DATA', profileData });
        if (result?.ok === false && result?.error) {
          console.warn('[IsiHunter] Erro no background:', result.error);
        }
      }

      // Scroll para carregar mais posts
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(2500);
    }
  }

  // ─── Extrai shortcodes dos links de post visíveis na grade ───────────────
  function extractShortcodesFromDOM() {
    const shortcodes = new Set();
    document.querySelectorAll('a[href^="/p/"]').forEach(a => {
      const match = a.getAttribute('href').match(/^\/p\/([^/]+)\//);
      if (match) shortcodes.add(match[1]);
    });
    return shortcodes;
  }

  // ─── Converte shortcode → username via API de mídia individual ───────────
  async function getUsernameFromShortcode(shortcode) {
    try {
      const mediaId = shortcodeToMediaId(shortcode);
      const res = await fetchWithTimeout(`/api/v1/media/${mediaId}/info/`, {
        headers: igHeaders(),
        credentials: 'include',
      });
      if (!res.ok) return { username: null, error: `HTTP ${res.status}` };
      const data = await res.json();
      const uname = data?.items?.[0]?.user?.username;
      return { username: uname || null, error: uname ? null : 'sem dados' };
    } catch (err) {
      return { username: null, error: err?.message || 'erro de rede' };
    }
  }

  // ─── Decodifica shortcode base64 → ID numérico do Instagram ─────────────
  function shortcodeToMediaId(shortcode) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = BigInt(0);
    for (const c of shortcode) {
      id = id * 64n + BigInt(CHARS.indexOf(c));
    }
    return id.toString();
  }

  // ─── Instagram API: informações do perfil ────────────────────────────────
  async function fetchProfileInfo(username) {
    try {
      const res = await fetchWithTimeout(
        `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        { headers: igHeaders(), credentials: 'include' }
      );

      if (!res.ok) return { user: null, error: `HTTP ${res.status}` };
      const data = await res.json();
      const user = data?.data?.user;
      return { user: user || null, error: user ? null : 'perfil não encontrado' };
    } catch (err) {
      console.error('[IsiHunter] fetchProfileInfo:', username, err.message);
      return { user: null, error: err?.message || 'erro de rede' };
    }
  }

  // ─── Instagram API: último post (caption + URL) ──────────────────────────
  async function fetchLatestPost(userId) {
    try {
      const res = await fetchWithTimeout(
        `/api/v1/feed/user/${userId}/?count=1`,
        { headers: igHeaders(), credentials: 'include' }
      );
      if (!res.ok) return { caption: '', url: '' };
      const data  = await res.json();
      const item  = data?.items?.[0];
      const code  = item?.code || '';
      return {
        caption: item?.caption?.text || '',
        url:     code ? `https://www.instagram.com/p/${code}/` : '',
      };
    } catch (_) {
      return { caption: '', url: '' };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ENVIO DE DIRECT MESSAGE
  // ═══════════════════════════════════════════════════════════════════════════

  async function sendDirectMessage(username, message) {
    // 1. Aguarda campo de busca do DM aparecer
    const searchInput = await waitForElement(
      'input[placeholder*="Pesquisar"], input[placeholder*="Search"], input[name="queryBox"]',
      12000
    );
    if (!searchInput) throw new Error('Campo de busca do DM não encontrado');

    await randomDelay(1000, 2000);

    // 2. Digita o username
    await setReactInput(searchInput, username);
    await randomDelay(1500, 2500);

    // 3. Aguarda resultados e clica no primeiro
    const resultItem = await waitForElement(
      '[role="option"], [role="listbox"] button, [data-testid*="result"]',
      6000
    );
    if (!resultItem) throw new Error('Usuário @' + username + ' não encontrado no DM');

    resultItem.click();
    await randomDelay(1000, 2000);

    // 4. Clica em "Avançar" / "Next" / "Chat"
    const nextBtn = findButtonByText(['Avançar', 'Next', 'Chat', 'Open chat']);
    if (nextBtn) {
      nextBtn.click();
      await randomDelay(2000, 3000);
    }

    // 5. Aguarda caixa de texto
    const msgBox = await waitForElement(
      'div[contenteditable="true"][role="textbox"], textarea[placeholder*="Mensagem"], textarea[placeholder*="Message"]',
      10000
    );
    if (!msgBox) throw new Error('Campo de mensagem do DM não encontrado');

    msgBox.focus();
    await randomDelay(500, 1000);

    // 6. Insere o texto
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, message);
    await randomDelay(1000, 2000);

    // 7. Envia (botão ou Enter)
    const sendBtn = findButtonByText(['Enviar', 'Send']) ||
                    document.querySelector('button[type="submit"][aria-label*="enviar" i], button[type="submit"][aria-label*="send" i]');

    if (sendBtn) {
      sendBtn.click();
    } else {
      msgBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    }

    await randomDelay(2000, 3000);

    // 8. Notifica background
    chrome.runtime.sendMessage({ type: 'DM_SENT', username });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  COMENTAR POST
  // ═══════════════════════════════════════════════════════════════════════════

  async function postCommentOnPage(username, comment) {
    // Aguarda a seção de comentários da página do post
    // O Instagram renderiza o campo de comentário no rodapé do post
    const commentInput = await waitForElement(
      'textarea[placeholder*="Adicione um comentário"], textarea[placeholder*="Add a comment"], textarea[placeholder*="comentário"]',
      12000
    );
    if (!commentInput) throw new Error('Campo de comentário não encontrado na página do post');

    // Rola até o campo para garantir visibilidade
    commentInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await randomDelay(800, 1500);

    // Clica para focar/expandir o campo
    commentInput.click();
    commentInput.focus();
    await randomDelay(600, 1200);

    // Digita o comentário
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, comment);
    await randomDelay(1000, 2000);

    // Aguarda o botão "Publicar" / "Post" ficar disponível
    const postBtn = await waitForElement(
      'form button[type="submit"]:not([disabled]), div[role="button"][tabindex="0"]',
      5000
    );

    // Se não encontrou o seletor genérico, busca por texto
    const submitBtn = postBtn || findButtonByText(['Publicar', 'Post', 'Postar']);
    if (!submitBtn) {
      // Tenta Enter como fallback
      commentInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })
      );
    } else {
      submitBtn.click();
    }

    await randomDelay(2000, 3000);

    // Notifica background
    chrome.runtime.sendMessage({ type: 'COMMENT_POSTED', username });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  // Fetch com timeout — evita travamento quando o Instagram não responde
  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  function igHeaders() {
    return {
      'X-IG-App-ID':      IG_APP_ID,
      'X-ASBD-ID':        '129477',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept':           '*/*',
      'Referer':          'https://www.instagram.com/',
    };
  }

  // Detecta se a página atual é um login wall / modal de login
  function isLoginWall() {
    // Form de login com input name="username" é o padrão do IG
    if (document.querySelector('form input[name="username"][type="text"]')) return true;
    // URL explícita de login
    if (location.pathname.startsWith('/accounts/login')) return true;
    return false;
  }


  function formatFollowers(n) {
    n = Number(n);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
  }

  // Gera inteiro aleatório entre min e max (inclusive)
  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // Mantido para compatibilidade com o código de DM/comentário
  function randomDelay(min, max) {
    return sleep(randomInt(min, max));
  }

  // Lê os parâmetros de delay configurados pelo usuário
  function getDelaySettings() {
    return new Promise(resolve =>
      chrome.storage.local.get('isi_settings', r => {
        const s = r.isi_settings || {};
        resolve({
          delayMinPerfil: s.delayMinPerfil ?? 3,
          delayMaxPerfil: s.delayMaxPerfil ?? 7,
          pausaMinGrupo:  s.pausaMinGrupo  ?? 30,
          pausaMaxGrupo:  s.pausaMaxGrupo  ?? 90,
          tamanhoGrupo:   s.tamanhoGrupo   ?? 10,
        });
      })
    );
  }

  function getStats() {
    return new Promise(resolve =>
      chrome.storage.local.get('isi_stats', r => resolve(r.isi_stats || { approved: 0 }))
    );
  }

  function getMeta() {
    return new Promise(resolve =>
      chrome.storage.local.get('isi_settings', r => resolve(r.isi_settings?.metaPerfis || 20))
    );
  }

  async function isBlacklisted(username) {
    return new Promise(resolve =>
      chrome.storage.local.get('isi_blacklist', r => resolve(!!(r.isi_blacklist || {})[username]))
    );
  }

  async function isGreylisted(username) {
    return new Promise(resolve =>
      chrome.storage.local.get('isi_graylist', r => {
        const expiry = (r.isi_graylist || {})[username];
        resolve(!!expiry && Date.now() < expiry);
      })
    );
  }

  function sendToBackground(msg) {
    return new Promise(resolve => {
      let done = false;

      // Segurança: se o background não responder em 120 s, desbloqueia o loop
      const timer = setTimeout(() => {
        if (!done) { done = true; resolve({ ok: false, error: 'bg_timeout' }); }
      }, 120_000);

      function doSend(isRetry) {
        try {
          chrome.runtime.sendMessage(msg, response => {
            const swErr = chrome.runtime.lastError; // sempre consumir
            if (done) return;
            if (swErr && !isRetry) {
              // Service worker foi morto — aguarda reinício e tenta uma vez
              setTimeout(() => doSend(true), 2500);
            } else {
              done = true;
              clearTimeout(timer);
              resolve(response || {});
            }
          });
        } catch (e) {
          if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }); }
        }
      }

      doSend(false);
    });
  }

  function waitForElement(selector, timeout = 5000) {
    return new Promise(resolve => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });

      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
    });
  }

  // Compatível com inputs controlados pelo React
  function setReactInput(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findButtonByText(texts) {
    const allBtns = [...document.querySelectorAll('button, div[role="button"]')];
    return allBtns.find(b =>
      texts.some(t => b.textContent?.trim().toLowerCase().includes(t.toLowerCase()))
    ) || null;
  }

})();
