'use strict';
// ============================================================
// Статус ожидания ответа клиента — чистые хелперы (без DOM).
// Статус переписки НЕ хранится отдельным полем: он ВЫВОДИТСЯ из строки
// очереди agent_followups (followupStatus/followupStage) и статуса агента
// (agentStatus) на КАЖДОМ рендере — список ещё и перестраивается локально
// по SSE (chat-dialog-sort.js — тот же приём и то же обоснование: держать
// правило вторым экземпляром в SQL значило бы чинить его потом в двух
// местах).
//
// Юнит-тесты: chat-wait-status.test.js (node --test).
// ============================================================

// Диалог на операторе перекрывает ЛЮБОЙ статус ожидания: там ждут НАС,
// а не клиента, и чип «ждём ответа» рядом с этим был бы враньём.
function chatWaitStatus(d) {
  if (!d) return null;
  if (d.agentStatus === 'escalated') {
    return { key: 'operator', label: '👤 Оператор', cls: 'chat-wait-operator',
      title: 'Диалог передан администратору — ждём ответа НЕ клиента, а нас' };
  }
  const status = d.followupStatus;
  if (status === 'scheduled') {
    const stage = Number(d.followupStage) || 0;
    if (stage >= 1) {
      return { key: 'nudged', label: '⏳ Напомнили', cls: 'chat-wait-nudged',
        title: 'Клиент не ответил на первое сообщение — Мила уже напомнила о себе' };
    }
    return { key: 'waiting', label: '⏳ Ждём ответа', cls: 'chat-wait-waiting',
      title: 'Мила ответила клиенту и ждёт его ответа' };
  }
  if (status === 'done') {
    return { key: 'no_response', label: '✖ Не ответил', cls: 'chat-wait-no-response',
      title: 'Клиент так и не ответил — цепочка напоминаний завершена' };
  }
  if (status === 'expired') {
    return { key: 'expired', label: '🌙 Не напомнили', cls: 'chat-wait-expired',
      title: 'Срок напоминания пришёлся на время вне смены Милы, напоминание не ушло' };
  }
  // answered / cancelled / failed / строки нет вовсе — чипа нет.
  return null;
}

// Порядок соответствует CHAT_WAIT_FILTERS.
const CHAT_WAIT_FILTERS = [
  { key: 'all',         label: 'Все' },
  { key: 'waiting',     label: '⏳ Ждут ответа' },
  { key: 'operator',    label: '👤 На операторе' },
  { key: 'no_response', label: '✖ Не ответили' },
];

function chatWaitMatches(d, filter) {
  const st = chatWaitStatus(d);
  const key = st ? st.key : null;
  switch (filter) {
    case 'waiting':     return key === 'waiting' || key === 'nudged';
    case 'operator':    return key === 'operator';
    case 'no_response': return key === 'no_response' || key === 'expired';
    default:            return true;   // 'all' и любое незнакомое значение — не фильтруют
  }
}

if (typeof window !== 'undefined') {
  window.chatWaitStatus = chatWaitStatus;
  window.chatWaitMatches = chatWaitMatches;
  window.CHAT_WAIT_FILTERS = CHAT_WAIT_FILTERS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { chatWaitStatus, chatWaitMatches, CHAT_WAIT_FILTERS };
}
