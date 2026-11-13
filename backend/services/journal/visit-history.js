'use strict';
// «История посещений» of a journal card (13.11.2026): the client's visits
// (mirror `records` + journal packages not sent yet) and purchases of
// cosmetics, certificates and abonements. LoyalPro data only, no YClients:
//  - visits: mirrored records of the client, open outbox packages laid over
//    them (overlay.js), new records still in the queue matched by phone;
//  - «Оплачено»: the unified money ledger `finance_operations` (journal
//    payments incl. queued ones, YClients cash operations, bonus payments —
//    already deduplicated there);
//  - purchases: finance_operations goods_sale / certificate_sale /
//    abonement_sale; the item title via revenue_operations.sold_item_id →
//    goods_transactions. A purchase made in a visit is shown inside it.
//  - consumables under a service: goods_transactions write-offs (type 2).
const { db } = require('../../db');
const m = require('./model');
const overlay = require('./overlay');
const sources = require('./sources');
const clientSummary = require('./client-summary');

const CAP = 300;
const PAID_STATUSES = ['queued', 'sending', 'confirmed'];
const PURCHASE_KINDS = { goods_sale: 'goods', certificate_sale: 'certificate', abonement_sale: 'abonement' };
const PURCHASE_TITLE = { goods: 'Косметика', certificate: 'Сертификат', abonement: 'Абонемент' };
const ALIVE = `COALESCE(status,'')<>'deleted' AND COALESCE(raw_payload->>'deleted','false') NOT IN ('true','1')`;
// All visits of the client, past and future. Without a YClients id — by the
// phone inside the record, last 2 years (as the client panel).
const RECORDS_BY_ID_SQL = `SELECT raw_payload FROM records WHERE salon_id=$1 AND yclients_client_id=$2 AND ${ALIVE}
  ORDER BY visit_datetime DESC NULLS LAST LIMIT ${CAP}`;
const RECORDS_BY_PHONE_SQL = `SELECT raw_payload FROM records WHERE salon_id=$1
  AND right(regexp_replace(COALESCE(raw_payload->'client'->>'phone',''),'\\D','','g'),10)=right($2,10)
  AND visit_date >= CURRENT_DATE - 730 AND ${ALIVE} ORDER BY visit_datetime DESC NULLS LAST LIMIT ${CAP}`;
// Money and purchases: by record, by journal package (records not sent yet) and by client.
const OPS_SQL = `SELECT f.id, f.occurred_at, f.kind, f.method, f.amount, f.status, f.origin, f.yclients_record_id, f.outbox_id,
    f.title, r.sold_by_yc_staff_id AS staff_yc_id, g.good_title, g.amount AS qty, g.unit_title
  FROM finance_operations f
  LEFT JOIN revenue_operations r ON r.id = f.revenue_operation_id
  LEFT JOIN goods_transactions g ON g.salon_id = f.salon_id
    AND g.yclients_txn_id = CASE WHEN r.raw_payload->'data'->>'sold_item_id' ~ '^[0-9]{1,18}$'
      THEN (r.raw_payload->'data'->>'sold_item_id')::bigint END AND g.deleted_at IS NULL
  WHERE f.salon_id=$1 AND f.status = ANY($2::text[])
    AND (f.yclients_record_id = ANY($3::bigint[]) OR f.outbox_id = ANY($4::bigint[])
      OR (f.kind = ANY($5::text[]) AND (($6::int IS NOT NULL AND f.client_id=$6) OR ($7::bigint IS NOT NULL AND f.yclients_client_id=$7))))
  ORDER BY f.occurred_at DESC, f.id DESC LIMIT 1000`;
const CONSUMABLES_SQL = `SELECT record_id, service_id, good_title, amount, unit_title, cost FROM goods_transactions
  WHERE salon_id=$1 AND type_id=2 AND deleted_at IS NULL AND record_id = ANY($2::bigint[]) ORDER BY id`;

const kop = v => Math.round((Number(v) || 0) * 100);
const rub = k => k / 100;
const last10 = v => String(v ?? '').replace(/\D/g, '').slice(-10);

// What one ledger row adds to «Оплачено» of its visit (kopecks).
function paidDelta(op) {
  const a = kop(op.amount);
  if (op.kind === 'visit_payment') return a;
  if (op.kind === 'bonus_redemption') return -a; // stored as a negative bonus movement
  if (op.kind === 'payment_reversal') return op.method === 'bonus' ? -a : a; // bonus back (+) / money back (−)
  return 0;
}
const qtyText = (qty, unit) => {
  const q = Math.abs(Number(qty)) || 0;
  return q ? `${String(Math.round(q * 1000) / 1000).replace('.', ',')} ${unit || 'шт.'}` : '';
};
function purchaseOf(op) {
  const type = PURCHASE_KINDS[op.kind];
  return {
    type, title: String(op.good_title || op.title || PURCHASE_TITLE[type]),
    quantity: qtyText(op.qty, op.unit_title) || null,
    amount: rub(Math.abs(kop(op.amount))), status: op.status,
  };
}

// The same payment can sit in the ledger twice: our journal row and the
// YClients cash operation that did not get linked to it (seen on dev 13.11.2026,
// record 2144720275: journal 27 000 on 13.11 + YClients 27 000 on 16.11). An
// external row with the record, kind, method and amount of a journal row is
// counted once.
function dropUnlinkedTwins(ops) {
  const key = op => [op.yclients_record_id, op.kind, op.method, kop(op.amount)].join(':');
  const journal = new Map();
  for (const op of ops) if (op.origin === 'journal' && op.yclients_record_id != null && !PURCHASE_KINDS[op.kind]) journal.set(key(op), (journal.get(key(op)) || 0) + 1);
  return ops.filter(op => {
    if (op.origin === 'journal' || op.yclients_record_id == null || PURCHASE_KINDS[op.kind]) return true;
    const n = journal.get(key(op)) || 0;
    if (!n) return true;
    journal.set(key(op), n - 1);
    return false;
  });
}
// Pure assembly of the history (tested without the DB).
function build({ records, ops, consumables, outboxOf = new Map(), salonName = '' }) {
  ops = dropUnlinkedTwins(ops || []);
  const visits = new Map();
  for (const r of records) {
    const at = m.moscowParts(r.datetime || r.date);
    const total = (Array.isArray(r.services) ? r.services : []).reduce((n, s) => n + kop(s.cost), 0);
    visits.set(String(r.id), { r, at, total, paid: 0, purchases: [] });
  }
  const standalone = [];
  for (const op of ops) {
    const key = op.yclients_record_id != null ? String(op.yclients_record_id)
      : op.outbox_id != null && outboxOf.has(String(op.outbox_id)) ? outboxOf.get(String(op.outbox_id)) : null;
    const v = key != null ? visits.get(key) : null;
    if (PURCHASE_KINDS[op.kind]) {
      const p = purchaseOf(op);
      if (v) v.purchases.push(p);
      else {
        const at = m.moscowParts(op.occurred_at instanceof Date ? op.occurred_at.toISOString() : op.occurred_at);
        standalone.push({ ...p, at, recordId: op.yclients_record_id != null ? Number(op.yclients_record_id) : null,
          staffId: op.staff_yc_id != null ? Number(op.staff_yc_id) : null });
      }
    } else if (v) v.paid += paidDelta(op);
  }
  const cons = new Map();
  for (const c of consumables || []) {
    const k = String(c.record_id) + ':' + String(c.service_id ?? '');
    if (!cons.has(k)) cons.set(k, []);
    cons.get(k).push({ title: String(c.good_title || 'Расходник'), quantity: qtyText(c.amount, c.unit_title), cost: rub(kop(c.cost)) });
  }
  const entries = [];
  for (const [key, v] of visits) {
    const r = v.r;
    // «Оплачено» per line: a visit paid in full is paid line by line; otherwise
    // the visit's payments are laid over the lines in order (no per-line source
    // covers bonuses and journal payments alike).
    let left = Number(r.paid_full) === 1 ? Math.max(v.total, v.paid) : Math.max(0, v.paid);
    const services = (Array.isArray(r.services) ? r.services : []).map(s => {
      const cost = kop(s.cost);
      const paid = Math.min(cost, left); left -= paid;
      return { id: Number(s.id), title: String(s.title || 'Услуга'), quantity: Number(s.amount) || 1,
        cost: rub(cost), paid: rub(paid), consumables: cons.get(String(r.id) + ':' + String(s.id)) || [] };
    });
    entries.push({
      kind: 'visit', recordId: Number(r.id), date: v.at?.date || null, time: v.at?.time || null, sortAt: v.at?.ms ?? 0,
      staffId: Number(r.staff_id || r.staff?.id) || null, staffName: r.staff?.name ? String(r.staff.name) : null,
      attendance: Number(r.attendance) || 0,
      services, purchases: v.purchases, total: rub(v.total), paid: rub(Math.max(0, v.paid)),
      paidFull: Number(r.paid_full) === 1,
    });
  }
  for (const p of standalone) {
    entries.push({ kind: 'purchase', recordId: p.recordId, date: p.at?.date || null, time: p.at?.time || null, sortAt: p.at?.ms ?? 0,
      staffId: p.staffId, staffName: null, purchases: [{ type: p.type, title: p.title, quantity: p.quantity, amount: p.amount, status: p.status }] });
  }
  entries.sort((a, b) => b.sortAt - a.sortAt || (b.recordId || 0) - (a.recordId || 0));
  return { salonName, entries: entries.map(({ sortAt, ...e }) => e) };
}

async function load(salonId, query = {}) {
  const { salon, client, yc, ph } = await clientSummary.resolveClient(salonId, query);
  const [rows, open] = await Promise.all([
    yc ? db.any(RECORDS_BY_ID_SQL, [salonId, yc]) : ph ? db.any(RECORDS_BY_PHONE_SQL, [salonId, ph]) : Promise.resolve([]),
    sources.openOutbox(salonId),
  ]);
  const mirrored = rows.map(x => x.raw_payload).filter(Boolean).map(r => ({ ...r }));
  const ids = new Set(mirrored.map(r => String(r.id)));
  // Our open packages over the mirror; new records still in the queue join by phone.
  const laid = overlay.applyOverlay(mirrored, open || []).filter(r => {
    if (r.deleted) return false;
    if (ids.has(String(r.id))) return true;
    return !!ph && Number(r.id) < 0 && last10(r.client?.phone) === last10(ph);
  });
  // A package of a queued new record (and its later changes) → its -id.
  const shown = new Set(laid.map(r => String(r.id)));
  const outboxOf = new Map();
  for (const o of open || []) {
    if (o.yclients_record_id != null) continue;
    const key = o.overlay?.kind === 'create' ? -Number(o.id) : o.create_outbox_id != null ? -Number(o.create_outbox_id) : null;
    if (key != null && shown.has(String(key))) outboxOf.set(String(o.id), String(key));
  }
  const realIds = laid.map(r => Number(r.id)).filter(n => n > 0);
  const [ops, consumables] = await Promise.all([
    db.any(OPS_SQL, [salonId, PAID_STATUSES, realIds, [...outboxOf.keys()].map(Number), Object.keys(PURCHASE_KINDS),
      client?.id != null ? Number(client.id) : null, yc]),
    realIds.length ? db.any(CONSUMABLES_SQL, [salonId, realIds]) : Promise.resolve([]),
  ]);
  return build({ records: laid, ops, consumables, outboxOf, salonName: String(salon?.name || '') });
}

module.exports = { load, build, paidDelta, dropUnlinkedTwins, RECORDS_BY_ID_SQL, RECORDS_BY_PHONE_SQL, OPS_SQL, CONSUMABLES_SQL, CAP };
