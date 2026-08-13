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

// Признак «диалог на операторе» — ОБЩИЙ с сортировкой списка (chat-dialog-sort.js):
// изменение условия эскалации иначе пришлось бы держать в двух местах.
// ВАЖНО: резолвится ЛЕНИВО, внутри функции, а не top-level биндингом — оба файла
// подключены обычными <script> без type="module" и делят одну глобальную лексическую
// область; top-level `const chatIsEscalated` здесь столкнулся бы с `function
// chatIsEscalated` из chat-dialog-sort.js (SyntaxError, весь файл переставал бы
// выполняться). Ленивое чтение вдобавок не зависит от порядка тегов в index.html.
// Под node --test модуля window нет — берём через require; в браузере — из глобали.
function _resolveIsEscalated(d) {
  const fn = (typeof module !== 'undefined' && module.exports)
    ? require('./chat-dialog-sort').chatIsEscalated
    : (typeof window !== 'undefined' ? window.chatIsEscalated : undefined);
  return typeof fn === 'function' ? fn(d) : false;
}

// Диалог на операторе перекрывает ЛЮБОЙ статус ожидания: там ждут НАС,
// а не клиента, и чип «ждём ответа» рядом с этим был бы враньём.
function chatWaitStatus(d) {
  if (!d) return null;
  if (_resolveIsEscalated(d)) {
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
  // Отправка сорвалась и попытки исчерпаны. Чип нужен: без него «сломалось»
  // выглядит для администратора ровно как «напоминаний тут и не было», и
  // диалог, оставшийся без обещанного касания, ничем себя не выдаёт.
  if (status === 'failed') {
    return { key: 'failed', label: '⚠️ Сбой напоминания', cls: 'chat-wait-failed',
      title: 'Напоминание не удалось отправить — посмотрите переписку и ответьте сами' };
  }
  // answered / cancelled / строки нет вовсе — чипа нет: диалог снова обычный.
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
    // Одна корзина на три исхода «клиент так и не получил ответа по существу»:
    // не ответил на финал, не напомнили вне смены, сорвалась отправка. Админу
    // важно увидеть их вместе — это его список на разбор.
    case 'no_response': return key === 'no_response' || key === 'expired' || key === 'failed';
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
