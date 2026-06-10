// kanban.js — Entry da página standalone do Kanban (chrome-extension://.../kanban.html)
import { refreshKanban, initKanbanHandlers } from './kanbanUI.js';

document.addEventListener('DOMContentLoaded', async () => {
  initKanbanHandlers();

  document.getElementById('btn-kanban-refresh')?.addEventListener('click', () => {
    refreshKanban();
  });

  // Re-renderiza quando perfis mudam em outras abas/popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    // Eventos disparados pelo background quando algo muda no estado de leads/kanban
    if (['LEAD_APPROVED', 'KANBAN_CHANGED', 'PROFILES_CLEARED'].includes(msg.type)) {
      refreshKanban();
    }
  });

  await refreshKanban();
});
