'use strict';
// ============================================================
// Порядок списка диалогов чата — чистые хелперы (без DOM).
// Диалоги, где бот замолчал и отвечает администратор, закреплены
// СВЕРХУ списка и подсвечены красным; внутри каждой группы порядок
// обычный — по свежести последнего сообщения.
//
// Сортировка живёт ТОЛЬКО здесь: сервер отдаёт диалоги в своём порядке,
// но список ещё и перестраивается локально по SSE (новое сообщение,
// смена статуса) — держать то же правило вторым экземпляром в SQL
// значило бы чинить его потом в двух местах.
//
// Юнит-тесты: chat-dialog-sort.test.js (node --test).
// ============================================================

// «Красный» диалог = бот на паузе. Причина не важна: и эскалация Милы,
// и ручной ответ администратора (escalated_reason='operator_reply')
// одинаково означают, что диалог ждёт живого человека.
function chatIsEscalated(d) {
  return !!d && d.agentStatus === 'escalated';
}

function chatSortDialogs(list) {
  const ts = (d) => Number(d && d.lastTs) || 0;
  return [...(list || [])].sort((a, b) =>
    (chatIsEscalated(b) - chatIsEscalated(a)) || (ts(b) - ts(a)));
}

if (typeof window !== 'undefined') {
  window.chatIsEscalated = chatIsEscalated;
  window.chatSortDialogs = chatSortDialogs;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { chatIsEscalated, chatSortDialogs };
}
