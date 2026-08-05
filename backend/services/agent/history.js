'use strict';

const { db } = require('../../db');
const pendingReplies = require('./pending-replies');

// Ключ диалога в chatpush_messages — тот же, что во всём коде (routes/chat.js):
// телефон, либо chat_id для каналов без телефона (Telegram/MAX).
const DIALOG_KEY_SQL = `COALESCE(NULLIF(phone,''), chat_id)`;

// Пометка чужого авторства в транскрипте. Держится в паре с правилом промпта
// «РЕПЛИКИ АДМИНИСТРАТОРА» (services/agent/system-prompt.js) — менять только вместе.
const OPERATOR_MARK = '[сообщение администратора клиники]';

// Журнал авторства исходящих (services/outgoing-authorship) выкачен на прод
// 04.08.2026 (коммит 34caa25). У сообщений ДО него authored_by = NULL, и среди
// них есть реплики живых администраторов — без пометки модель считает их своими
// (инцидент 2026-08-05: пациентке не ответили приветствием, потому что неделю
// назад с ней здоровался администратор, а его «Доброе утро» числилось за Милой).
// ПОСЛЕ отсечки NULL значит ДРУГОЕ: classify упал, а там намеренный fail-open,
// чтобы не глушить Милу на её же эхе, — такое NULL оператором НЕ считаем.
// Отсечка взята концом суток 04.08 мск: ошибка в эту сторону заставит Милу лишний
// раз перепроверить собственную договорённость, ошибка в другую — исходный баг.
const AUTHORSHIP_SINCE_TS = Math.floor(Date.parse('2026-08-05T00:00:00+03:00') / 1000);

// Транскрипт диалога для Claude Messages API.
//  incoming → {role:'user'}, outgoing (наши эхо-ответы) → {role:'assistant'}.
// Возвращает { messages, watermark }, где watermark = max(msg_ts) входящих.
async function loadTranscript(salonId, dialogKey, opts = {}) {
  const limit = opts.limit || 20;
  const rows = await db.any(
    `SELECT direction, msg_type, text, msg_ts, authored_by
       FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND text IS NOT NULL AND text <> ''
      ORDER BY msg_ts DESC, id DESC
      LIMIT $3`,
    [salonId, dialogKey, limit]);

  rows.reverse();   // из DESC (свежие сверху) → в хронологический порядок

  // Только что отправленные ответы агента, чьё эхо ещё не легло в БД (Chatpush
  // доставляет с задержкой; WhatsApp эхо не шлёт вовсе). Без них повторный прогон
  // видит серию клиента «без ответа» и отвечает заново (инцидент 2026-07-31).
  // Дедуп по тексту: если эхо уже в выборке — pending-копия не подмешивается.
  const pending = pendingReplies.peek(salonId, dialogKey, opts.nowMs || Date.now());
  if (pending.length) {
    const echoed = new Set(rows.filter((r) => r.direction === 'outgoing').map((r) => r.text));
    const extra = pending.filter((p) => !echoed.has(p.text))
      .map((p) => ({ direction: 'outgoing', text: p.text, msg_ts: p.ts, authored_by: 'agent' }));
    if (extra.length) {
      rows.push(...extra);
      rows.sort((a, b) => Number(a.msg_ts) - Number(b.msg_ts));   // stable → равные ts не перемешиваются
    }
  }

  const messages = [];
  let watermark = 0;
  for (const r of rows) {
    if (r.direction === 'incoming' && Number(r.msg_ts) > watermark) watermark = Number(r.msg_ts);
    const role = r.direction === 'outgoing' ? 'assistant' : 'user';
    // Исходящее, написанное ЖИВЫМ администратором (не нами), помечаем явно.
    // Роль всё равно assistant — других ролей у Messages API нет, — но без
    // пометки модель считает такие реплики своими: инцидент 2026-08-04, где
    // время и услугу согласовал человек, а Мила по правилу «выбор варианта =
    // согласие» молча оформила запись, придумав услугу. Автор проставлен
    // вебхуком (services/outgoing-authorship); NULL у сообщений до 04.08.2026.
    const legacyUnknown = r.direction === 'outgoing'
      && r.authored_by == null
      && Number(r.msg_ts) < AUTHORSHIP_SINCE_TS;
    const text = (r.authored_by === 'operator' || legacyUnknown)
      ? `${OPERATOR_MARK} ${r.text}`
      : r.text;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;   // склейка серии
    else messages.push({ role, content: text });
  }
  // Chatpush/MAX доставляет наши ответы и с многоминутной задержкой (наблюдали 19 мин
  // 2026-07-26) — эхо получает msg_ts ПОЗЖЕ нового входящего, и транскрипт кончается
  // assistant-репликой. Polza (Anthropic через Azure) такой диалог отвергает
  // (400 «does not support assistant message prefill»), а по смыслу задержанное эхо —
  // ответ на ПРЕДЫДУЩЕЕ сообщение клиента. Переносим хвостовой assistant-блок перед
  // последний user-блок: транскрипт всегда кончается сообщением клиента.
  if (messages.length > 1 && messages[messages.length - 1].role === 'assistant') {
    const tail = [];
    while (messages.length && messages[messages.length - 1].role === 'assistant') {
      tail.unshift(messages.pop());
    }
    if (messages.length) {
      const lastUser = messages.pop();
      for (const t of tail) {
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant') last.content += `\n${t.content}`;
        else messages.push(t);
      }
      messages.push(lastUser);
    }
  }
  // Claude требует, чтобы первым шёл user — срезаем ведущие assistant-реплики
  // (после переноса хвоста: он мог поставить assistant в начало, если более
  // раннего user-блока в окне не нашлось).
  while (messages.length && messages[0].role === 'assistant') messages.shift();
  return { messages, watermark };
}

// Пришло ли входящее новее watermark (во время прогона агента)?
async function hasIncomingAfter(salonId, dialogKey, watermark) {
  const row = await db.oneOrNone(
    `SELECT 1 FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND direction = 'incoming' AND msg_ts > $3
      LIMIT 1`,
    [salonId, dialogKey, watermark || 0]);
  return !!row;
}

module.exports = { loadTranscript, hasIncomingAfter, OPERATOR_MARK };
