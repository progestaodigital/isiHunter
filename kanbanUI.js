// kanbanUI.js — Lógica do Kanban/CRM compartilhada entre popup e página standalone.
// ES module. Não depende de DOM ao importar; funções operam em elementos
// quando chamadas.

// ─── Helpers locais ───────────────────────────────────────────────────────

function sendToBg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// Prefere data URL (cacheada localmente, nunca quebra) sobre URL do IG CDN.
function pickProfilePic(profile) {
  return profile?.profile_pic_data || profile?.profile_pic_url || profile?.profile_pic || '';
}

// ─── Estado ───────────────────────────────────────────────────────────────

const state = { columns: [], profiles: [], activeUsername: null };

// ─── API pública ──────────────────────────────────────────────────────────

export async function refreshKanban() {
  const [colsRes, profRes] = await Promise.all([
    sendToBg({ type: 'KANBAN_GET_COLUMNS' }),
    sendToBg({ type: 'GET_PROFILES' }),
  ]);
  state.columns  = colsRes?.columns || [];
  state.profiles = (profRes?.profiles || []).filter(p => p.kanban_column_id);

  await updateKanbanBadge();
  renderKanbanBoard();
}

export async function updateKanbanBadge() {
  const res = await sendToBg({ type: 'GET_PROFILES' });
  const count = (res?.profiles || []).filter(p => p.kanban_column_id).length;
  const badge = document.getElementById('kanban-badge');
  if (!badge) return count;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
  return count;
}

export function renderKanbanBoard() {
  const board   = document.getElementById('kanban-board');
  const empty   = document.getElementById('kanban-empty');
  const counter = document.getElementById('kanban-counter');
  if (!board) return;

  const { columns, profiles } = state;

  if (counter) counter.textContent = profiles.length
    ? `${profiles.length} lead${profiles.length === 1 ? '' : 's'} no Kanban`
    : 'Kanban';

  if (!profiles.length) {
    board.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  const byCol = {};
  for (const c of columns) byCol[c.id] = [];
  for (const p of profiles) {
    const colId = byCol[p.kanban_column_id] ? p.kanban_column_id : columns[0]?.id;
    if (colId) byCol[colId].push(p);
  }
  for (const colId of Object.keys(byCol)) {
    byCol[colId].sort((a, b) => (b.kanban_moved_at || 0) - (a.kanban_moved_at || 0));
  }

  board.innerHTML = '';
  for (const col of columns) {
    board.appendChild(buildKanbanColumn(col, byCol[col.id] || []));
  }
}

function buildKanbanColumn(col, cards) {
  const colEl = document.createElement('div');
  colEl.className = 'kanban-column';
  colEl.dataset.columnId = col.id;

  const isDefault = !!col.isDefault;
  const safeName  = escHtml(col.name);

  colEl.innerHTML = `
    <div class="kanban-col-header">
      <span class="kanban-col-name" data-name>${safeName}</span>
      <span class="kanban-col-count">${cards.length}</span>
      <div class="kanban-col-actions">
        ${isDefault ? '' : `
          <button class="kanban-col-action" data-rename title="Renomear">✎</button>
          <button class="kanban-col-action" data-remove title="Remover">✕</button>
        `}
      </div>
    </div>
    <div class="kanban-cards" data-drop-target></div>
  `;

  const cardsEl = colEl.querySelector('[data-drop-target]');
  for (const card of cards) {
    cardsEl.appendChild(buildKanbanCard(card));
  }

  // Drag-and-drop
  cardsEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    colEl.classList.add('drag-over');
  });
  cardsEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
  cardsEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    colEl.classList.remove('drag-over');
    const username = e.dataTransfer.getData('text/plain');
    if (!username) return;
    await sendToBg({ type: 'KANBAN_MOVE_PROFILE', username, columnId: col.id });
    await refreshKanban();
  });

  // Rename inline
  colEl.querySelector('[data-rename]')?.addEventListener('click', () => {
    const nameEl = colEl.querySelector('[data-name]');
    if (!nameEl) return;
    nameEl.setAttribute('contenteditable', 'true');
    nameEl.focus();
    document.getSelection().selectAllChildren(nameEl);

    const finish = async () => {
      nameEl.removeAttribute('contenteditable');
      const newName = nameEl.textContent.trim();
      if (newName && newName !== col.name) {
        await sendToBg({ type: 'KANBAN_RENAME_COLUMN', id: col.id, name: newName });
        await refreshKanban();
      } else {
        nameEl.textContent = col.name;
      }
    };
    nameEl.onblur = finish;
    nameEl.onkeydown = (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.textContent = col.name; nameEl.blur(); }
    };
  });

  // Remover coluna
  colEl.querySelector('[data-remove]')?.addEventListener('click', async () => {
    const msg = `Remover a coluna "${col.name}"? Os ${cards.length} card(s) voltam pra "Aprovados".`;
    if (!confirm(msg)) return;
    await sendToBg({ type: 'KANBAN_REMOVE_COLUMN', id: col.id });
    await refreshKanban();
  });

  return colEl;
}

function buildKanbanCard(profile) {
  const el = document.createElement('div');
  el.className = 'kanban-card';
  el.draggable = true;
  el.dataset.username = profile.username;

  const initial   = (profile.nome || profile.username || '?')[0].toUpperCase();
  const score     = profile.score_local ?? profile.pontuacao_icp ?? 0;
  const noteCount = (profile.kanban_notes || []).length;
  const hasMsgs   = !!((profile.mensagem_icebreaker || profile.mensagem_gerada || '').trim());
  const pic       = pickProfilePic(profile);
  const c         = profile.contatos || {};
  const hasEmail  = !!(c.emails    && c.emails.length);
  const hasWa     = !!((c.whatsapps && c.whatsapps.length) || (c.grupos_whatsapp && c.grupos_whatsapp.length));
  const addedRel  = profile.kanban_added_at      ? formatRelativeShort(profile.kanban_added_at)      : '';
  const lastRel   = profile.kanban_last_action_at ? formatRelativeShort(profile.kanban_last_action_at) : '';

  const avatarHtml = pic
    ? `<div class="kanban-card-avatar"><img src="${escHtml(pic)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.textContent='${escHtml(initial)}'"></div>`
    : `<div class="kanban-card-avatar">${escHtml(initial)}</div>`;

  el.innerHTML = `
    <div class="kanban-card-row">
      ${avatarHtml}
      <div class="kanban-card-name">
        <div class="kanban-card-handle">@${escHtml(profile.username)}</div>
        ${profile.nome ? `<div class="kanban-card-fullname">${escHtml(profile.nome)}</div>` : ''}
      </div>
      <span class="kanban-card-score">${Number(score).toFixed(1)}</span>
    </div>
    <div class="kanban-card-meta">
      ${profile.seguidores ? `<span>👥 ${escHtml(profile.seguidores)}</span>` : ''}
      ${profile.engajamento_pct != null ? `<span>💬 ${Number(profile.engajamento_pct).toFixed(1)}%</span>` : ''}
      ${hasWa ? `<span class="kanban-card-contactflag wa" title="WhatsApp encontrado">📱</span>` : ''}
      ${hasEmail ? `<span class="kanban-card-contactflag email" title="E-mail encontrado">📧</span>` : ''}
      ${hasMsgs ? `<span class="kanban-card-msgflag">✨ msgs</span>` : ''}
      ${noteCount ? `<span class="kanban-card-noteflag">📝 ${noteCount}</span>` : ''}
    </div>
    <div class="kanban-card-dates">
      ${addedRel ? `<span title="Adicionado ao Kanban">+ ${escHtml(addedRel)}</span>` : ''}
      ${lastRel && lastRel !== addedRel ? `<span title="Última ação registrada">⏱ ${escHtml(lastRel)}</span>` : ''}
    </div>
  `;

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', profile.username);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));

  el.addEventListener('click', () => openKanbanDetail(profile.username));

  return el;
}

function formatRelativeShort(ts) {
  if (!ts) return '';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return '';
  if (diffMs < 60_000)        return 'agora';
  if (diffMs < 3600_000)      return `${Math.floor(diffMs / 60_000)}min`;
  if (diffMs < 86_400_000)    return `${Math.floor(diffMs / 3600_000)}h`;
  const dias = Math.floor(diffMs / 86_400_000);
  if (dias === 1) return 'ontem';
  if (dias < 30)  return `${dias}d`;
  const meses = Math.floor(dias / 30);
  if (meses < 12) return `${meses}m`;
  return `${Math.floor(meses / 12)}a`;
}

// ─── Painel de detalhe (notas + ações) ────────────────────────────────────

export function openKanbanDetail(username) {
  const profile = state.profiles.find(p => p.username === username);
  if (!profile) return;
  state.activeUsername = username;

  const panel  = document.getElementById('kanban-card-detail');
  const nameEl = document.getElementById('kanban-detail-name');
  const metaEl = document.getElementById('kanban-detail-meta');
  const select = document.getElementById('kanban-detail-column');

  if (nameEl) nameEl.innerHTML = `@${escHtml(profile.username)}${profile.nome ? ` <span class="kanban-detail-fullname">— ${escHtml(profile.nome)}</span>` : ''}${profile.is_verified ? ' <span class="verified-badge" title="Verificado">✓</span>' : ''}`;
  if (metaEl) {
    const score = profile.score_local ?? profile.pontuacao_icp ?? 0;
    metaEl.textContent = [
      profile.category ? profile.category : null,
      profile.is_business ? 'Conta comercial' : null,
      `score ${Number(score).toFixed(1)}/10`,
    ].filter(Boolean).join(' · ');
  }

  // Avatar
  const avatarEl = document.getElementById('kanban-detail-avatar');
  if (avatarEl) {
    const pic = pickProfilePic(profile);
    if (pic) {
      avatarEl.src = pic;
      avatarEl.style.display = 'block';
      avatarEl.referrerPolicy = 'no-referrer';
    } else {
      avatarEl.style.display = 'none';
    }
  }

  // Link "Abrir perfil" no Instagram
  const igLink = document.getElementById('kanban-detail-instagram');
  if (igLink) {
    igLink.href = profile.url_perfil || `https://www.instagram.com/${encodeURIComponent(username)}/`;
  }

  // Stats do perfil (seguidores, seguindo, posts, engajamento)
  renderKanbanProfileStats(profile);
  // Bio
  renderKanbanProfileBio(profile);
  // Motivo da aprovação (score breakdown)
  renderKanbanApprovalReason(profile);
  // Contatos extraídos (email, WhatsApp, telefone, grupos WA)
  renderKanbanContacts(profile);

  // Datas
  const addedEl  = document.getElementById('kanban-detail-added');
  const actionEl = document.getElementById('kanban-detail-last-action');
  if (addedEl)  addedEl.textContent  = profile.kanban_added_at       ? formatFullDate(profile.kanban_added_at)       : '—';
  if (actionEl) actionEl.textContent = profile.kanban_last_action_at ? formatFullDate(profile.kanban_last_action_at) : '—';

  if (select) {
    select.innerHTML = state.columns
      .map(c => `<option value="${escHtml(c.id)}" ${c.id === profile.kanban_column_id ? 'selected' : ''}>${escHtml(c.name)}</option>`)
      .join('');
    select.onchange = async () => {
      await sendToBg({ type: 'KANBAN_MOVE_PROFILE', username, columnId: select.value });
      await refreshKanban();
      openKanbanDetail(username);
    };
  }

  renderKanbanMessages(profile);
  renderKanbanNotes(profile);
  if (panel) panel.classList.remove('hidden');
}

// ─── Perfil: stats / bio / motivo de aprovação ────────────────────────────

function renderKanbanProfileStats(profile) {
  const el = document.getElementById('kanban-profile-stats');
  if (!el) return;
  const followers = profile.seguidores || (profile.seguidores_raw != null ? formatNumber(profile.seguidores_raw) : null);
  const following = profile.seguindo_raw != null ? formatNumber(profile.seguindo_raw) : null;
  const posts     = profile.posts_total != null ? formatNumber(profile.posts_total) : null;
  const eng       = profile.engajamento_pct != null ? `${Number(profile.engajamento_pct).toFixed(2)}%` : null;
  const stats = [
    ['Seguidores', followers],
    ['Seguindo',   following],
    ['Posts',      posts],
    ['Engaj.',     eng],
  ].filter(([, v]) => v != null && v !== '');

  el.innerHTML = stats.map(([label, value]) => `
    <div class="profile-stat">
      <div class="profile-stat-value">${escHtml(value)}</div>
      <div class="profile-stat-label">${escHtml(label)}</div>
    </div>
  `).join('');
}

function renderKanbanProfileBio(profile) {
  const el = document.getElementById('kanban-profile-bio');
  if (!el) return;
  const bio = (profile.bio || '').trim();
  if (!bio) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="kanban-detail-section-title">Bio</div>
    <div class="kanban-bio-text">${escHtml(bio)}</div>
  `;
}

function renderKanbanApprovalReason(profile) {
  const wrap = document.getElementById('kanban-profile-approval');
  const list = document.getElementById('kanban-approval-breakdown');
  if (!wrap || !list) return;

  const breakdown = profile.score_breakdown;
  if (!breakdown || typeof breakdown !== 'object') {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');

  const dimensions = [
    { key: 'seguidores',  label: '👥 Tamanho de audiência',  detail: profile.seguidores ? `${profile.seguidores} seguidores` : null },
    { key: 'recencia',    label: '🕒 Atividade recente',     detail: profile.data_ultimo_post ? `último post ${formatRelativeShort(profile.data_ultimo_post)}` : null },
    { key: 'frequencia',  label: '📈 Frequência de posts',   detail: profile.posts_recentes ? `${profile.posts_recentes.length} posts no período` : null },
    { key: 'engajamento', label: '💬 Engajamento',           detail: profile.engajamento_pct != null ? `${Number(profile.engajamento_pct).toFixed(2)}%` : null },
  ];

  list.innerHTML = dimensions
    .filter(d => breakdown[d.key] != null)
    .map(d => {
      const pts = Number(breakdown[d.key]);
      const pct = Math.max(0, Math.min(100, pts / 2 * 100));
      const colorClass = pts >= 1.5 ? 'good' : pts >= 0.8 ? 'mid' : 'low';
      return `
        <div class="approval-row">
          <div class="approval-label">
            <span>${d.label}</span>
            ${d.detail ? `<span class="approval-detail">${escHtml(d.detail)}</span>` : ''}
          </div>
          <div class="approval-bar"><div class="approval-bar-fill ${colorClass}" style="width:${pct}%"></div></div>
          <div class="approval-score">${pts.toFixed(1)}/2</div>
        </div>
      `;
    }).join('');
}

function renderKanbanContacts(profile) {
  const section = document.getElementById('kanban-contacts-section');
  const list    = document.getElementById('kanban-contacts-list');
  if (!section || !list) return;

  const c = profile.contatos || {};
  const emails    = Array.isArray(c.emails)          ? c.emails          : [];
  const whatsapps = Array.isArray(c.whatsapps)       ? c.whatsapps       : [];
  const grupos    = Array.isArray(c.grupos_whatsapp) ? c.grupos_whatsapp : [];
  const phones    = (Array.isArray(c.phones) ? c.phones : []).filter(p => !whatsapps.includes(p));

  const has = emails.length || whatsapps.length || grupos.length || phones.length;
  if (!has) {
    section.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');

  const escAttr = (s) => escHtml(String(s || ''));

  const emailRows = emails.map(e => `
    <a class="contact-pill email" href="mailto:${escAttr(e)}" title="Enviar e-mail">
      <span class="contact-icon">📧</span>
      <span class="contact-value">${escHtml(e)}</span>
      <button class="contact-copy" data-copy="${escAttr(e)}" title="Copiar">📋</button>
    </a>
  `).join('');

  const waRows = whatsapps.map(w => {
    const digits = String(w).replace(/^\+/, '');
    return `
      <a class="contact-pill whatsapp" href="https://wa.me/${escAttr(digits)}" target="_blank" rel="noopener" title="Abrir WhatsApp">
        <span class="contact-icon">📱</span>
        <span class="contact-value">${escHtml(w)}</span>
        <button class="contact-copy" data-copy="${escAttr(w)}" title="Copiar">📋</button>
      </a>
    `;
  }).join('');

  const phoneRows = phones.map(p => `
    <div class="contact-pill phone">
      <span class="contact-icon">☎️</span>
      <span class="contact-value">${escHtml(p)}</span>
      <button class="contact-copy" data-copy="${escAttr(p)}" title="Copiar">📋</button>
    </div>
  `).join('');

  const grupoRows = grupos.map(g => `
    <a class="contact-pill whatsapp" href="${escAttr(g)}" target="_blank" rel="noopener" title="Abrir grupo WhatsApp">
      <span class="contact-icon">👥</span>
      <span class="contact-value">Grupo WhatsApp</span>
    </a>
  `).join('');

  list.innerHTML = waRows + emailRows + phoneRows + grupoRows;

  // Handlers de copy
  list.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const value = btn.getAttribute('data-copy');
      try {
        await navigator.clipboard.writeText(value);
        const original = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = original, 1200);
      } catch (_) {}
    });
  });
}

function formatNumber(n) {
  if (n == null) return '';
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1) + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(num >= 10_000 ? 0 : 1) + 'K';
  return String(num);
}

// ─── Mensagens (geradas via OpenAI) ───────────────────────────────────────

function renderKanbanMessages(profile) {
  const list = document.getElementById('kanban-messages-list');
  if (!list) return;

  const ice   = (profile.mensagem_icebreaker || profile.mensagem_gerada || '').trim();
  const hook  = (profile.mensagem_hook       || '').trim();
  const cmm   = (profile.comentario_gerado   || '').trim();
  const has   = ice || hook || cmm;
  const when  = profile.mensagens_geradas_em ? `Geradas em ${formatFullDate(profile.mensagens_geradas_em)}` : '';

  if (!has) {
    list.innerHTML = `
      <div class="kanban-empty-msgs">
        Nenhuma mensagem gerada ainda. Clique em <strong>✨ Gerar agora</strong> para criar
        quebra-gelo, gancho e comentário automaticamente.
      </div>
    `;
    return;
  }

  list.innerHTML = `
    ${when ? `<div class="kanban-msg-meta">${escHtml(when)}</div>` : ''}
    ${ice ? `
      <div class="kanban-msg-block">
        <div class="kanban-msg-label">🧊 Quebra-gelo</div>
        <div class="kanban-msg-text" data-copy>${escHtml(ice)}</div>
        <button class="kanban-msg-copy" data-copy-text title="Copiar">📋</button>
      </div>
    ` : ''}
    ${hook ? `
      <div class="kanban-msg-block">
        <div class="kanban-msg-label">🎣 Gancho</div>
        <div class="kanban-msg-text" data-copy>${escHtml(hook)}</div>
        <button class="kanban-msg-copy" data-copy-text title="Copiar">📋</button>
      </div>
    ` : ''}
    ${cmm ? `
      <div class="kanban-msg-block">
        <div class="kanban-msg-label">💬 Comentário sugerido</div>
        <div class="kanban-msg-text" data-copy>${escHtml(cmm)}</div>
        <button class="kanban-msg-copy" data-copy-text title="Copiar">📋</button>
      </div>
    ` : ''}
  `;

  list.querySelectorAll('.kanban-msg-block').forEach(block => {
    const btn  = block.querySelector('[data-copy-text]');
    const text = block.querySelector('[data-copy]')?.textContent || '';
    btn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = '📋', 1200);
      } catch (_) {}
    });
  });
}

export function closeKanbanDetail() {
  document.getElementById('kanban-card-detail')?.classList.add('hidden');
  state.activeUsername = null;
}

function renderKanbanNotes(profile) {
  const list = document.getElementById('kanban-notes-list');
  if (!list) return;
  const notes = profile.kanban_notes || [];
  if (!notes.length) {
    list.innerHTML = '<div style="font-size:.82rem;color:var(--text-dim);padding:8px 0;text-align:center">Sem notas ainda.</div>';
    return;
  }
  list.innerHTML = notes.map(n => `
    <div class="kanban-note" data-note-id="${escHtml(n.id)}">
      <div class="kanban-note-header">
        <span class="kanban-note-time">${formatNoteTimestamp(n.ts)}</span>
        <button class="kanban-note-delete" data-delete-note="${escHtml(n.id)}" title="Apagar">apagar</button>
      </div>
      <div class="kanban-note-text">${escHtml(n.text)}</div>
    </div>
  `).join('');

  list.querySelectorAll('[data-delete-note]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noteId = btn.getAttribute('data-delete-note');
      const username = state.activeUsername;
      if (!username || !noteId) return;
      await sendToBg({ type: 'KANBAN_DELETE_NOTE', username, noteId });
      const p = state.profiles.find(x => x.username === username);
      if (p) p.kanban_notes = (p.kanban_notes || []).filter(n => n.id !== noteId);
      renderKanbanNotes(p);
      renderKanbanBoard();
    });
  });
}

function formatNoteTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatFullDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} às ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Wire-up de handlers globais (botões fixos da página) ─────────────────

export function initKanbanHandlers() {
  document.getElementById('btn-kanban-add-col')?.addEventListener('click', async () => {
    const name = prompt('Nome da nova coluna:');
    if (!name?.trim()) return;
    const res = await sendToBg({ type: 'KANBAN_ADD_COLUMN', name: name.trim() });
    if (res?.ok === false) {
      alert(res.error || 'Erro ao criar coluna');
      return;
    }
    await refreshKanban();
  });

  document.getElementById('kanban-detail-back')?.addEventListener('click', closeKanbanDetail);

  document.getElementById('btn-kanban-add-note')?.addEventListener('click', async () => {
    const username = state.activeUsername;
    if (!username) return;
    const input = document.getElementById('kanban-note-input');
    const text  = input?.value?.trim();
    if (!text) return;
    const res = await sendToBg({ type: 'KANBAN_ADD_NOTE', username, text });
    if (res?.ok !== false) {
      const p = state.profiles.find(x => x.username === username);
      if (p) {
        p.kanban_notes = [res.note, ...(p.kanban_notes || [])];
        renderKanbanNotes(p);
        renderKanbanBoard();
      }
      if (input) input.value = '';
    } else {
      alert(res?.error || 'Erro ao salvar nota');
    }
  });

  document.getElementById('kanban-detail-remove')?.addEventListener('click', async () => {
    const username = state.activeUsername;
    if (!username) return;
    if (!confirm(`Remover @${username} do Kanban?`)) return;
    await sendToBg({ type: 'KANBAN_REMOVE_PROFILE', username });
    closeKanbanDetail();
    await refreshKanban();
  });

  // Gerar mensagens via OpenAI (mesmo endpoint que o popup usa)
  document.getElementById('btn-kanban-generate-msgs')?.addEventListener('click', async () => {
    const username = state.activeUsername;
    if (!username) return;
    const btn = document.getElementById('btn-kanban-generate-msgs');
    const original = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Gerando…'; }

    try {
      const res = await sendToBg({ type: 'GENERATE_MESSAGES', usernames: [username] });
      if (res?.ok === false) {
        alert(res?.error === 'license_required'
          ? 'Licença inválida. Verifique na extensão.'
          : (res?.error || 'Erro ao gerar mensagens'));
        return;
      }
      const r = (res?.results || [])[0];
      if (r && !r.ok) {
        alert(r.error || 'Falha ao gerar mensagens. Verifique se a chave OpenAI está configurada na aba Mensagens.');
        return;
      }
      // Refetch profile updated com mensagens
      await refreshKanban();
      openKanbanDetail(username);
    } catch (err) {
      alert(err?.message || 'Erro ao gerar mensagens');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  });
}
