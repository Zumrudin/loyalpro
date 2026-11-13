'use strict';
// Баланс бонусов из журнала финансовых операций (спека 2026-11-12-finance-operations-design.md, этап 3).
//
// При BONUS_LEDGER_PRIMARY=true `clients.bonus_balance` = сумма бонусных строк finance_operations
// клиента в статусах queued/sending/confirmed — списание журнала, ещё не отправленное в YClients,
// уменьшает баланс сразу, отменённый пакет его возвращает. Действует ТОЛЬКО для клиентов с
// входящим остатком (`kind='bonus_opening'`); у остальных поведение прежнее (копия карты YClients).
//
// `clients.yclients_card_balance` при флаге — последнее ПОКАЗАНИЕ карты YClients: его задают
// чтения карты (setCardReading) и сдвигают только наши УСПЕШНЫЕ записи в карту (bumpCardReading:
// кэшбэк вебхуком, отмена кэшбэка, подтверждённая бонусная оплата журнала). Дельта «новой
// операции YClients» в loyalty.js считается от него (cardBase), а не от bonus_balance — тот
// включает очередь и локальные начисления, о которых карта не знает.
//
// Расхождение = (наш баланс − неотправленные бонусные операции) ≠ показание карты. Автоматически
// ничего не правится: только WARN ночной сверки и список на странице «Финансы».
const { db } = require('../db');
const config = require('../config');

const LEDGER_STATUSES = ['queued', 'sending', 'confirmed'];
const isPrimary = () => config.BONUS_LEDGER_PRIMARY === true;
const qOf = opts => (opts && opts.q) || ((sql, params) => db.query(sql, params));
const ids = list => [...new Set((Array.isArray(list) ? list : [list]).map(Number).filter(n => Number.isInteger(n) && n > 0))];

// bonus_balance INTEGER: сумма numeric округляется при присваивании.
const RECOMPUTE_SQL = `UPDATE clients c SET bonus_balance = COALESCE((
    SELECT SUM(f.amount) FROM finance_operations f
     WHERE f.salon_id=c.salon_id AND f.client_id=c.id AND f.method='bonus'
       AND f.status = ANY($2::text[])), 0), updated_at=NOW()
  WHERE c.id = ANY($1::int[])
    AND EXISTS (SELECT 1 FROM finance_operations o WHERE o.salon_id=c.salon_id AND o.client_id=c.id AND o.kind='bonus_opening')
  RETURNING c.id, c.bonus_balance`;

// Пересчитать баланс клиентов из журнала. Без флага — ничего не делает.
async function recompute(clientIds, opts) {
  if (!isPrimary()) return 0;
  const list = ids(clientIds);
  if (!list.length) return 0;
  const r = await qOf(opts)(RECOMPUTE_SQL, [list, LEDGER_STATUSES]);
  return r.rowCount || 0;
}

// Входящий остаток = показание карты − подтверждённая бонусная история клиента
// (очередь не вычитается: YClients о ней не знает). После него баланс = карта + неотправленное.
// Дата — за секунду до первой бонусной строки клиента (начало истории).
const OPENING_SQL = `WITH c AS (
    SELECT id, salon_id, yclients_client_id,
           COALESCE(yclients_card_balance, bonus_balance, 0)::numeric AS card
      FROM clients WHERE id=$1 AND yclients_card_id IS NOT NULL),
  h AS (SELECT COALESCE(SUM(amount) FILTER (WHERE status='confirmed'),0) AS done, MIN(occurred_at) AS first
          FROM finance_operations f, c WHERE f.salon_id=c.salon_id AND f.client_id=c.id AND f.method='bonus')
  INSERT INTO finance_operations(salon_id,occurred_at,op_date,kind,method,amount,status,origin,client_id,yclients_client_id,title)
  SELECT c.salon_id, COALESCE(h.first - INTERVAL '1 second', NOW()),
         (COALESCE(h.first - INTERVAL '1 second', NOW()) AT TIME ZONE 'Europe/Moscow')::date,
         'bonus_opening','bonus', ROUND(c.card - h.done, 2), 'confirmed','opening', c.id, c.yclients_client_id,
         'Входящий остаток (карта YClients ' || c.card || ' ₽)'
    FROM c, h
  ON CONFLICT (salon_id, client_id) WHERE kind='bonus_opening' DO NOTHING
  RETURNING *`;

async function ensureOpening(clientId, opts) {
  if (!isPrimary()) return null;
  const id = ids(clientId)[0];
  if (!id) return null;
  const row = (await qOf(opts)(OPENING_SQL, [id])).rows[0] || null;
  if (row) await recompute([id], opts);
  return row;
}

// Прочитали карту в YClients. Без флага — прежнее поведение (обе колонки = карта).
// С флагом — только показание; баланс считает журнал (входящий остаток заводится при первом чтении).
async function setCardReading(clientId, balance, opts) {
  const q = qOf(opts);
  const id = ids(clientId)[0];
  if (!id) return null;
  if (!isPrimary()) {
    return (await q('UPDATE clients SET bonus_balance=$1::numeric, yclients_card_balance=$1::numeric, updated_at=NOW() WHERE id=$2 RETURNING *', [balance, id])).rows[0] || null;
  }
  // openingFirst: за чтением следует проводка с дельтой (loyalty.js, finances_operation) —
  // входящий остаток берётся по ПРЕЖНЕМУ показанию, иначе дельта вошла бы в него и в проводку дважды.
  if (opts && opts.openingFirst) await ensureOpening(id, opts);
  await q('UPDATE clients SET yclients_card_balance=$1::numeric, updated_at=NOW() WHERE id=$2', [balance, id]);
  await ensureOpening(id, opts);
  await recompute([id], opts);
  return (await q('SELECT * FROM clients WHERE id=$1', [id])).rows[0] || null;
}

// Наша успешная запись в карту YClients сдвинула её баланс на delta (без нового чтения).
async function bumpCardReading(clientId, delta, opts) {
  if (!isPrimary()) return 0;
  const id = ids(clientId)[0];
  const d = Math.round((Number(delta) || 0) * 100) / 100;
  if (!id || !d) return 0;
  const r = await qOf(opts)('UPDATE clients SET yclients_card_balance=COALESCE(yclients_card_balance,bonus_balance,0)+$1::numeric, updated_at=NOW() WHERE id=$2', [d, id]);
  return r.rowCount || 0;
}

// База для дельты «новой операции YClients» (loyalty.js, finances_operation).
function cardBase(client) {
  if (!client) return 0;
  if (isPrimary() && client.yclients_card_balance != null) return parseFloat(client.yclients_card_balance) || 0;
  return parseFloat(client.bonus_balance || 0) || 0;
}

// Клиенты с входящим остатком, у которых наш баланс без неотправленного ≠ показанию карты.
const DISCREPANCY_SQL = `SELECT c.id AS client_id, c.name, c.phone, c.yclients_client_id,
    c.bonus_balance AS ours, c.yclients_card_balance AS card, s.unsent, s.confirmed,
    ROUND(s.confirmed - COALESCE(c.yclients_card_balance,0), 2) AS diff
  FROM clients c
  JOIN LATERAL (SELECT COALESCE(SUM(amount) FILTER (WHERE status='confirmed'),0) AS confirmed,
                       COALESCE(SUM(amount) FILTER (WHERE status IN ('queued','sending')),0) AS unsent,
                       BOOL_OR(kind='bonus_opening') AS has_opening
                  FROM finance_operations f WHERE f.salon_id=c.salon_id AND f.client_id=c.id AND f.method='bonus') s ON TRUE
 WHERE c.salon_id=$1 AND s.has_opening AND ABS(s.confirmed - COALESCE(c.yclients_card_balance,0)) >= 1
 ORDER BY ABS(s.confirmed - COALESCE(c.yclients_card_balance,0)) DESC LIMIT $2`;

async function discrepancies(salonId, { limit = 200, q = null } = {}) {
  const r = await qOf({ q })(DISCREPANCY_SQL, [Number(salonId), Math.min(Math.max(Number(limit) || 200, 1), 1000)]);
  return r.rows.map(x => ({
    clientId: x.client_id, name: x.name, phone: x.phone, yclientsClientId: x.yclients_client_id != null ? Number(x.yclients_client_id) : null,
    ours: Number(x.ours) || 0, unsent: Number(x.unsent) || 0, confirmed: Number(x.confirmed) || 0,
    card: x.card == null ? null : Number(x.card), diff: Number(x.diff) || 0,
  }));
}

// Сухой прогон входящих остатков: что будет записано, ничего не пишет.
const OPENING_PLAN_SQL = `SELECT c.id, COALESCE(c.yclients_card_balance, c.bonus_balance, 0)::numeric AS card,
    COALESCE(h.done,0) AS done, COALESCE(h.unsent,0) AS unsent, c.bonus_balance AS current
  FROM clients c
  LEFT JOIN LATERAL (SELECT SUM(amount) FILTER (WHERE status='confirmed') AS done,
                            SUM(amount) FILTER (WHERE status IN ('queued','sending')) AS unsent
                       FROM finance_operations f WHERE f.salon_id=c.salon_id AND f.client_id=c.id AND f.method='bonus') h ON TRUE
 WHERE c.salon_id=$1 AND c.yclients_card_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM finance_operations o WHERE o.salon_id=c.salon_id AND o.client_id=c.id AND o.kind='bonus_opening')
 ORDER BY c.id`;

async function openingPlan(salonId, opts) {
  const rows = (await qOf(opts)(OPENING_PLAN_SQL, [Number(salonId)])).rows;
  const plan = rows.map(r => {
    const card = Number(r.card) || 0, done = Number(r.done) || 0, unsent = Number(r.unsent) || 0;
    return { clientId: r.id, card, history: done, unsent, opening: Math.round((card - done) * 100) / 100,
      balanceAfter: Math.round((card + unsent) * 100) / 100, current: Number(r.current) || 0 };
  });
  return {
    clients: plan.length,
    withHistory: plan.filter(p => p.history !== 0).length,
    negativeOpening: plan.filter(p => p.opening < 0).length,
    withUnsent: plan.filter(p => p.unsent !== 0).length,
    balanceChanges: plan.filter(p => Math.abs(p.balanceAfter - p.current) >= 1).length,
    sumCard: plan.reduce((n, p) => n + p.card, 0), sumOpening: plan.reduce((n, p) => n + p.opening, 0),
    plan,
  };
}

module.exports = {
  LEDGER_STATUSES, isPrimary, recompute, ensureOpening, setCardReading, bumpCardReading, cardBase,
  discrepancies, openingPlan, RECOMPUTE_SQL, OPENING_SQL, DISCREPANCY_SQL,
};
