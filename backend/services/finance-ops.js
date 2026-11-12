'use strict';
// Единая таблица финансовых операций (спека 2026-11-12-finance-operations-design.md, этап 2).
// ЕДИНСТВЕННЫЙ писатель `finance_operations`: журнал (outbox-шаги pay/remove_payment),
// кассовые операции YClients (`revenue_operations`) и бонусные проводки
// (`loyalty_card_transactions`) приводятся к одной строке со знаком суммы.
//
// Правила:
//  - Все записи идемпотентны по уникальным ключам (step_op_id / revenue_operation_id /
//    loyalty_txn_id / journal_operation_id). ON CONFLICT обновляет ТОЛЬКО статус и ссылки,
//    сумма, вид, дата и способ не перезаписываются.
//  - Операция из внешнего источника, совпавшая с нашей подтверждённой оплатой журнала
//    (тот же визит, сумма, способ), не вставляется второй строкой, а ссылается на строку
//    журнала (иначе выручка/бонусы задвоятся).
//  - Сбой записи в таблицу не должен ронять денежный путь: хуки зовут функции через
//    `safely()` (try/catch + logger.warn), недостающее добирает ночная `reconcile`.
//  - Бонусы подписаны (списание < 0, начисление > 0), method='bonus': этап 3 суммирует
//    такие строки по клиенту.
const { db } = require('../db');
const { createLogger } = require('../logger');
const logger = createLogger('FinanceOps');
const bonusLedger = require('./bonus-ledger');

// Этап 3: после любого изменения бонусной строки — пересчёт баланса клиента из журнала
// (без BONUS_LEDGER_PRIMARY recompute ничего не делает).
async function touchBonus(q, rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(r => r && r.method === 'bonus' && r.client_id != null).map(r => r.client_id);
  if (list.length) await bonusLedger.recompute(list, { q });
}

const KINDS = ['visit_payment', 'payment_reversal', 'bonus_redemption', 'bonus_accrual', 'bonus_adjustment',
  'bonus_opening', 'goods_sale', 'certificate_sale', 'abonement_sale', 'deposit', 'other_income'];
const METHODS = ['cash', 'card', 'bonus', 'other'];
const STATUSES = ['queued', 'sending', 'confirmed', 'cancelled', 'failed'];
const ORIGINS = ['journal', 'yclients', 'loyalpro', 'staff', 'backfill', 'opening'];
const STEP_KINDS = ['pay', 'remove_payment'];

// ── чистые классификаторы ───────────────────────────────────────────────

const REVENUE_KIND = {
  services: 'visit_payment', goods: 'goods_sale', certificate: 'certificate_sale',
  abonement: 'abonement_sale', deposit: 'deposit',
};
const revenueKind = category => REVENUE_KIND[category] || 'other_income';
const revenueMethod = isCash => (isCash === true ? 'cash' : isCash === false ? 'card' : 'other');

// Московская дата (YYYY-MM-DD) момента.
function mskDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });
}

// Касса YClients -> способ. Кэш справочника `accounts`: type_slug==='cash' — наличные.
function accountMethod(accounts, id) {
  const a = (Array.isArray(accounts) ? accounts : []).find(x => x && Number(x.id) === Number(id));
  if (!a) return { method: 'other', title: null };
  return { method: a.type_slug === 'cash' ? 'cash' : 'card', title: a.title ? String(a.title) : null };
}

// Бонусная проводка -> вид. Раньше всего названия автоматических проводок loyalty.js/вебхука,
// затем знак. Ручные правки (routes/clients.js, staff.js) приходят с явной подсказкой kind.
function classifyLoyaltyTxn(row, hints = {}) {
  if (hints.kind && KINDS.includes(hints.kind)) return hints.kind;
  const amount = Number(row?.amount) || 0;
  const title = String(row?.title || '');
  if (amount < 0) {
    if (/^Списание бонусов при оплате визита/i.test(title)) return 'bonus_redemption';
    if (/Отмена (начисления|кэшбэка)|при отмене визита/i.test(title)) return 'bonus_adjustment';
    return row?.record_id ? 'bonus_redemption' : 'bonus_adjustment';
  }
  if (/Кэшбэк|Приветств|день рождения|Подарок|Возврат бонусов|Начисление бонусов \(YClients\)/i.test(title)) return 'bonus_accrual';
  return 'bonus_adjustment';
}

// Состояние шага пакета journal_outbox -> статус строки таблицы.
function stepStatus(row, step) {
  if (step?.state === 'done') return 'confirmed';
  if (row?.status === 'cancelled') return 'cancelled';
  if (row?.status === 'failed' || step?.state === 'failed' || step?.state === 'uncertain') return 'failed';
  if (row?.released_at && ['queued', 'running', 'done'].includes(row.status)) return 'sending';
  return 'queued';
}

// journal_financial_transactions.state -> статус (rejected/reviewed — оплата не прошла, в таблицу не идут).
function journalStateStatus(state) {
  if (state === 'confirmed') return 'confirmed';
  if (state === 'pending') return 'sending';
  return null;
}

// Операция по шагу журнала. `ctx`: { accounts, client:{client_id,yclients_client_id}, status }.
function buildJournalOp(row, step, ctx = {}) {
  if (!step || !STEP_KINDS.includes(step.kind)) return null;
  const p = step.params || {};
  const abs = Math.round((Number(p.amount) || 0) * 100) / 100;
  if (!(abs > 0)) return null;
  const removing = step.kind === 'remove_payment';
  let kind, method, sign, accountId = null, accountTitle = null;
  if (p.method === 'loyalty_card') {
    method = 'bonus';
    kind = removing ? 'payment_reversal' : 'bonus_redemption';
    sign = removing ? 1 : -1;
  } else if (p.method === 'account') {
    const acc = accountMethod(ctx.accounts, p.methodId);
    method = acc.method; accountId = Number(p.methodId) || null; accountTitle = acc.title;
    kind = removing ? 'payment_reversal' : 'visit_payment';
    sign = removing ? -1 : 1;
  } else return null;
  const occurred = row.created_at ? new Date(row.created_at) : new Date();
  return {
    salon_id: Number(row.salon_id), occurred_at: occurred, op_date: mskDate(occurred),
    kind, method, amount: sign * abs, status: ctx.status || stepStatus(row, step), origin: 'journal',
    account_id: accountId, account_title: accountTitle,
    client_id: ctx.client?.client_id ?? null, yclients_client_id: ctx.client?.yclients_client_id ?? null,
    yclients_record_id: row.yclients_record_id != null ? Number(row.yclients_record_id) : null,
    outbox_id: row.id != null ? Number(row.id) : null, step_op_id: step.opId || null,
    journal_operation_id: step.state === 'done' ? step.opId || null : null,
    revenue_operation_id: null, loyalty_txn_id: null, yclients_operation_id: null,
    user_id: row.user_id != null ? Number(row.user_id) : null, title: null, comment: null,
  };
}

// Строка audit-таблицы journal_financial_transactions -> операция (для переноса истории).
function buildJournalFinanceOp(f, ctx = {}) {
  const status = journalStateStatus(f.state);
  if (!status) return null;
  const step = { kind: f.action === 'remove' ? 'remove_payment' : 'pay', opId: f.operation_id,
    params: { method: f.method, methodId: f.method_id, amount: f.amount }, state: status === 'confirmed' ? 'done' : 'pending' };
  const op = buildJournalOp({ salon_id: f.salon_id, created_at: f.created_at, yclients_record_id: f.yclients_record_id,
    user_id: f.user_id, id: null }, step, { accounts: ctx.accounts, status,
    client: { client_id: f.client_id ?? null, yclients_client_id: ctx.yclientsClientId ?? null } });
  if (op) op.journal_operation_id = f.operation_id;
  return op;
}

// Кассовая операция YClients (строка revenue_operations).
function buildRevenueOp(rev, opts = {}) {
  const amount = Math.round((Number(rev.amount) || 0) * 100) / 100;
  if (!(amount > 0)) return null;
  // YClients шлёт для оплат, проведённых через API (в т.ч. наши из журнала), date = 1970-01-01:
  // такая операция датируется временем получения.
  let occurred = new Date(rev.operation_at);
  if (Number.isNaN(occurred.getTime()) || occurred.getFullYear() < 2020) occurred = new Date(rev.created_at || Date.now());
  return {
    salon_id: Number(rev.salon_id), occurred_at: occurred,
    op_date: mskDate(occurred),
    kind: revenueKind(rev.category), method: revenueMethod(rev.is_cash), amount,
    status: 'confirmed', origin: opts.origin || 'yclients',
    account_id: null, account_title: rev.account_title || null,
    client_id: rev.client_id ?? null, yclients_client_id: rev.yclients_client_id != null ? Number(rev.yclients_client_id) : null,
    yclients_record_id: rev.yclients_record_id != null ? Number(rev.yclients_record_id) : null,
    outbox_id: null, step_op_id: null, journal_operation_id: null,
    revenue_operation_id: Number(rev.id), loyalty_txn_id: null,
    yclients_operation_id: rev.yclients_operation_id != null ? Number(rev.yclients_operation_id) : null,
    user_id: null, title: rev.expense_title || null, comment: null,
  };
}

// Бонусная проводка. `ctx`: { yclients_record_id, yclients_client_id } (из records/clients).
function buildLoyaltyOp(lct, hints = {}, ctx = {}) {
  const amount = Math.round((Number(lct.amount) || 0) * 100) / 100;
  if (!amount) return null;
  const occurred = new Date(lct.txn_date || lct.created_at || Date.now());
  return {
    salon_id: Number(lct.salon_id), occurred_at: occurred, op_date: mskDate(occurred),
    kind: classifyLoyaltyTxn(lct, hints), method: 'bonus', amount, status: 'confirmed',
    origin: hints.origin || 'loyalpro', account_id: null, account_title: null,
    client_id: lct.client_id ?? null, yclients_client_id: ctx.yclients_client_id ?? null,
    yclients_record_id: ctx.yclients_record_id ?? null,
    outbox_id: null, step_op_id: null, journal_operation_id: null, revenue_operation_id: null,
    loyalty_txn_id: Number(lct.id), yclients_operation_id: null,
    user_id: hints.userId ?? null, title: lct.title || null, comment: hints.comment || null,
  };
}

// ── SQL ────────────────────────────────────────────────────────────────

const COLS = ['salon_id', 'occurred_at', 'op_date', 'kind', 'method', 'amount', 'status', 'origin',
  'account_id', 'account_title', 'client_id', 'yclients_client_id', 'yclients_record_id',
  'outbox_id', 'step_op_id', 'journal_operation_id', 'revenue_operation_id', 'loyalty_txn_id',
  'yclients_operation_id', 'user_id', 'title', 'comment'];
// Обновляются при конфликте: только ссылки (COALESCE: уже заданная ссылка не затирается) и статус.
const LINK_COLS = ['account_id', 'account_title', 'client_id', 'yclients_client_id', 'yclients_record_id',
  'outbox_id', 'step_op_id', 'journal_operation_id', 'revenue_operation_id', 'loyalty_txn_id',
  'yclients_operation_id', 'user_id', 'title'];
const KEY_ORDER = ['step_op_id', 'revenue_operation_id', 'loyalty_txn_id', 'journal_operation_id'];
// confirmed не откатывается обратно никаким повторным upsert.
const STATUS_MERGE = `CASE WHEN finance_operations.status='confirmed' THEN 'confirmed' ELSE EXCLUDED.status END`;

const keyOf = op => KEY_ORDER.find(k => op[k] != null) || null;

function upsertSql(key) {
  return `INSERT INTO finance_operations(${COLS.join(',')})
VALUES(${COLS.map((_, i) => '$' + (i + 1)).join(',')})
ON CONFLICT (salon_id,${key}) WHERE ${key} IS NOT NULL DO UPDATE SET
 status=${STATUS_MERGE},
 ${LINK_COLS.map(c => `${c}=COALESCE(finance_operations.${c},EXCLUDED.${c})`).join(',\n ')},
 updated_at=NOW()
RETURNING *, (xmax=0) AS inserted`;
}

const qOf = opts => (opts && opts.q) || ((sql, params) => db.query(sql, params));

// Идемпотентная вставка/обновление строки по её ключу.
async function upsertOp(op, opts) {
  const key = keyOf(op);
  if (!key) throw new Error('finance_operations: операции нужен ключ (step_op_id/revenue_operation_id/loyalty_txn_id)');
  if (!KINDS.includes(op.kind) || !STATUSES.includes(op.status) || !ORIGINS.includes(op.origin) || (op.method && !METHODS.includes(op.method))) {
    throw new Error(`finance_operations: недопустимые значения kind=${op.kind} status=${op.status} origin=${op.origin} method=${op.method}`);
  }
  const q = qOf(opts);
  const r = await q(upsertSql(key), COLS.map(c => op[c] ?? null));
  const row = r.rows[0];
  await touchBonus(q, row);
  return { action: row?.inserted ? 'inserted' : 'updated', row };
}

// ── справочные чтения ────────────────────────────────────────────────

async function loadAccounts(salonId) {
  try {
    const refs = require('./journal/reference-cache');
    const list = await refs.getReference(salonId, 'accounts');
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

const digits10 = v => String(v || '').replace(/\D/g, '').slice(-10);

// Клиент шага журнала: по записи-зеркалу, иначе по телефону создаваемой записи
// (в т.ч. родительского пакета «создать запись»), если телефон однозначен.
async function resolveClient(row, opts) {
  const q = qOf(opts);
  const salonId = Number(row.salon_id);
  if (row.yclients_record_id != null) {
    const r = (await q('SELECT client_id, yclients_client_id FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salonId, row.yclients_record_id])).rows[0];
    if (r) return { client_id: r.client_id ?? null, yclients_client_id: r.yclients_client_id ?? null };
  }
  let phone = row.overlay?.client?.phone;
  if (!phone && row.create_outbox_id) {
    const parent = (await q('SELECT overlay FROM journal_outbox WHERE salon_id=$1 AND id=$2', [salonId, row.create_outbox_id])).rows[0];
    phone = parent?.overlay?.client?.phone;
  }
  const d = digits10(phone);
  if (d.length < 10) return {};
  const found = (await q(`SELECT id, yclients_client_id FROM clients WHERE salon_id=$1
    AND RIGHT(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$2 LIMIT 2`, [salonId, d])).rows;
  return found.length === 1 ? { client_id: found[0].id, yclients_client_id: found[0].yclients_client_id ?? null } : {};
}

// ── связывание с нашими оплатами журнала ────────────────────────────

async function linkRow(q, id, fields) {
  const sets = [], params = [id];
  for (const [col, val] of Object.entries(fields)) {
    params.push(val); sets.push(`${col}=COALESCE(${col},$${params.length})`);
  }
  const r = await q(`UPDATE finance_operations SET ${sets.join(',')}, updated_at=NOW() WHERE id=$1 RETURNING *`, params);
  await touchBonus(q, r.rows[0]);
  return r.rows[0] || null;
}

// Кассовая операция по визиту = наша оплата журнала (sending/confirmed), ещё не связанная.
async function findJournalForRevenue(q, op) {
  if (op.kind !== 'visit_payment' || op.yclients_record_id == null || !op.method || op.method === 'other') return null;
  const r = await q(`SELECT id FROM finance_operations WHERE salon_id=$1 AND origin='journal' AND kind='visit_payment'
    AND revenue_operation_id IS NULL AND status IN ('sending','confirmed') AND yclients_record_id=$2
    AND amount=$3 AND method=$4 AND op_date BETWEEN ($5::date - 1) AND ($5::date + 1)
    ORDER BY occurred_at, id LIMIT 1`, [op.salon_id, op.yclients_record_id, op.amount, op.method, op.op_date]);
  return r.rows[0]?.id ?? null;
}

// Бонусная проводка = наше списание/возврат из журнала, ещё не связанное.
async function findJournalForLoyalty(q, op) {
  if (op.yclients_record_id == null) return null;
  const r = await q(`SELECT id FROM finance_operations WHERE salon_id=$1 AND origin='journal' AND method='bonus'
    AND kind IN ('bonus_redemption','payment_reversal') AND loyalty_txn_id IS NULL
    AND status IN ('sending','confirmed') AND yclients_record_id=$2 AND amount=$3
    AND ($4::int IS NULL OR client_id IS NULL OR client_id=$4)
    ORDER BY occurred_at, id LIMIT 1`, [op.salon_id, op.yclients_record_id, op.amount, op.client_id]);
  return r.rows[0]?.id ?? null;
}

// Обратный порядок: внешняя строка пришла РАНЬШЕ, чем шаг журнала стал confirmed.
// Сливаем дубль в строку журнала: ссылки переезжают, самостоятельная строка удаляется.
async function absorbStandalone(q, row) {
  if (!row || row.origin !== 'journal') return null;
  let dup;
  if (row.method === 'bonus' && ['bonus_redemption', 'payment_reversal'].includes(row.kind) && row.loyalty_txn_id == null && row.yclients_record_id != null) {
    dup = (await q(`SELECT id, loyalty_txn_id AS link FROM finance_operations WHERE salon_id=$1 AND step_op_id IS NULL
      AND loyalty_txn_id IS NOT NULL AND method='bonus' AND amount=$2 AND yclients_record_id=$3 AND id<>$4
      AND kind IN ('bonus_redemption','payment_reversal','bonus_accrual','bonus_adjustment')
      AND ($5::int IS NULL OR client_id IS NULL OR client_id=$5) ORDER BY occurred_at, id LIMIT 1`,
    [row.salon_id, row.amount, row.yclients_record_id, row.id, row.client_id])).rows[0];
    if (!dup) return null;
    await q('DELETE FROM finance_operations WHERE id=$1', [dup.id]);
    return linkRow(q, row.id, { loyalty_txn_id: dup.link });
  }
  if (row.kind === 'visit_payment' && row.revenue_operation_id == null && row.yclients_record_id != null && ['cash', 'card'].includes(row.method)) {
    dup = (await q(`SELECT id, revenue_operation_id AS link, yclients_operation_id AS yc FROM finance_operations
      WHERE salon_id=$1 AND step_op_id IS NULL AND revenue_operation_id IS NOT NULL AND kind='visit_payment'
      AND method=$2 AND amount=$3 AND yclients_record_id=$4 AND id<>$5 AND op_date BETWEEN ($6::date - 1) AND ($6::date + 1)
      ORDER BY occurred_at, id LIMIT 1`,
    [row.salon_id, row.method, row.amount, row.yclients_record_id, row.id, mskDate(row.occurred_at)])).rows[0];
    if (!dup) return null;
    await q('DELETE FROM finance_operations WHERE id=$1', [dup.id]);
    return linkRow(q, row.id, { revenue_operation_id: dup.link, yclients_operation_id: dup.yc });
  }
  return null;
}

// ── записывающие функции (единственный писатель) ────────────────────────

// Шаг пакета журнала (pay / remove_payment). `row` — строка journal_outbox
// (id, salon_id, user_id, yclients_record_id, overlay, create_outbox_id, created_at, status, released_at).
async function recordJournalStep(row, step, opts) {
  if (!row || !step || !STEP_KINDS.includes(step.kind)) return null;
  const ctx = {
    accounts: step.params?.method === 'account' ? await loadAccounts(Number(row.salon_id)) : [],
    client: await resolveClient(row, opts).catch(() => ({})),
    status: opts?.status,
  };
  const op = buildJournalOp(row, step, ctx);
  if (!op) return null;
  return upsertOp(op, opts);
}

// Все шаги pay/remove_payment пакета (вызов из POST /api/journal/sessions).
async function recordJournalPackage(row, steps, opts) {
  const out = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (STEP_KINDS.includes(step?.kind)) out.push(await recordJournalStep(row, step, opts));
  }
  return out;
}

// Смена статуса шага по его opId. confirmed дополнительно: ссылка на
// journal_financial_transactions, номер записи YClients (появился после «создать запись»),
// клиент, слияние уже пришедшего дубля из вебхука/бонусной проводки.
async function markStep(salonId, stepOpId, status, extra = {}) {
  if (!STATUSES.includes(status)) throw new Error('finance_operations: неизвестный статус ' + status);
  const q = qOf(extra);
  const r = await q(`WITH prev AS (SELECT id, status FROM finance_operations WHERE salon_id=$1 AND step_op_id=$2)
    UPDATE finance_operations f SET
      status=CASE WHEN f.status='confirmed' THEN f.status ELSE $3 END,
      journal_operation_id=COALESCE(f.journal_operation_id,$4),
      yclients_record_id=COALESCE(f.yclients_record_id,$5), updated_at=NOW()
    FROM prev WHERE f.id=prev.id RETURNING f.*, prev.status AS prev_status`,
  [salonId, stepOpId, status, extra.journalOperationId ?? null, extra.yclientsRecordId ?? null]);
  let row = r.rows[0] || null;
  if (!row) return null;
  const firstConfirm = status === 'confirmed' && row.prev_status !== 'confirmed';
  delete row.prev_status;
  await touchBonus(q, row);
  if (status === 'confirmed') {
    if (row.client_id == null && row.yclients_record_id != null) {
      const rec = (await q('SELECT client_id, yclients_client_id FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salonId, row.yclients_record_id])).rows[0];
      if (rec?.client_id) row = (await linkRow(q, row.id, { client_id: rec.client_id, yclients_client_id: rec.yclients_client_id })) || row;
    }
    row = (await absorbStandalone(q, row)) || row;
    // Бонусная оплата/возврат журнала прошла в карту YClients. Если проводка из вебхука уже
    // связана (loyalty_txn_id), показание карты обновило само чтение — второй раз не сдвигаем.
    if (firstConfirm && row.method === 'bonus' && row.origin === 'journal' && row.loyalty_txn_id == null && row.client_id != null) {
      await bonusLedger.bumpCardReading(row.client_id, Number(row.amount), { q });
    }
  }
  return row;
}

// Статус для всех открытых строк пакетов (по outbox_id): выпуск пакета -> sending,
// «Повторить» -> sending, отмена -> cancelled. Подтверждённые не трогаются.
const FROM_STATUS = { sending: ['queued', 'failed'], cancelled: ['queued', 'sending', 'failed'], failed: ['queued', 'sending'], queued: ['failed', 'sending'] };
async function markOutbox(salonId, outboxIds, status, opts) {
  const ids = (Array.isArray(outboxIds) ? outboxIds : [outboxIds]).map(Number).filter(Number.isFinite);
  if (!ids.length || !FROM_STATUS[status]) return 0;
  const q = qOf(opts);
  const r = await q(`UPDATE finance_operations SET status=$3, updated_at=NOW()
    WHERE salon_id=$1 AND outbox_id = ANY($2::bigint[]) AND status = ANY($4::text[]) RETURNING client_id, method`,
  [salonId, ids, status, FROM_STATUS[status]]);
  await touchBonus(q, r.rows);
  return r.rowCount || 0;
}

// Отмена пакета (dismiss): сам пакет и его дочерние изменения новой записи,
// которые sessions.dismiss перевёл в cancelled.
async function syncCancelledOutbox(salonId, opts) {
  const q = qOf(opts);
  const r = await q(`UPDATE finance_operations SET status='cancelled', updated_at=NOW()
    WHERE salon_id=$1 AND status IN ('queued','sending','failed') AND outbox_id IN
      (SELECT id FROM journal_outbox WHERE salon_id=$1 AND status='cancelled') RETURNING client_id, method`, [salonId]);
  await touchBonus(q, r.rows);
  return r.rowCount || 0;
}

// «Повторить» перевыпускает ключ упавшего шага: строка переезжает на новый opId.
async function rekeyStep(salonId, oldOpId, newOpId, opts) {
  const q = qOf(opts);
  const r = await q(`UPDATE finance_operations SET step_op_id=$3, status='sending', updated_at=NOW()
    WHERE salon_id=$1 AND step_op_id=$2 AND status<>'confirmed' RETURNING id, client_id, method`, [salonId, oldOpId, newOpId]);
  await touchBonus(q, r.rows);
  return r.rowCount || 0;
}

// Кассовая операция YClients (после вставки в revenue_operations).
async function recordRevenueOp(rev, opts = {}) {
  const op = buildRevenueOp(rev, opts);
  if (!op) return null;
  const q = qOf(opts);
  const known = (await q('SELECT id FROM finance_operations WHERE salon_id=$1 AND revenue_operation_id=$2', [op.salon_id, op.revenue_operation_id])).rows[0];
  if (!known) {
    const journalId = await findJournalForRevenue(q, op);
    if (journalId) {
      const row = await linkRow(q, journalId, { revenue_operation_id: op.revenue_operation_id, yclients_operation_id: op.yclients_operation_id,
        client_id: op.client_id, yclients_client_id: op.yclients_client_id });
      return { action: 'linked', row };
    }
  }
  return upsertOp(op, opts);
}

// Операция удалена в YClients. Самостоятельная строка -> cancelled; строка журнала,
// с которой кассовая операция была связана, остаётся (отмену оплаты ведёт сам журнал) — ссылка снимается.
async function cancelRevenueOp(salonId, yclientsOperationId, opts) {
  const q = qOf(opts);
  const c = await q(`UPDATE finance_operations SET status='cancelled', updated_at=NOW()
    WHERE salon_id=$1 AND yclients_operation_id=$2 AND revenue_operation_id IS NOT NULL AND step_op_id IS NULL
      AND status<>'cancelled'`, [salonId, yclientsOperationId]);
  const u = await q(`UPDATE finance_operations SET revenue_operation_id=NULL, yclients_operation_id=NULL, updated_at=NOW()
    WHERE salon_id=$1 AND yclients_operation_id=$2 AND step_op_id IS NOT NULL`, [salonId, yclientsOperationId]);
  return { cancelled: c.rowCount || 0, unlinked: u.rowCount || 0 };
}

// Бонусная проводка (после вставки в loyalty_card_transactions). hints: { origin, kind, userId, comment }.
async function recordLoyaltyTxn(lct, hints = {}, opts = {}) {
  if (!lct || lct.id == null) return null;
  const q = qOf(opts);
  const ctx = {};
  if (lct.record_id != null) {
    const rec = (await q('SELECT yclients_record_id FROM records WHERE salon_id=$1 AND id=$2', [lct.salon_id, lct.record_id])).rows[0];
    ctx.yclients_record_id = rec?.yclients_record_id != null ? Number(rec.yclients_record_id) : null;
  }
  if (lct.client_id != null) {
    const c = (await q('SELECT yclients_client_id FROM clients WHERE id=$1', [lct.client_id])).rows[0];
    ctx.yclients_client_id = c?.yclients_client_id != null ? Number(c.yclients_client_id) : null;
  }
  const op = buildLoyaltyOp(lct, hints, ctx);
  if (!op) return null;
  const known = (await q('SELECT id FROM finance_operations WHERE salon_id=$1 AND loyalty_txn_id=$2', [op.salon_id, op.loyalty_txn_id])).rows[0];
  if (!known) {
    const journalId = await findJournalForLoyalty(q, op);
    if (journalId) {
      const row = await linkRow(q, journalId, { loyalty_txn_id: op.loyalty_txn_id, client_id: op.client_id, yclients_client_id: op.yclients_client_id });
      return { action: 'linked', row };
    }
  }
  return upsertOp(op, opts);
}

// ── хуки: сбой журнала операций не должен ронять денежный путь ───────────────

const _warned = new Map();
async function safely(label, fn) {
  try { return await fn(); } catch (e) {
    try {
      const now = Date.now();
      if (!_warned.has(label) || now - _warned.get(label) > 60000) {
        _warned.set(label, now);
        logger.warn(`${label}: не записано в finance_operations (${e && (e.code || e.name) || 'error'}: ${String(e && e.message || e).slice(0, 160)})`);
      }
    } catch (_) { /* логирование не должно менять путь денег */ }
    return null;
  }
}

// ── источники + ночная сверка ───────────────────────────────────────────

const OUTBOX_PAY_STEPS = `EXISTS (SELECT 1 FROM jsonb_array_elements(o.steps) s WHERE s->>'kind' IN ('pay','remove_payment'))`;

// Прогоняет источники одного салона через те же upsert. since=null — вся история (перенос),
// иначе только строки с датой не раньше since. Порядок важен: журнал первым, чтобы внешние
// строки ссылались на него, а не плодили дубли. onProgress(kind, result) — для счётчиков.
async function syncSources(salonId, { since = null, origin = null, q = null, onResult = null } = {}) {
  const opts = q ? { q } : {};
  const query = qOf(opts);
  const tally = { journal: 0, revenue: 0, loyalty: 0, errors: 0 };
  const note = (src, r) => { tally[src]++; if (onResult) onResult(src, r); };
  const guard = async (src, fn) => { try { const r = await fn(); if (r) note(src, r); } catch (e) { tally.errors++; logger.warn(`sync ${src}: ${e.code || ''} ${String(e.message).slice(0, 160)}`); } };
  const accounts = await loadAccounts(salonId);

  // 1. пакеты журнала (все шаги pay/remove_payment, статус из состояния пакета)
  const outbox = (await query(`SELECT o.* FROM journal_outbox o WHERE o.salon_id=$1 AND ${OUTBOX_PAY_STEPS}
    AND ($2::timestamptz IS NULL OR o.created_at >= $2 OR o.updated_at >= $2) ORDER BY o.id`, [salonId, since])).rows;
  for (const row of outbox) {
    for (const step of Array.isArray(row.steps) ? row.steps : []) {
      if (!STEP_KINDS.includes(step?.kind)) continue;
      await guard('journal', () => recordJournalStep(row, step, opts));
    }
  }
  // 2. аудит оплат журнала (в т.ч. старые, до очереди): ключ тот же opId шага
  const jft = (await query(`SELECT f.*, c.yclients_client_id AS yc_client FROM journal_financial_transactions f
    LEFT JOIN clients c ON c.id=f.client_id WHERE f.salon_id=$1 AND f.state IN ('confirmed','pending')
    AND ($2::timestamptz IS NULL OR f.created_at >= $2 OR f.updated_at >= $2) ORDER BY f.created_at`, [salonId, since])).rows;
  for (const f of jft) {
    await guard('journal', async () => {
      const op = buildJournalFinanceOp(f, { accounts, yclientsClientId: f.yc_client });
      return op ? upsertOp(op, opts) : null;
    });
  }
  // 3. кассовые операции YClients
  const revenue = (await query(`SELECT * FROM revenue_operations WHERE salon_id=$1
    AND ($2::timestamptz IS NULL OR operation_at >= $2 OR created_at >= $2) ORDER BY operation_at, id`, [salonId, since])).rows;
  for (const rev of revenue) await guard('revenue', () => recordRevenueOp(rev, { ...opts, origin: origin || undefined }));
  // 4. бонусные проводки
  const lct = (await query(`SELECT * FROM loyalty_card_transactions WHERE salon_id=$1
    AND ($2::timestamptz IS NULL OR COALESCE(txn_date, created_at) >= $2) ORDER BY COALESCE(txn_date, created_at), id`, [salonId, since])).rows;
  for (const t of lct) await guard('loyalty', () => recordLoyaltyTxn(t, origin ? { origin } : {}, opts));
  return tally;
}

// Ночная сверка (крон 04:50 мск): последние `days` дней трёх источников + пакеты журнала.
async function reconcile({ days = 7, salonId = null, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400000);
  const salons = salonId ? [{ id: salonId }] : (await db.any('SELECT id FROM salons WHERE is_active=TRUE'));
  const out = { salons: 0, journal: 0, revenue: 0, loyalty: 0, errors: 0, cancelled: 0 };
  for (const s of salons) {
    try {
      const t = await syncSources(s.id, { since });
      for (const k of ['journal', 'revenue', 'loyalty', 'errors']) out[k] += t[k];
      out.cancelled += await syncCancelledOutbox(s.id);
      // удалённые кассовые операции, чей хук удаления не отработал
      const gone = await db.query(`UPDATE finance_operations f SET status='cancelled', updated_at=NOW()
        WHERE f.salon_id=$1 AND f.origin IN ('yclients','backfill') AND f.revenue_operation_id IS NOT NULL
          AND f.status<>'cancelled' AND f.op_date >= ($2::timestamptz AT TIME ZONE 'Europe/Moscow')::date
          AND NOT EXISTS (SELECT 1 FROM revenue_operations r WHERE r.id=f.revenue_operation_id)`, [s.id, since]);
      out.cancelled += gone.rowCount || 0;
      // Этап 3: расхождения нашего баланса с картой YClients — только WARN, без правок.
      if (bonusLedger.isPrimary()) {
        const diffs = await bonusLedger.discrepancies(s.id, { limit: 1000 });
        out.discrepancies = (out.discrepancies || 0) + diffs.length;
        if (diffs.length) {
          const top = diffs.slice(0, 5).map(d => `client=${d.clientId} ours−unsent=${d.confirmed} card=${d.card} diff=${d.diff}`).join('; ');
          logger.warn(`salon=${s.id}: расхождения баланса бонусов с YClients у ${diffs.length} клиентов (${top})`);
        }
      }
      out.salons++;
    } catch (e) {
      out.errors++;
      logger.error(`reconcile salon=${s.id}: ${e.message}`);
    }
  }
  logger.info(`reconcile ${days}d: salons=${out.salons} journal=${out.journal} revenue=${out.revenue} loyalty=${out.loyalty} cancelled=${out.cancelled} errors=${out.errors}`);
  return out;
}

module.exports = {
  KINDS, METHODS, STATUSES, ORIGINS,
  // чистые классификаторы
  revenueKind, revenueMethod, accountMethod, classifyLoyaltyTxn, stepStatus, journalStateStatus, mskDate,
  buildJournalOp, buildJournalFinanceOp, buildRevenueOp, buildLoyaltyOp,
  // запись
  upsertOp, recordJournalStep, recordJournalPackage, markStep, markOutbox, syncCancelledOutbox, rekeyStep,
  recordRevenueOp, cancelRevenueOp, recordLoyaltyTxn,
  // обвязка
  safely, syncSources, reconcile, upsertSql, absorbStandalone,
};
