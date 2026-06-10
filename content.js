// content.js — Injetado em todas as páginas do instagram.com
// Responsável por: coletar dados via API interna do Instagram, calcular métricas
// pros filtros locais, enviar DMs, postar comentários e mostrar pill de alerta.

;(function () {
  'use strict';

  // Previne múltiplas instâncias por página
  if (window.__isiHunterLoaded) return;
  window.__isiHunterLoaded = true;

  // ─── Constantes ──────────────────────────────────────────────────────────
  const IG_APP_ID = '936619743392459';
  const RECENT_POSTS_COUNT = 12;

  // ─── Estado local ────────────────────────────────────────────────────────
  let collectingActive = false;
  let stopRequested    = false;

  // ─── Helper para emitir eventos visíveis no log do popup ─────────────────
  function notify(action, extra = {}) {
    try { chrome.runtime.sendMessage({ type: 'PROGRESS', action, ...extra }); } catch (_) {}
  }

  // ─── Reporta falha de fetch IG pro background classificar bloqueio ──────
  function reportIgFailure(status, body) {
    try { chrome.runtime.sendMessage({ type: 'IG_FETCH_FAILED', status, body }); } catch (_) {}
  }

  // ─── Listener de mensagens do background ────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ pong: true, collectingActive });
      return;
    }

    if (msg.type === 'START_COLLECTION') {
      if (!collectingActive) startCollection(msg.hashtag);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'START_LIST_COLLECTION') {
      if (!collectingActive) startListCollection(msg.usernames);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'START_FOLLOWERS_COLLECTION') {
      if (!collectingActive) startFollowersCollection(msg.perfil);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'START_ENGAJAMENTO_COLLECTION') {
      if (!collectingActive) startEngajamentoCollection(msg.perfil, msg.nPosts);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'START_KEYWORDS_COLLECTION') {
      if (!collectingActive) startKeywordsCollection(msg.keywords);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'STOP_COLLECTION') {
      stopRequested = true;
      removePill();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'SEND_DM') {
      sendDirectMessage(msg.username, msg.message)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (msg.type === 'POST_COMMENT') {
      postCommentOnPage(msg.username, msg.comment)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  COLETA DE PERFIS — POR LISTA DE USERNAMES
  // ═══════════════════════════════════════════════════════════════════════════

  async function startListCollection(usernames) {
    collectingActive = true;
    stopRequested    = false;
    injectPill();

    try {
      await collectProfilesFromList(usernames);
      chrome.runtime.sendMessage({ type: 'COLLECTION_DONE' });
    } catch (err) {
      console.error('[IsiHunter] Erro na triagem:', err);
      chrome.runtime.sendMessage({ type: 'COLLECTION_ERROR', error: err.message });
    }

    collectingActive = false;
    removePill();
  }

  async function collectProfilesFromList(usernames) {
    let perfilCount  = 0;
    let fetchFailSeq = 0;
    const pacing     = await newPacingState();

    notify('checking_login', { total: usernames.length });
    if (isLoginWall()) {
      throw new Error('Você não está logado no Instagram. Faça login na aba e tente novamente.');
    }

    for (const username of usernames) {
      if (stopRequested) break;

      if (stopRequested) break;

      if (await isBlacklisted(username)) { notify('skipped_blacklist', { username }); continue; }
      if (await isGreylisted(username))  { notify('skipped_graylist',  { username }); continue; }

      const delays = await getDelaySettings();

      // Pausa entre grupos (com irregularidade extra)
      if (perfilCount > 0 && perfilCount % pacing.tamanhoEfetivo === 0) {
        const pausaMs = randomInt(delays.pausaMinGrupo * 1000, delays.pausaMaxGrupo * 1000);
        notify('long_pause', { pausaSeg: Math.round(pausaMs / 1000), until: Date.now() + pausaMs, kind: 'group' });
        await sleep(pausaMs);
        if (stopRequested) break;

        pacing.grupoCount++;
        // Pausa LONGA a cada 3-5 grupos (camada extra de irregularidade)
        if (pacing.grupoCount >= pacing.proximaPausaLonga) {
          const longaMs = randomInt(2 * 60 * 1000, 5 * 60 * 1000);
          notify('long_pause', { pausaSeg: Math.round(longaMs / 1000), until: Date.now() + longaMs, kind: 'long' });
          await sleep(longaMs);
          if (stopRequested) break;
          pacing.proximaPausaLonga = pacing.grupoCount + randomInt(3, 5);
        }
        // Re-randomiza tamanho do próximo grupo
        pacing.tamanhoEfetivo = irregularGroupSize(delays.tamanhoGrupo);
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

      const profileData = await buildProfileData(username, user);

      const result = await sendToBackground({ type: 'PROFILE_DATA', profileData });
      if (result?.ok === false && result?.error) {
        console.warn('[IsiHunter] Erro no background:', result.error);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  COLETA DE PERFIS — POR SEGUIDORES DE @PERFIL
  // ═══════════════════════════════════════════════════════════════════════════

  const FOLLOWERS_MAX_PAGES = 100;    // ~5000 perfis (50/página) — limite de segurança
  const FOLLOWERS_PAGE_SIZE = 50;

  async function startFollowersCollection(perfil) {
    collectingActive = true;
    stopRequested    = false;
    injectPill();

    try {
      await collectProfilesFromFollowers(perfil);
      chrome.runtime.sendMessage({ type: 'COLLECTION_DONE' });
    } catch (err) {
      console.error('[IsiHunter] Erro na coleta de seguidores:', err);
      chrome.runtime.sendMessage({ type: 'COLLECTION_ERROR', error: err.message });
    }

    collectingActive = false;
    removePill();
  }

  async function collectProfilesFromFollowers(perfil) {
    notify('checking_login', { hashtag: `seguidores de @${perfil}` });

    if (isLoginWall()) {
      throw new Error('Você não está logado no Instagram. Faça login na aba e tente novamente.');
    }

    // 1) Resolve @perfil → user_id
    notify('checking', { username: perfil });
    const { user: targetUser, error: targetErr } = await fetchProfileInfo(perfil);
    if (!targetUser) {
      throw new Error(`Perfil @${perfil} não encontrado (${targetErr || 'erro desconhecido'}).`);
    }
    if (targetUser.is_private) {
      throw new Error(`Perfil @${perfil} é privado — não dá pra ler os seguidores.`);
    }
    const targetId = targetUser.pk || targetUser.id;

    // 2) Itera followers com paginação
    const seenUsernames = new Set();
    let perfilCount    = 0;
    let fetchFailSeq   = 0;
    const pacing       = await newPacingState();
    let nextMaxId      = null;
    let pageCount      = 0;

    while (!stopRequested && pageCount < FOLLOWERS_MAX_PAGES) {
      const page = await fetchFollowersPage(targetId, nextMaxId);
      if (!page.users.length) break;
      pageCount++;

      for (const followerUser of page.users) {
        if (stopRequested) break;

        const username = followerUser.username;
        if (!username || seenUsernames.has(username)) continue;
        seenUsernames.add(username);

        if (await isBlacklisted(username)) { notify('skipped_blacklist', { username }); continue; }
        if (await isGreylisted(username))  { notify('skipped_graylist',  { username }); continue; }
        if (followerUser.is_private)        { notify('private_profile', { username }); continue; }

        const delays = await getDelaySettings();
        perfilCount++;

        // Pausa entre grupos (com irregularidade)
        if (perfilCount % pacing.tamanhoEfetivo === 0) {
          const pausaMs = randomInt(delays.pausaMinGrupo * 1000, delays.pausaMaxGrupo * 1000);
          notify('long_pause', { pausaSeg: Math.round(pausaMs / 1000), until: Date.now() + pausaMs, kind: 'group' });
          await sleep(pausaMs);
          if (stopRequested) break;

          pacing.grupoCount++;
          if (pacing.grupoCount >= pacing.proximaPausaLonga) {
            const longaMs = randomInt(2 * 60 * 1000, 5 * 60 * 1000);
            notify('long_pause', { pausaSeg: Math.round(longaMs / 1000), until: Date.now() + longaMs, kind: 'long' });
            await sleep(longaMs);
            if (stopRequested) break;
            pacing.proximaPausaLonga = pacing.grupoCount + randomInt(3, 5);
          }
          pacing.tamanhoEfetivo = irregularGroupSize(delays.tamanhoGrupo);
        }

        await sleep(randomInt(delays.delayMinPerfil * 1000, delays.delayMaxPerfil * 1000));

        notify('checking', { username });
        const { user, error: profileErr } = await fetchProfileInfo(username);
        if (!user) {
          fetchFailSeq++;
          notify('fetch_failed', { username, error: profileErr });
          if (fetchFailSeq >= 5) {
            throw new Error(`Instagram bloqueou a API (${profileErr || 'erro desconhecido'}). Aguarde e tente novamente.`);
          }
          continue;
        }
        fetchFailSeq = 0;
        if (user.is_private) { notify('private_profile', { username }); continue; }

        const profileData = await buildProfileData(username, user);
        const result = await sendToBackground({ type: 'PROFILE_DATA', profileData });
        if (result?.ok === false && result?.error) {
          console.warn('[IsiHunter] Erro no background:', result.error);
        }
      }

      if (!page.next_max_id) break;
      nextMaxId = page.next_max_id;

      // Pausa curta entre páginas de followers
      await sleep(randomInt(2000, 5000));
    }
  }

  async function fetchFollowersPage(userId, maxId) {
    try {
      const params = `count=${FOLLOWERS_PAGE_SIZE}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`;
      const res = await fetchWithTimeout(
        `/api/v1/friendships/${userId}/followers/?${params}`,
        { headers: igHeaders(), credentials: 'include' }
      );
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (_) {}
        reportIgFailure(res.status, body);
        return { users: [], next_max_id: null };
      }
      const data = await res.json();
      return {
        users: data?.users || [],
        next_max_id: data?.next_max_id || null,
      };
    } catch (err) {
      reportIgFailure(0, err?.message || '');
      return { users: [], next_max_id: null };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  COLETA DE PERFIS — POR PALAVRAS-CHAVE (TOPSEARCH)
  // ═══════════════════════════════════════════════════════════════════════════

  async function startKeywordsCollection(keywords) {
    collectingActive = true;
    stopRequested    = false;
    injectPill();

    try {
      await collectProfilesFromKeywords(keywords);
      chrome.runtime.sendMessage({ type: 'COLLECTION_DONE' });
    } catch (err) {
      console.error('[IsiHunter] Erro na coleta por palavras-chave:', err);
      chrome.runtime.sendMessage({ type: 'COLLECTION_ERROR', error: err.message });
    }

    collectingActive = false;
    removePill();
  }

  async function collectProfilesFromKeywords(keywords) {
    if (!Array.isArray(keywords) || !keywords.length) {
      throw new Error('Nenhuma palavra-chave fornecida.');
    }
    notify('checking_login', { hashtag: `palavras-chave: ${keywords.join(', ')}` });

    if (isLoginWall()) {
      throw new Error('Você não está logado no Instagram. Faça login na aba e tente novamente.');
    }

    // 1) Coleta usernames por palavra-chave via topsearch
    const seenUsernames = new Set();
    const candidatos = []; // [{ username, is_private, source_keyword }]

    for (let i = 0; i < keywords.length; i++) {
      if (stopRequested) break;
      const kw = keywords[i];
      notify('checking', { username: `palavra-chave "${kw}" (${i + 1}/${keywords.length})` });

      const users = await fetchTopsearchUsers(kw);
      for (const u of users) {
        const username = u.username?.toLowerCase();
        if (!username || seenUsernames.has(username)) continue;
        seenUsernames.add(username);
        candidatos.push({ username, is_private: !!u.is_private, kw });
      }

      // Pausa entre buscas (topsearch tem rate limit)
      if (i < keywords.length - 1) await sleep(randomInt(3000, 7000));
    }

    if (!candidatos.length) {
      notify('checking', { username: 'nenhum perfil encontrado nas palavras-chave' });
      return;
    }

    notify('checking', { username: `${candidatos.length} perfis únicos — processando` });

    // 2) Processa cada candidato pelo pipeline padrão (filtros locais via bg)
    let perfilCount  = 0;
    let fetchFailSeq = 0;
    const pacing     = await newPacingState();

    for (const cand of candidatos) {
      if (stopRequested) break;
      const username = cand.username;

      if (await isBlacklisted(username)) { notify('skipped_blacklist', { username }); continue; }
      if (await isGreylisted(username))  { notify('skipped_graylist',  { username }); continue; }
      if (cand.is_private)                { notify('private_profile', { username }); continue; }

      const delays = await getDelaySettings();
      perfilCount++;

      // Pausa entre grupos (com irregularidade)
      if (perfilCount % pacing.tamanhoEfetivo === 0) {
        const pausaMs = randomInt(delays.pausaMinGrupo * 1000, delays.pausaMaxGrupo * 1000);
        notify('long_pause', { pausaSeg: Math.round(pausaMs / 1000), until: Date.now() + pausaMs, kind: 'group' });
        await sleep(pausaMs);
        if (stopRequested) break;

        pacing.grupoCount++;
        if (pacing.grupoCount >= pacing.proximaPausaLonga) {
          const longaMs = randomInt(2 * 60 * 1000, 5 * 60 * 1000);
          notify('long_pause', { pausaSeg: Math.round(longaMs / 1000), until: Date.now() + longaMs, kind: 'long' });
          await sleep(longaMs);
          if (stopRequested) break;
          pacing.proximaPausaLonga = pacing.grupoCount + randomInt(3, 5);
        }
        pacing.tamanhoEfetivo = irregularGroupSize(delays.tamanhoGrupo);
      }

      await sleep(randomInt(delays.delayMinPerfil * 1000, delays.delayMaxPerfil * 1000));

      notify('checking', { username });
      const { user, error: profileErr } = await fetchProfileInfo(username);
      if (!user) {
        fetchFailSeq++;
        notify('fetch_failed', { username, error: profileErr });
        if (fetchFailSeq >= 5) {
          throw new Error(`Instagram bloqueou a API (${profileErr || 'erro desconhecido'}). Aguarde e tente novamente.`);
        }
        continue;
      }
      fetchFailSeq = 0;
      if (user.is_private) { notify('private_profile', { username }); continue; }

      const profileData = await buildProfileData(username, user);
      const result = await sendToBackground({ type: 'PROFILE_DATA', profileData });
      if (result?.ok === false && result?.error) {
        console.warn('[IsiHunter] Erro no background:', result.error);
      }
    }
  }

  // ─── Busca de usuários por palavra-chave via topsearch ───────────────────
  // Retorna [{ pk, username, full_name, is_private, ... }] — até ~50 por query
  async function fetchTopsearchUsers(query) {
    try {
      const url = `/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(query)}`;
      const res = await fetchWithTimeout(url, {
        headers: igHeaders(),
        credentials: 'include',
      });
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (_) {}
        reportIgFailure(res.status, body);
        return [];
      }
      const data = await res.json();
      // Topsearch retorna 'users' como [{ position, user: {...} }]
      const usersWrapper = data?.users || [];
      return usersWrapper.map(u => u.user).filter(Boolean);
    } catch (err) {
      reportIgFailure(0, err?.message || '');
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  COLETA DE PERFIS — POR ENGAJAMENTO EM POSTS DE @PERFIL
  // ═══════════════════════════════════════════════════════════════════════════

  async function startEngajamentoCollection(perfil, nPosts) {
    collectingActive = true;
    stopRequested    = false;
    injectPill();

    try {
      await collectProfilesFromEngagement(perfil, nPosts);
      chrome.runtime.sendMessage({ type: 'COLLECTION_DONE' });
    } catch (err) {
      console.error('[IsiHunter] Erro na coleta de engajamento:', err);
      chrome.runtime.sendMessage({ type: 'COLLECTION_ERROR', error: err.message });
    }

    collectingActive = false;
    removePill();
  }

  async function collectProfilesFromEngagement(perfil, nPosts) {
    notify('checking_login', { hashtag: `engajamento em @${perfil}` });

    if (isLoginWall()) {
      throw new Error('Você não está logado no Instagram. Faça login na aba e tente novamente.');
    }

    // 1) Resolve @perfil → user_id
    notify('checking', { username: perfil });
    const { user: targetUser, error: targetErr } = await fetchProfileInfo(perfil);
    if (!targetUser) {
      throw new Error(`Perfil @${perfil} não encontrado (${targetErr || 'erro desconhecido'}).`);
    }
    if (targetUser.is_private) {
      throw new Error(`Perfil @${perfil} é privado — não dá pra ler os posts.`);
    }
    const targetId = targetUser.pk || targetUser.id;
    const targetUsername = (targetUser.username || perfil).toLowerCase();

    // 2) Pegar últimos N posts
    const safeN = Math.max(1, Math.min(12, Number(nPosts) || 12));
    const posts = await fetchRecentPosts(targetId, safeN);
    if (!posts.length) {
      throw new Error(`@${perfil} não tem posts visíveis.`);
    }

    // 3) Coletar engajadores únicos (likers + commenters) de cada post
    const seenUsernames = new Set([targetUsername]); // exclui o dono
    const engagerList = []; // [{ username, source, is_private }]

    for (let i = 0; i < posts.length; i++) {
      if (stopRequested) break;
      const post = posts[i];
      if (!post.id) continue;

      notify('checking', { username: `post ${i + 1}/${posts.length} — buscando engajadores` });

      // Likers
      const likers = await fetchPostLikers(post.id);
      for (const u of likers) {
        const username = u.username?.toLowerCase();
        if (!username || seenUsernames.has(username)) continue;
        seenUsernames.add(username);
        engagerList.push({ username, source: 'like', is_private: !!u.is_private });
      }

      // Commenters
      const commenters = await fetchPostCommenters(post.id);
      for (const u of commenters) {
        const username = u.username?.toLowerCase();
        if (!username || seenUsernames.has(username)) continue;
        seenUsernames.add(username);
        engagerList.push({ username, source: 'comment', is_private: !!u.is_private });
      }

      // Pausa entre posts
      await sleep(randomInt(2000, 5000));
    }

    if (!engagerList.length) {
      notify('checking', { username: `sem engajadores nos posts de @${perfil}` });
      return;
    }

    notify('checking', { username: `${engagerList.length} engajadores únicos — processando` });

    // 4) Processa cada engajador pelo pipeline padrão (filtros locais via bg)
    let perfilCount  = 0;
    let fetchFailSeq = 0;
    const pacing     = await newPacingState();

    for (const eng of engagerList) {
      if (stopRequested) break;
      const username = eng.username;

      if (await isBlacklisted(username)) { notify('skipped_blacklist', { username }); continue; }
      if (await isGreylisted(username))  { notify('skipped_graylist',  { username }); continue; }
      if (eng.is_private)                 { notify('private_profile', { username }); continue; }

      const delays = await getDelaySettings();
      perfilCount++;

      // Pausa entre grupos (com irregularidade)
      if (perfilCount % pacing.tamanhoEfetivo === 0) {
        const pausaMs = randomInt(delays.pausaMinGrupo * 1000, delays.pausaMaxGrupo * 1000);
        notify('long_pause', { pausaSeg: Math.round(pausaMs / 1000), until: Date.now() + pausaMs, kind: 'group' });
        await sleep(pausaMs);
        if (stopRequested) break;

        pacing.grupoCount++;
        if (pacing.grupoCount >= pacing.proximaPausaLonga) {
          const longaMs = randomInt(2 * 60 * 1000, 5 * 60 * 1000);
          notify('long_pause', { pausaSeg: Math.round(longaMs / 1000), until: Date.now() + longaMs, kind: 'long' });
          await sleep(longaMs);
          if (stopRequested) break;
          pacing.proximaPausaLonga = pacing.grupoCount + randomInt(3, 5);
        }
        pacing.tamanhoEfetivo = irregularGroupSize(delays.tamanhoGrupo);
      }

      await sleep(randomInt(delays.delayMinPerfil * 1000, delays.delayMaxPerfil * 1000));

      notify('checking', { username });
      const { user, error: profileErr } = await fetchProfileInfo(username);
      if (!user) {
        fetchFailSeq++;
        notify('fetch_failed', { username, error: profileErr });
        if (fetchFailSeq >= 5) {
          throw new Error(`Instagram bloqueou a API (${profileErr || 'erro desconhecido'}). Aguarde e tente novamente.`);
        }
        continue;
      }
      fetchFailSeq = 0;
      if (user.is_private) { notify('private_profile', { username }); continue; }

      const profileData = await buildProfileData(username, user);
      const result = await sendToBackground({ type: 'PROFILE_DATA', profileData });
      if (result?.ok === false && result?.error) {
        console.warn('[IsiHunter] Erro no background:', result.error);
      }
    }
  }

  // ─── Likers de um post ────────────────────────────────────────────────────
  async function fetchPostLikers(mediaId) {
    try {
      const res = await fetchWithTimeout(
        `/api/v1/media/${mediaId}/likers/`,
        { headers: igHeaders(), credentials: 'include' }
      );
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (_) {}
        reportIgFailure(res.status, body);
        return [];
      }
      const data = await res.json();
      return data?.users || [];
    } catch (err) {
      reportIgFailure(0, err?.message || '');
      return [];
    }
  }

  // ─── Commenters de um post (até N páginas via max_id) ────────────────────
  const COMMENTS_MAX_PAGES = 3; // ~60 comments por post (geralmente 20/página)

  async function fetchPostCommenters(mediaId, maxPages = COMMENTS_MAX_PAGES) {
    const allUsers = [];
    let maxId = null;
    for (let i = 0; i < maxPages; i++) {
      try {
        const cursor = maxId ? `&max_id=${encodeURIComponent(maxId)}` : '';
        const res = await fetchWithTimeout(
          `/api/v1/media/${mediaId}/comments/?can_support_threading=true${cursor}`,
          { headers: igHeaders(), credentials: 'include' }
        );
        if (!res.ok) {
          let body = '';
          try { body = await res.text(); } catch (_) {}
          reportIgFailure(res.status, body);
          break;
        }
        const data = await res.json();
        const comments = data?.comments || [];
        for (const c of comments) {
          if (c.user) allUsers.push(c.user);
        }
        if (!data?.next_max_id || !comments.length) break;
        maxId = data.next_max_id;
        // Pausa entre páginas (rate limit)
        if (i < maxPages - 1) await sleep(randomInt(1500, 3500));
      } catch (err) {
        reportIgFailure(0, err?.message || '');
        break;
      }
    }
    return allUsers;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  COLETA DE PERFIS — POR HASHTAG
  // ═══════════════════════════════════════════════════════════════════════════

  async function startCollection(hashtag) {
    collectingActive = true;
    stopRequested    = false;
    injectPill();

    try {
      await collectProfilesFromHashtag(hashtag);
      chrome.runtime.sendMessage({ type: 'COLLECTION_DONE' });
    } catch (err) {
      console.error('[IsiHunter] Erro na coleta:', err);
      chrome.runtime.sendMessage({ type: 'COLLECTION_ERROR', error: err.message });
    }

    collectingActive = false;
    removePill();
  }

  async function collectProfilesFromHashtag(hashtag) {
    const seenShortcodes = new Set();
    const seenUsernames  = new Set();
    let perfilCount      = 0;
    let semNovos         = 0;
    let fetchFailSeq     = 0;
    const pacing         = await newPacingState();

    notify('checking_login', { hashtag });

    if (isLoginWall()) {
      throw new Error('Você não está logado no Instagram. Faça login na aba e tente novamente.');
    }

    const primeiroPost = await waitForElement('a[href^="/p/"], a[href^="/reel/"]', 15000);
    if (!primeiroPost) {
      if (isLoginWall()) throw new Error('Você não está logado no Instagram. Faça login na aba e tente novamente.');
      const bodyText = document.body?.innerText?.toLowerCase() || '';
      if (bodyText.includes('esta página não está disponível') || bodyText.includes("page isn't available")) {
        throw new Error(`Hashtag #${hashtag} não disponível no Instagram.`);
      }
      throw new Error(`Nenhum post encontrado para #${hashtag}. O Instagram pode ter bloqueado a hashtag ou exibido captcha.`);
    }
    await sleep(1500);

    while (!stopRequested) {
      const shortcodes      = extractShortcodesFromDOM();
      const novosShortcodes = [...shortcodes].filter(s => !seenShortcodes.has(s));

      if (novosShortcodes.length === 0) {
        semNovos++;
        if (semNovos >= 4) break;
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(2500);
        continue;
      }

      semNovos = 0;
      novosShortcodes.forEach(s => seenShortcodes.add(s));

      for (const shortcode of novosShortcodes) {
        if (stopRequested) break;

        const delays = await getDelaySettings();
        await sleep(randomInt(delays.delayMinPerfil * 1000, delays.delayMaxPerfil * 1000));

        const { username, error: fetchErr } = await getUsernameFromShortcode(shortcode);
        if (!username) {
          fetchFailSeq++;
          notify('shortcode_failed', { shortcode, error: fetchErr });
          if (fetchFailSeq >= 5) {
            throw new Error(`Instagram bloqueou a API (${fetchErr || 'erro desconhecido'}). Aguarde e tente novamente, ou verifique se está logado.`);
          }
          continue;
        }
        fetchFailSeq = 0;
        if (seenUsernames.has(username)) continue;
        seenUsernames.add(username);

        if (await isBlacklisted(username) || await isGreylisted(username)) continue;

        perfilCount++;

        // Pausa entre grupos (com irregularidade extra)
        if (perfilCount % pacing.tamanhoEfetivo === 0) {
          const pausaMs = randomInt(delays.pausaMinGrupo * 1000, delays.pausaMaxGrupo * 1000);
          notify('long_pause', { pausaSeg: Math.round(pausaMs / 1000), until: Date.now() + pausaMs, kind: 'group' });
          await sleep(pausaMs);
          if (stopRequested) break;

          pacing.grupoCount++;
          if (pacing.grupoCount >= pacing.proximaPausaLonga) {
            const longaMs = randomInt(2 * 60 * 1000, 5 * 60 * 1000);
            notify('long_pause', { pausaSeg: Math.round(longaMs / 1000), until: Date.now() + longaMs, kind: 'long' });
            await sleep(longaMs);
            if (stopRequested) break;
            pacing.proximaPausaLonga = pacing.grupoCount + randomInt(3, 5);
          }
          pacing.tamanhoEfetivo = irregularGroupSize(delays.tamanhoGrupo);
        }

        notify('checking', { username });
        const { user, error: profileErr } = await fetchProfileInfo(username);
        if (!user) { notify('fetch_failed', { username, error: profileErr }); continue; }
        if (user.is_private) { notify('private_profile', { username }); continue; }

        const profileData = await buildProfileData(username, user);

        const result = await sendToBackground({ type: 'PROFILE_DATA', profileData });
        if (result?.ok === false && result?.error) {
          console.warn('[IsiHunter] Erro no background:', result.error);
        }
      }

      window.scrollTo(0, document.body.scrollHeight);
      await sleep(2500);
    }
  }

  // ─── Constrói o payload completo de profileData ──────────────────────────
  async function buildProfileData(username, user) {
    const userId        = user.pk || user.id;
    const followerCount = Number(user.follower_count || user.edge_followed_by?.count || 0);
    const posts         = await fetchRecentPosts(userId, RECENT_POSTS_COUNT);
    const metrics       = computeMetrics(posts, followerCount);

    // bio_links: novo formato (array) ou external_url legado (1 link)
    // Cada item do bio_links: { url, title?, link_type?, ... }
    const bioLinks = Array.isArray(user.bio_links) ? user.bio_links : [];

    const followingCount = Number(user.following_count || user.edge_follow?.count || 0);
    const postsCount     = Number(user.media_count     || user.edge_owner_to_timeline_media?.count || 0);

    return {
      username,
      nome:                user.full_name || username,
      url_perfil:          `https://www.instagram.com/${username}/`,
      bio:                 user.biography || '',
      profile_pic_url:     user.profile_pic_url_hd || user.profile_pic_url || '',
      seguidores:          formatFollowers(followerCount),
      seguidores_raw:      followerCount,
      seguindo_raw:        followingCount,
      posts_total:         postsCount,
      is_verified:         !!user.is_verified,
      is_business:         !!user.is_business || !!user.is_business_account,
      category:            user.category || user.business_category_name || '',
      ultimo_post_legenda: posts[0]?.caption || '',
      url_post_recente:    posts[0]?.url     || '',
      data_ultimo_post:    metrics.data_ultimo_post,
      posts_recentes:      metrics.posts_recentes,
      engajamento_pct:     metrics.engajamento_pct,
      // Links da bio (pra extração de contatos no bg)
      external_url:        user.external_url || null,
      bio_links:           bioLinks,
    };
  }

  // ─── Calcula métricas a partir dos posts recentes ────────────────────────
  function computeMetrics(posts, followerCount) {
    if (!posts.length) {
      return { data_ultimo_post: null, posts_recentes: [], engajamento_pct: null };
    }
    const posts_recentes = posts.map(p => ({
      ts:           (p.taken_at || 0) * 1000,   // IG retorna em segundos
      likes:        p.like_count || 0,
      comentarios:  p.comment_count || 0,
      eh_reel:      p.product_type === 'clips' || p.media_type === 2,
    }));
    const data_ultimo_post = Math.max(...posts_recentes.map(p => p.ts)) || null;

    let engajamento_pct = null;
    if (followerCount > 0) {
      const totalInter = posts_recentes.reduce((s, p) => s + p.likes + p.comentarios, 0);
      const mediaInter = totalInter / posts_recentes.length;
      engajamento_pct  = (mediaInter / followerCount) * 100;
    }
    return { data_ultimo_post, posts_recentes, engajamento_pct };
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
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (_) {}
        reportIgFailure(res.status, body);
        return { username: null, error: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const uname = data?.items?.[0]?.user?.username;
      return { username: uname || null, error: uname ? null : 'sem dados' };
    } catch (err) {
      reportIgFailure(0, err?.message || '');
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

      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (_) {}
        reportIgFailure(res.status, body);
        return { user: null, error: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const user = data?.data?.user;
      return { user: user || null, error: user ? null : 'perfil não encontrado' };
    } catch (err) {
      reportIgFailure(0, err?.message || '');
      console.error('[IsiHunter] fetchProfileInfo:', username, err.message);
      return { user: null, error: err?.message || 'erro de rede' };
    }
  }

  // ─── Instagram API: últimos N posts (timestamps, likes, comentários) ─────
  async function fetchRecentPosts(userId, count = RECENT_POSTS_COUNT) {
    try {
      const res = await fetchWithTimeout(
        `/api/v1/feed/user/${userId}/?count=${count}`,
        { headers: igHeaders(), credentials: 'include' }
      );
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (_) {}
        reportIgFailure(res.status, body);
        return [];
      }
      const data  = await res.json();
      const items = data?.items || [];
      return items.map(item => ({
        id:            item.id || item.pk,    // media_id pra likers/comments
        taken_at:      item.taken_at,
        like_count:    item.like_count,
        comment_count: item.comment_count,
        caption:       item.caption?.text || '',
        url:           item.code ? `https://www.instagram.com/p/${item.code}/` : '',
        product_type:  item.product_type,
        media_type:    item.media_type,
      }));
    } catch (_) {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PILL FLUTUANTE NO INSTAGRAM
  // ═══════════════════════════════════════════════════════════════════════════
  function injectPill() {
    if (document.getElementById('isi-hunter-pill')) return;
    const pill = document.createElement('div');
    pill.id = 'isi-hunter-pill';
    pill.textContent = '🤖 IsiHunter coletando — não feche esta aba';
    pill.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
      'background:linear-gradient(135deg,#a855f7,#ec4899)', 'color:#fff',
      'padding:8px 14px', 'border-radius:999px', 'font-size:12px',
      'font-weight:600', 'font-family:-apple-system,system-ui,BlinkMacSystemFont,sans-serif',
      'box-shadow:0 4px 12px rgba(0,0,0,0.25)', 'pointer-events:none',
      'user-select:none', 'letter-spacing:0.2px',
    ].join(';');
    document.body.appendChild(pill);
  }
  function removePill() {
    document.getElementById('isi-hunter-pill')?.remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ENVIO DE DIRECT MESSAGE
  // ═══════════════════════════════════════════════════════════════════════════

  async function sendDirectMessage(username, message) {
    const searchInput = await waitForElement(
      'input[placeholder*="Pesquisar"], input[placeholder*="Search"], input[name="queryBox"]',
      12000
    );
    if (!searchInput) throw new Error('Campo de busca do DM não encontrado');

    await randomDelay(1000, 2000);

    await setReactInput(searchInput, username);
    await randomDelay(1500, 2500);

    const resultItem = await waitForElement(
      '[role="option"], [role="listbox"] button, [data-testid*="result"]',
      6000
    );
    if (!resultItem) throw new Error('Usuário @' + username + ' não encontrado no DM');

    resultItem.click();
    await randomDelay(1000, 2000);

    const nextBtn = findButtonByText(['Avançar', 'Next', 'Chat', 'Open chat']);
    if (nextBtn) {
      nextBtn.click();
      await randomDelay(2000, 3000);
    }

    const msgBox = await waitForElement(
      'div[contenteditable="true"][role="textbox"], textarea[placeholder*="Mensagem"], textarea[placeholder*="Message"]',
      10000
    );
    if (!msgBox) throw new Error('Campo de mensagem do DM não encontrado');

    msgBox.focus();
    await randomDelay(500, 1000);

    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, message);
    await randomDelay(1000, 2000);

    const sendBtn = findButtonByText(['Enviar', 'Send']) ||
                    document.querySelector('button[type="submit"][aria-label*="enviar" i], button[type="submit"][aria-label*="send" i]');

    if (sendBtn) {
      sendBtn.click();
    } else {
      msgBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    }

    await randomDelay(2000, 3000);

    chrome.runtime.sendMessage({ type: 'DM_SENT', username });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  COMENTAR POST
  // ═══════════════════════════════════════════════════════════════════════════

  async function postCommentOnPage(username, comment) {
    const commentInput = await waitForElement(
      'textarea[placeholder*="Adicione um comentário"], textarea[placeholder*="Add a comment"], textarea[placeholder*="comentário"]',
      12000
    );
    if (!commentInput) throw new Error('Campo de comentário não encontrado na página do post');

    commentInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await randomDelay(800, 1500);

    commentInput.click();
    commentInput.focus();
    await randomDelay(600, 1200);

    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, comment);
    await randomDelay(1000, 2000);

    const postBtn = await waitForElement(
      'form button[type="submit"]:not([disabled]), div[role="button"][tabindex="0"]',
      5000
    );

    const submitBtn = postBtn || findButtonByText(['Publicar', 'Post', 'Postar']);
    if (!submitBtn) {
      commentInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })
      );
    } else {
      submitBtn.click();
    }

    await randomDelay(2000, 3000);

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

  function isLoginWall() {
    if (document.querySelector('form input[name="username"][type="text"]')) return true;
    if (location.pathname.startsWith('/accounts/login')) return true;
    return false;
  }

  function formatFollowers(n) {
    n = Number(n);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function randomDelay(min, max) {
    return sleep(randomInt(min, max));
  }

  // ─── Pacing: tamanho de grupo varia ±20% pra não criar padrão ────────────
  function irregularGroupSize(base) {
    const factor = 0.8 + Math.random() * 0.4; // 0.8 a 1.2
    return Math.max(1, Math.round(base * factor));
  }

  async function newPacingState() {
    const delays = await getDelaySettings();
    return {
      grupoCount:         0,
      proximaPausaLonga:  randomInt(3, 5),
      tamanhoEfetivo:     irregularGroupSize(delays.tamanhoGrupo),
    };
  }

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
      const timer = setTimeout(() => {
        if (!done) { done = true; resolve({ ok: false, error: 'bg_timeout' }); }
      }, 120_000);

      function doSend(isRetry) {
        try {
          chrome.runtime.sendMessage(msg, response => {
            const swErr = chrome.runtime.lastError;
            if (done) return;
            if (swErr && !isRetry) {
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
