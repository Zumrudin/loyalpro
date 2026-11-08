'use strict';
// Трактовка статуса доставки исходящего сообщения — одна точка на обоих провайдеров.
// У Chatpush и нашего шлюза ОДИН контракт ответа (`GET /api/v1/delivery/:id` → `delivery.status.
// {status_id, description}`), но РАЗНЫЕ таблицы кодов, и прочитать коды Chatpush по таблице шлюза —
// значит врать в мониторе (рассылка №3, 05–06.11.2026: у 23 из 90 «отправлено, доставка неизвестна»,
// из них 12 уже прочитаны и 11 не дошли — адресата нет в мессенджере).
//   • шлюз (id `g<n>`, gateway/lib/deliveries.js): 1 Принято, 2 Отправлено, 3 Доставлено,
//     4 Прочитано, 5 Невозможно доставить;
//   • Chatpush (id числом) — коды увидены на живых ответах 06.11.2026: 6 Принято,
//     1 Передано оператору, 2 Доставлено (у WhatsApp — уже на «sent»), 16 Прочитано,
//     5 Невозможно доставить, 55 «Клиент не зарегистрирован в MAX», 58 «Пользователь не найден
//     в Telegram». Полной таблицы у Chatpush в доках нет: неизвестный код — «в пути» (когда
//     сдаться, решает вызывающий), кроме текста «не зарегистрирован / не найден» — тот же смысл,
//     что 55/58, а коды под другие мессенджеры мы ещё не видели.
// «Нет в мессенджере» Chatpush ставит АСИНХРОННО: отправку он принимает (`success`, код 6), отказ
// появляется позже — поэтому это исход сверки, а не ошибка отправки.
const KIND = Object.freeze({
  DELIVERED: 'delivered',
  PENDING: 'pending',
  NOT_REGISTERED: 'not_registered',
  UNDELIVERABLE: 'undeliverable',
  UNKNOWN: 'unknown',
});

const GATEWAY = { delivered: new Set([2, 3, 4]), undeliverable: new Set([5]), notRegistered: null };
const CHATPUSH = { delivered: new Set([2, 16]), undeliverable: new Set([5]), notRegistered: new Set([55, 58]) };
const NOT_REGISTERED_RE = /не\s+(?:зарегистрирован|найден)/i;

function isGatewayDeliveryId(id) {
  return /^g\d+$/.test(String(id == null ? '' : id));
}

/**
 * classifyDelivery(delivery, { deliveryId }) → { kind, statusId, description }
 *   delivery — объект `delivery` ответа API (transport.getDeliveryStatus);
 *   kind — 'delivered' | 'pending' | 'not_registered' | 'undeliverable' | 'unknown' (статуса нет вовсе).
 * 'undeliverable' — «Невозможно доставить» как есть: доказан ли исход (у шлюза код 5 бывает
 * и «исход неизвестен»), решает вызывающий — правила у потребителей разные.
 */
function classifyDelivery(delivery, { deliveryId } = {}) {
  const st = delivery && delivery.status;
  if (!st) return { kind: KIND.UNKNOWN, statusId: null, description: '' };
  const n = Number(st.status_id);
  const statusId = Number.isFinite(n) ? n : null;
  const description = String(st.description || '');
  const t = isGatewayDeliveryId(deliveryId) ? GATEWAY : CHATPUSH;
  let kind = KIND.PENDING;
  if (t.delivered.has(statusId)) kind = KIND.DELIVERED;
  else if (t.undeliverable.has(statusId)) kind = KIND.UNDELIVERABLE;
  else if (t.notRegistered && (t.notRegistered.has(statusId) || NOT_REGISTERED_RE.test(description))) kind = KIND.NOT_REGISTERED;
  return { kind, statusId, description };
}

module.exports = { classifyDelivery, isGatewayDeliveryId, KIND };
