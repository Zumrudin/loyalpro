'use strict';
// Instant LOCAL payment form: built only from our DB (mirror `records`, the
// payment ledger, open outbox packages, cached accounts, client card). The
// frontend shows it at once; the live `payments.options` refreshes it later.
// Money is summed in integer kopecks; output is rubles.
const { db } = require('../../db');
const m = require('./model');
const reference = require('./reference-cache');
const overlay = require('./overlay');
const bonusLedger = require('../bonus-ledger');

// Карта клиента: показание YClients и (при BONUS_LEDGER_PRIMARY и входящем остатке) наш баланс.
const CARD_COLS = `yclients_card_id, yclients_card_balance, bonus_balance,
  EXISTS (SELECT 1 FROM finance_operations o WHERE o.salon_id=clients.salon_id AND o.client_id=clients.id AND o.kind='bonus_opening') AS ledger_open`;

const kop = v => Math.round((Number(v) || 0) * 100);
const rub = c => c / 100;
const OPEN = ['queued', 'running', 'failed'];

function paidRows(ledger, accounts) {
  const rows = (ledger || []).filter(r => r && r.state === 'confirmed');
  const removed = new Set(rows.filter(r => r.action === 'remove')
    .flatMap(r => [...(r.external_ids || []), ...(r.target_transaction_id != null ? [r.target_transaction_id] : [])]
      .map(id => r.method + ':' + id)));
  const byId = new Map((accounts || []).map(a => [Number(a.id), a]));
  const out = [];
  for (const r of rows) {
    if (r.action !== 'payment') continue;
    // Cash and bonus transactions are separate YClients id sequences: match by method + id.
    const ids = (r.external_ids || []).map(String);
    const isRemoved = id => removed.has(r.method + ':' + id);
    if (!ids.length || ids.every(isRemoved)) continue;
    const methodId = Number(r.method_id);
    let title = 'Бонусы';
    if (r.method !== 'loyalty_card') {
      const a = byId.get(methodId);
      title = a ? (a.type_slug === 'cash' ? 'Наличные' : 'Банковская карта') + ' · ' + String(a.title || 'Касса') : 'Касса';
    }
    out.push({ id: Number(ids.find(id => !isRemoved(id))), method: r.method, methodId, amount: Number(r.amount), title });
  }
  return out;
}

// One service line in kopecks. YClients: cost_per_unit, amount, first_cost
// (before discount), discount (percent), cost (final).
function lineOf(s) {
  const quantity = Number(s.amount) || 1;
  const total = kop(s.cost);
  const unit = s.cost_per_unit != null && s.cost_per_unit !== '' ? kop(s.cost_per_unit) : null;
  const first = s.first_cost != null && s.first_cost !== '' && Number(s.first_cost) > 0 ? kop(s.first_cost) : null;
  const gross = Math.max(total, first != null ? first : unit != null ? Math.round(unit * quantity) : total);
  const discount = gross - total;
  let percent = Number(s.discount) || 0;
  if (!percent && discount > 0 && gross > 0) percent = Math.round(discount / gross * 10000) / 100;
  return { title: String(s.title || ''), quantity, unit: unit != null ? unit : Math.round(gross / quantity), gross, discount, percent, total };
}

function methodTitle(x, accounts) {
  if (x.method === 'loyalty_card') return 'Бонусы';
  const a = (accounts || []).find(v => Number(v.id) === Number(x.methodId));
  return a ? (a.type_slug === 'cash' ? 'Наличные' : 'Банковская карта') + ' · ' + String(a.title || 'Касса') : 'Касса';
}

// Status of a queued step by its package: waiting for «send», being sent, or failed.
function queuedStatus(x) {
  if (x.pkgStatus === 'failed') return 'failed';
  if (x.releasedAt || x.pkgStatus === 'running') return 'sending';
  return 'queued';
}

function localOptions({ recordId, record, ledger, queued, accounts, card, bonusPercent }) {
  const rec = record || {};
  const lines = (Array.isArray(rec.services) ? rec.services : []).map(lineOf);
  const items = lines.map(l => ({
    title: l.title, quantity: l.quantity, unitPrice: rub(l.unit), gross: rub(l.gross), discountPercent: l.percent,
    discount: rub(l.discount), total: rub(l.total),
  }));
  const total = lines.reduce((n, l) => n + l.total, 0);
  const grossSum = lines.reduce((n, l) => n + l.gross, 0);
  const paid = paidRows(ledger, accounts);
  const q = Array.isArray(queued) ? queued : [];
  const qPays = q.filter(x => x.kind === 'pay'), qRemoves = q.filter(x => x.kind === 'remove_payment');
  const paidSum = paid.reduce((n, p) => n + kop(p.amount), 0);
  const qNet = qPays.reduce((n, x) => n + kop(x.amount), 0) - qRemoves.reduce((n, x) => n + kop(x.amount), 0);
  const due = Math.max(0, total - paidSum - qPays.reduce((n, x) => n + kop(x.amount), 0) + qRemoves.reduce((n, x) => n + kop(x.amount), 0));
  const payments = [
    ...paid.map(p => ({ method: p.method, methodId: p.methodId, title: p.title, amount: p.amount, status: 'confirmed', outboxId: null, kind: 'payment' })),
    ...q.map(x => ({ method: x.method, methodId: Number(x.methodId), title: methodTitle(x, accounts), amount: Number(x.amount),
      status: queuedStatus(x), outboxId: x.outboxId ?? null, kind: x.kind === 'pay' ? 'payment' : 'remove_payment',
      // A payment saved in the journal and not yet sent can be deleted locally.
      opId: x.opId ?? null, cancellable: x.kind === 'pay' && queuedStatus(x) === 'queued' && !!x.opId && x.outboxId != null })),
  ];
  const bonusOf = list => list.filter(x => x.method === 'loyalty_card').reduce((n, x) => n + kop(x.amount), 0);
  const bonusQueued = bonusOf(qPays) - bonusOf(qRemoves);
  const summary = {
    gross: rub(Math.max(grossSum, total)), discount: rub(lines.reduce((n, l) => n + l.discount, 0)), total: rub(total),
    paidConfirmed: rub(paidSum), paidQueued: rub(qNet), bonusSpent: rub(bonusOf(paid) + bonusQueued), due: rub(due),
  };
  const waiting = Number(rec.attendance) === 0;
  const methods = (Array.isArray(accounts) ? accounts : []).filter(a => a && !a.is_acquiring).map(a => ({
    method: 'account', id: Number(a.id), title: String(a.title || ''), cash: a.type_slug === 'cash',
    available: due > 0, limit: rub(due), requiresArrivalConfirmation: waiting,
    unavailableReason: due > 0 ? null : 'Визит оплачен', balance: null,
  }));
  if (card && card.id != null) {
    // Без журнала: показание карты, из него вычитается очередь этого визита (balanceAfter).
    // С журналом (этап 3): card.ledger уже без всей очереди — лимит от него, «до оплаты» = он + очередь визита.
    const ledgerNow = card.ledger != null ? kop(card.ledger) : null;
    const balance = ledgerNow != null ? ledgerNow + bonusQueued : kop(card.balance);
    const spendable = ledgerNow != null ? ledgerNow : balance;
    const already = paid.filter(p => p.method === 'loyalty_card').reduce((n, p) => n + kop(p.amount), 0)
      + qPays.filter(x => x.method === 'loyalty_card').reduce((n, x) => n + kop(x.amount), 0);
    const pct = Number(bonusPercent);
    const cap = pct > 0 ? Math.floor(total * pct / 100) - already : Infinity;
    const limit = Math.max(0, Math.min(spendable, due, cap));
    methods.push({
      method: 'loyalty_card', id: Number(card.id), title: 'Бонусы', cash: false, available: limit > 0, limit: rub(limit),
      requiresArrivalConfirmation: false, unavailableReason: limit > 0 ? null : 'Нет доступных бонусов', balance: rub(balance), balanceAfter: rub(Math.max(0, ledgerNow != null ? ledgerNow : balance - bonusQueued)),
    });
  }
  return { local: true, recordId, clientName: String(rec.client?.name || ''), items, summary, payments, due: rub(due), paid, methods, pending: [], history: [], version: null };
}

function queuedOf(rows) {
  return (rows || []).flatMap(r => (Array.isArray(r.steps) ? r.steps : [])
    .filter(s => s && ['pay', 'remove_payment'].includes(s.kind) && s.state !== 'done')
    .map(s => ({ kind: s.kind, ...(s.params || {}), opId: s.opId || null, outboxId: r.id ?? null, pkgStatus: r.status, releasedAt: r.released_at || null })));
}

// Overlay `lines` (quantity, unitPrice, gross, discount %, total) priced onto services.
function priceByLines(services, lines) {
  return (Array.isArray(services) ? services : []).map(s => {
    const line = Array.isArray(lines) ? lines.find(l => Number(l.serviceId) === Number(s.id)) : null;
    const amount = Number(line?.quantity) || Number(s.amount) || 1;
    const out = { ...s, amount, cost: line?.total ?? s.cost };
    if (line?.unitPrice != null) {
      out.cost_per_unit = Number(line.unitPrice);
      out.first_cost = line.gross != null ? Number(line.gross) : Math.round(Number(line.unitPrice) * amount * 100) / 100;
      if (line.discount != null) out.discount = Number(line.discount);
    }
    return out;
  });
}

function synthesize(o) {
  return { services: priceByLines(o.services, o.lines), attendance: o.attendance ?? 0, client: o.client || {} };
}

async function cardBy(sql, args) {
  const row = await db.oneOrNone(sql, args);
  if (!row || row.yclients_card_id == null) return null;
  // ledger — наш баланс из журнала операций: в нём уже учтена ВСЯ очередь (в т.ч. этого визита).
  const ledger = bonusLedger.isPrimary() && row.ledger_open ? Number(row.bonus_balance) || 0 : null;
  return { id: row.yclients_card_id, balance: row.yclients_card_balance, ledger };
}

async function cardByPhone(salonId, phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  digits = digits.slice(-10);
  return cardBy(`SELECT ${CARD_COLS} FROM clients
        WHERE salon_id=$1 AND right(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$2 AND yclients_card_id IS NOT NULL
        ORDER BY id LIMIT 1`, [salonId, digits]);
}

async function references(salonId) {
  const [accounts, bonusPercent] = await Promise.all([reference.getReference(salonId, 'accounts'), reference.getBonusPercent(salonId)]);
  return { accounts: accounts || [], bonusPercent };
}

// Inputs of localOptions for an existing (positive) or queued (negative) record.
async function loadContext(salonId, recordId) {
  let record, ledger = [], queued, card = null;
  if (recordId < 0) {
    const row = await db.oneOrNone('SELECT * FROM journal_outbox WHERE salon_id=$1 AND id=$2', [salonId, -recordId]);
    if (!row || row.overlay?.kind !== 'create' || row.status === 'cancelled') m.fail('Запись не найдена.', 404);
    // Changes saved for the new record before it was sent ride on its create.
    const children = await db.any('SELECT * FROM journal_outbox WHERE salon_id=$1 AND create_outbox_id=$2 AND status = ANY($3) ORDER BY id', [salonId, -recordId, OPEN]);
    const base = overlay.applyOverlay([], [{ ...row, status: OPEN.includes(row.status) ? row.status : 'queued' }, ...children])[0];
    record = base ? { ...base, services: priceByLines(base.services, row.overlay.lines), client: row.overlay.client || {} } : synthesize(row.overlay);
    queued = queuedOf([row, ...children]);
    if (row.yclients_record_id != null) {
      ledger = await db.any('SELECT * FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2', [salonId, row.yclients_record_id]);
    }
    card = await cardByPhone(salonId, record.client?.phone);
  } else {
    const row = await db.oneOrNone('SELECT raw_payload FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salonId, recordId]);
    if (!row?.raw_payload) m.fail('Запись не найдена.', 404);
    const [l, open] = await Promise.all([
      db.any('SELECT * FROM journal_financial_transactions WHERE salon_id=$1 AND yclients_record_id=$2', [salonId, recordId]),
      db.any('SELECT * FROM journal_outbox WHERE salon_id=$1 AND yclients_record_id=$2 AND status = ANY($3) ORDER BY id', [salonId, recordId, OPEN]),
    ]);
    // Queued/running/failed packages of this record are laid over the mirror:
    // a queued confirm, arrival, move or cancel is already the visit's state.
    record = overlay.applyOverlay([{ ...row.raw_payload, id: row.raw_payload.id ?? recordId }], open)[0];
    ledger = l; queued = queuedOf(open);
    const clientId = Number(record.client?.id);
    if (clientId > 0) {
      card = await cardBy(`SELECT ${CARD_COLS} FROM clients WHERE salon_id=$1 AND yclients_client_id=$2 LIMIT 1`, [salonId, clientId]);
    }
  }
  return { recordId, record, ledger, queued, card, ...(await references(salonId)) };
}

// Inputs of localOptions for a create overlay that is not stored yet.
async function createContext(salonId, overlay) {
  const record = synthesize(overlay);
  const card = await cardByPhone(salonId, record.client?.phone);
  return { recordId: null, record, ledger: [], queued: [], card, ...(await references(salonId)) };
}

async function localPaymentOptions(salonId, recordId) {
  return localOptions(await loadContext(salonId, recordId));
}

module.exports = { localOptions, localPaymentOptions, loadContext, createContext, synthesize, OPEN };
