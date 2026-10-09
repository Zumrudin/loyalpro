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

  return { create, setStatus, get };
}

function parseId(s) { const mm = /^g(\d+)$/.exec(String(s || '')); return mm ? Number(mm[1]) : null; }

let defaultInstance = null;
function getDefault() {
  if (!defaultInstance) defaultInstance = makeDeliveries(require('../db').db);
  return defaultInstance;
}

module.exports = {
  makeDeliveries, parseId, STATUS,
  create: (...a) => getDefault().create(...a),
  setStatus: (...a) => getDefault().setStatus(...a),
  get: (...a) => getDefault().get(...a),
};
