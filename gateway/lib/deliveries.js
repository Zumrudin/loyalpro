'use strict';
// Строки gateway_deliveries: id → наружу как 'g<id>' (не пересекается с
// числовыми id Chatpush; влезает в agent_reply_deliveries.delivery_id VARCHAR(40)).
// БД инжектится (makeDeliveries(db)) ради тестов без Postgres; дефолтный
// экземпляр — на ../db.
const STATUS = {
  ACCEPTED: [1, 'Принято'],                 // DEFAULT в схеме; частичный индекс pending — по status_id=1
  SENT:     [2, 'Отправлено'],
  FAILED:   [5, 'Невозможно доставить'],    // ровно 5: его проверяет backend/routes/chat.js
};

const STALE_REASON = 'шлюз перезапущен, исход неизвестен';

function makeDeliveries(db) {
  async function create({ accountId, chatId, phone, kind, text }) {
    const row = await db.oneOrNone(
      `INSERT INTO gateway_deliveries (account_id, chat_id, phone, kind, text, status_id, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [accountId, chatId, phone, kind, text, STATUS.ACCEPTED[0], STATUS.ACCEPTED[1]]);
    if (!row) throw new Error('gateway_deliveries: INSERT не вернул id');
    return row.id;
  }

  async function setStatus(id, [statusId, description], { tdlibMessageId = null, error = null } = {}) {
    await db.query(
      `UPDATE gateway_deliveries SET status_id=$2, description=$3, tdlib_message_id=COALESCE($4, tdlib_message_id), error=$5, updated_at=NOW() WHERE id=$1`,
      [id, statusId, description, tdlibMessageId, error]);
  }

  async function get(accountId, id) {
    return db.oneOrNone(`SELECT * FROM gateway_deliveries WHERE id=$1 AND account_id=$2`, [id, accountId]);
  }

  // Доставки, зависшие в «Принято» дольше minutes минут: связка «временный id
  // сообщения → доставка» живёт в памяти процесса, после рестарта шлюза исход
  // таких строк уже не узнать — закрываем как «Невозможно доставить», чтобы
  // сторож бэкенда (agent_reply_deliveries) не ждал их вечно. Частичный индекс
  // gateway_deliveries_pending_idx (status_id=1) — ровно под этот запрос.
  async function failStale(accountId, minutes = 10, reason = STALE_REASON) {
    const r = await db.query(
      `UPDATE gateway_deliveries SET status_id=$2, description=$3, error=$4, updated_at=NOW()
        WHERE account_id=$1 AND status_id=$5 AND created_at < NOW() - ($6 || ' minutes')::interval`,
      [accountId, STATUS.FAILED[0], STATUS.FAILED[1], reason, STATUS.ACCEPTED[0], String(minutes)]);
    return r && r.rowCount != null ? r.rowCount : 0;
  }

  // Временный id сообщения TDLib (ответ sendMessage) → в строку доставки: после
  // рестарта шлюза in-memory связка теряется, а updateMessageSendSucceeded по
  // досланному сообщению приходит с этим id — доставка находится по колонке.
  async function setTempId(id, tempId) {
    await db.query(`UPDATE gateway_deliveries SET tdlib_temp_id=$2, updated_at=NOW() WHERE id=$1`, [id, tempId]);
  }

  // Ищем «Принято» И строки, закрытые failStale (их реальный исход пришёл позже
  // рестарта): иначе досланное TDLib сообщение осталось бы «Невозможно
  // доставить» в журнале при реально ушедшем тексте.
  async function findByTempId(accountId, tempId) {
    const r = await db.oneOrNone(
      `SELECT id FROM gateway_deliveries
        WHERE account_id=$1 AND tdlib_temp_id=$2
          AND (status_id=$3 OR (status_id=$4 AND error=$5))
        ORDER BY id DESC LIMIT 1`,
      [accountId, tempId, STATUS.ACCEPTED[0], STATUS.FAILED[0], STALE_REASON]);
    return r ? Number(r.id) : null;
  }

  return { create, setStatus, get, failStale, setTempId, findByTempId };
}

function parseId(s) {
  const mm = /^g(\d{1,15})$/.exec(String(s || ''));
  const n = mm ? Number(mm[1]) : 0;
  return n > 0 ? n : null;
}

let defaultInstance = null;
function getDefault() {
  if (!defaultInstance) defaultInstance = makeDeliveries(require('../db').db);
  return defaultInstance;
}

module.exports = {
  makeDeliveries, parseId, STATUS, STALE_REASON,
  create: (...a) => getDefault().create(...a),
  setStatus: (...a) => getDefault().setStatus(...a),
  get: (...a) => getDefault().get(...a),
  failStale: (...a) => getDefault().failStale(...a),
  setTempId: (...a) => getDefault().setTempId(...a),
  findByTempId: (...a) => getDefault().findByTempId(...a),
};
