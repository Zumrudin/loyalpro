'use strict';
const crypto = require('crypto');
const { pool } = require('../../db');
const store = require('./store');
const ledger = require('./ledger');
const m = require('./model');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validUuid = v => typeof v === 'string' && UUID_RE.test(v);
const validId = v => Number.isSafeInteger(Number(v)) && Number(v) > 0;
const validation = errors => m.fail(errors[0], 400, 'validation', { errors });
const kindOf = g => g && g.loyalty_certificate_type_id != null ? 'certificate'
  : g && g.loyalty_abonement_type_id != null ? 'abonement' : 'good';
const normalizeCode = value => String(value || '').replace(/[^0-9A-Z]/gi, '').toUpperCase();
const codeValue = () => crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
async function transaction(salonId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client.query.bind(client));
    await client.query('COMMIT');
    client.release(); store.invalidateBalances(salonId); return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
    throw e;
  }
}

async function resolveRecord(q, salonId, recordId, clientId) {
  if (!Number.isSafeInteger(recordId) || recordId === 0 || (clientId != null && !validId(clientId))) validation(['Некорректная запись или клиент.']);
  if (recordId > 0) {
    const record = (await q(`SELECT client_id, yclients_client_id, status FROM records
      WHERE salon_id=$1 AND yclients_record_id=$2`, [salonId, recordId])).rows[0];
    if (!record) m.fail('Запись не найдена.', 404, 'record_not_found');
    if (record.status === 'deleted') m.fail('Нельзя изменить удалённую запись.', 409, 'record_deleted');
    const resolvedClientId = clientId == null ? record.client_id : Number(clientId);
    let client = resolvedClientId == null ? null : (await q('SELECT id, yclients_client_id FROM clients WHERE salon_id=$1 AND id=$2', [salonId, resolvedClientId])).rows[0];
    if (!client && record.yclients_client_id != null) client = (await q('SELECT id, yclients_client_id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salonId, record.yclients_client_id])).rows[0];
    if (!client) m.fail('Клиент не найден.', 404, 'client_not_found');
    if ((record.client_id != null && Number(record.client_id) !== Number(client.id)) ||
      (record.client_id == null && record.yclients_client_id != null && Number(record.yclients_client_id) !== Number(client.yclients_client_id)))
      m.fail('Клиент не совпадает с записью.', 409, 'client_mismatch');
    const outbox = (await q(`SELECT id FROM journal_outbox WHERE salon_id=$1 AND yclients_record_id=$2
      AND overlay->>'kind'='create' ORDER BY id LIMIT 1`, [salonId, recordId])).rows[0];
    return { client, localOutboxId: outbox ? Number(outbox.id) : null, ycRecordId: recordId, documentRecordId: recordId };
  }
  const outboxId = -recordId;
  const row = (await q(`SELECT id, yclients_record_id, overlay FROM journal_outbox
    WHERE salon_id=$1 AND id=$2 AND overlay->>'kind'='create' AND status<>'cancelled'`, [salonId, outboxId])).rows[0];
  if (!row) m.fail('Запись не найдена.', 404, 'record_not_found');
  const overlayClientId = Number(row.overlay?.client?.id);
  let client = clientId == null ? null : (await q('SELECT id, yclients_client_id FROM clients WHERE salon_id=$1 AND id=$2', [salonId, Number(clientId)])).rows[0];
  if (!client && overlayClientId > 0) client = (await q(`SELECT id,yclients_client_id FROM clients WHERE salon_id=$1
    AND yclients_client_id=$2 LIMIT 1`, [salonId, overlayClientId])).rows[0];
  const overlayPhone = String(row.overlay?.client?.phone || '').replace(/\D/g, '').slice(-10);
  if (!client && overlayPhone.length === 10) {
    const matches = (await q(`SELECT id,yclients_client_id FROM clients WHERE salon_id=$1
      AND RIGHT(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$2 LIMIT 2`, [salonId, overlayPhone])).rows;
    if (matches.length > 1) m.fail('Найдено несколько клиентов записи.', 409, 'ambiguous_client');
    client = matches[0];
  }
  if (!client) m.fail('Клиент не найден.', 404, 'client_not_found');
  if (overlayClientId > 0 && Number(client.yclients_client_id) !== overlayClientId && Number(client.id) !== overlayClientId)
    m.fail('Клиент не совпадает с записью.', 409, 'client_mismatch');
  if (!(overlayClientId > 0) && overlayPhone.length === 10) {
    const owned = (await q(`SELECT 1 FROM clients WHERE salon_id=$1 AND id=$2
      AND RIGHT(regexp_replace(COALESCE(phone,''),'\\D','','g'),10)=$3`, [salonId, client.id, overlayPhone])).rows;
    if (!owned.length) m.fail('Клиент не совпадает с записью.', 409, 'client_mismatch');
  }
  const ycRecordId = Number(row.yclients_record_id) > 0 ? Number(row.yclients_record_id) : null;
  return { client, localOutboxId: outboxId, ycRecordId, documentRecordId: ycRecordId || recordId };
}

const SET_SQL = `SELECT * FROM appointment_goods_sets WHERE salon_id=$1
  AND (($2::bigint IS NOT NULL AND local_outbox_id=$2) OR ($3::bigint IS NOT NULL AND yclients_record_id=$3))
  ORDER BY (yclients_record_id IS NOT NULL) DESC LIMIT 1`;
async function findSet(q, salonId, identity, lock = false) {
  return (await q(`${SET_SQL}${lock ? ' FOR UPDATE' : ''}`, [salonId, identity.localOutboxId, identity.ycRecordId])).rows[0] || null;
}

async function response(q, salonId, identity, set) {
  const lines = !set ? [] : (await q(`SELECT l.*, g.title,
      CASE WHEN g.loyalty_certificate_type_id IS NOT NULL THEN 'certificate'
           WHEN g.loyalty_abonement_type_id IS NOT NULL THEN 'abonement' ELSE 'good' END AS kind,
      c.id AS code_id_value, c.code, c.status AS code_status
    FROM appointment_goods_lines l
    JOIN stock_documents d ON d.id=l.document_id AND d.salon_id=l.salon_id AND d.status<>'cancelled'
    JOIN yclients_goods_catalog g ON g.id=l.good_row_id AND g.salon_id=l.salon_id
    LEFT JOIN appointment_goods_codes c ON c.id=l.code_id AND c.salon_id=l.salon_id
    WHERE l.salon_id=$1 AND l.set_id=$2 ORDER BY l.id`, [salonId, set.id])).rows;
  const docs = !set ? [] : (await q(`SELECT d.id,d.storage_id,d.status,d.total_cost,
      COALESCE(SUM(f.amount) FILTER (WHERE f.status='confirmed'),0) AS paid,
      count(f.id) FILTER (WHERE f.status IN ('queued','sending')) AS pending_count
    FROM stock_documents d LEFT JOIN finance_operations f
      ON f.salon_id=d.salon_id AND f.stock_document_id=d.id
    WHERE d.salon_id=$1 AND d.id IN (SELECT document_id FROM appointment_goods_lines WHERE salon_id=$1 AND set_id=$2)
      AND d.status<>'cancelled' GROUP BY d.id,d.storage_id,d.status,d.total_cost ORDER BY d.id`, [salonId, set.id])).rows;
  const legacy = (await q(`SELECT m.id,m.document_id,m.good_row_id,m.storage_id,m.qty,m.unit_type,
      m.cost_per_unit AS price,m.discount,m.cost AS total,m.master_staff_yc_id,g.title,
      CASE WHEN g.loyalty_certificate_type_id IS NOT NULL THEN 'certificate'
           WHEN g.loyalty_abonement_type_id IS NOT NULL THEN 'abonement' ELSE 'good' END AS kind,
      d.status,COALESCE((SELECT SUM(f.amount) FROM finance_operations f WHERE f.salon_id=d.salon_id
        AND f.stock_document_id=d.id AND f.status='confirmed'),0) AS document_paid
    FROM stock_documents d JOIN stock_movements m ON m.salon_id=d.salon_id AND m.document_id=d.id AND m.deleted_at IS NULL
    JOIN yclients_goods_catalog g ON g.id=m.good_row_id AND g.salon_id=m.salon_id
    WHERE d.salon_id=$1 AND d.kind='sale' AND d.status<>'cancelled' AND d.record_id=$2
      AND NOT EXISTS(SELECT 1 FROM appointment_goods_lines l WHERE l.salon_id=d.salon_id AND l.document_id=d.id)
    ORDER BY d.id,m.id`, [salonId, identity.documentRecordId])).rows;
  const docPaid = new Map(docs.map(d => [String(d.id), Number(d.paid) || 0]));
  const docLocked = new Map(docs.map(d => [String(d.id), Number(d.paid) > 0 || Number(d.pending_count) > 0]));
  const docTotals = new Map();
  for (const l of lines) docTotals.set(String(l.document_id), (docTotals.get(String(l.document_id)) || 0) + Number(l.total));
  const total = lines.reduce((sum, l) => sum + m.kop(l.total), 0) / 100;
  const paid = docs.reduce((sum, d) => sum + m.kop(d.paid), 0) / 100;
  const legacyTotals = new Map();
  for (const l of legacy) legacyTotals.set(String(l.document_id), (legacyTotals.get(String(l.document_id)) || 0) + Number(l.total));
  return {
    recordId: identity.ycRecordId || -identity.localOutboxId, version: set ? Number(set.version) : 0,
    documents: [...docs.map(d => ({ id: Number(d.id), storageId: Number(d.storage_id), status: d.status,
        total: Number(d.total_cost), paid: Number(d.paid), outstanding: Math.max(0, Math.round((Number(d.total_cost)-Number(d.paid))*100)/100),
        locked: Number(d.paid)>0 || Number(d.pending_count)>0 })),
      ...[...new Map(legacy.map(l => [String(l.document_id), { id: Number(l.document_id), storageId: Number(l.storage_id), status: l.status,
        total: legacyTotals.get(String(l.document_id)) || 0, paid: Number(l.document_paid),
        outstanding: Math.max(0, Math.round(((legacyTotals.get(String(l.document_id)) || 0)-Number(l.document_paid))*100)/100),
        readOnly: true, locked: true }])).values()]],
    lines: [...lines.map(l => ({ lineId: l.line_id, documentId: Number(l.document_id), goodRowId: Number(l.good_row_id), title: l.title,
      storageId: Number(l.storage_id), qty: Number(l.qty), unitType: Number(l.unit_type), price: Number(l.price),
      discount: Number(l.discount), total: Number(l.total),
      paid: Math.round((docPaid.get(String(l.document_id)) || 0) * Number(l.total) / (docTotals.get(String(l.document_id)) || 1) * 100) / 100,
      masterStaffYcId: l.master_staff_yc_id == null ? null : Number(l.master_staff_yc_id), kind: l.kind,
      code: l.code_id_value ? { id: l.code_id_value, value: l.code, status: l.code_status } : null,
      locked: docLocked.get(String(l.document_id)) === true })),
      ...legacy.map(l => ({ lineId: `legacy-${l.id}`, documentId: Number(l.document_id), goodRowId: Number(l.good_row_id), title: l.title,
        storageId: Number(l.storage_id), qty: Number(l.qty), unitType: Number(l.unit_type), price: Number(l.price),
        discount: Number(l.discount), total: Number(l.total),
        paid: Math.round(Number(l.document_paid)*Number(l.total)/(legacyTotals.get(String(l.document_id)) || 1)*100)/100,
        masterStaffYcId: l.master_staff_yc_id == null ? null : Number(l.master_staff_yc_id), kind: l.kind, code: null, readOnly: true }))],
    total: total + legacy.reduce((s,l)=>s+m.kop(l.total),0)/100,
    paid: paid + [...new Map(legacy.map(l=>[String(l.document_id),Number(l.document_paid)||0])).values()].reduce((a,b)=>a+b,0),
    outstanding: Math.max(0, Math.round(((total + legacy.reduce((s,l)=>s+m.kop(l.total),0)/100) -
      (paid + [...new Map(legacy.map(l=>[String(l.document_id),Number(l.document_paid)||0])).values()].reduce((a,b)=>a+b,0))) * 100) / 100),
  };
}

async function get(salonId, recordId, clientId) {
  return transaction(salonId, async q => {
    const identity = await resolveRecord(q, salonId, Number(recordId), clientId);
    const set = await findSet(q, salonId, identity);
    return response(q, salonId, identity, set);
  });
}

function requestHash(userId, body) {
  const canonical = { userId: Number(userId), version: Number(body.version), clientId: Number(body.clientId), lines: body.lines };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function save(salonId, userId, recordId, body) {
  const b = body || {};
  if (!validUuid(b.requestId) || !Number.isSafeInteger(Number(b.version)) || Number(b.version) < 0 || !Array.isArray(b.lines))
    validation(['requestId, version и lines обязательны.']);
  if (b.lines.length > 100) validation(['Не больше 100 товарных строк.']);
  const hash = requestHash(userId, b);
  return transaction(salonId, async q => {
    await q('SELECT pg_advisory_xact_lock($1, hashtext($2))', [salonId, b.requestId.toLowerCase()]);
    const identity = await resolveRecord(q, salonId, Number(recordId), b.clientId);
    const replay = (await q('SELECT * FROM appointment_goods_requests WHERE salon_id=$1 AND request_id=$2', [salonId, b.requestId])).rows[0];
    if (replay) {
      if (replay.request_hash !== hash) m.fail('requestId уже использован с другими данными.', 409, 'idempotency_conflict');
      const replaySet = await findSet(q, salonId, identity);
      if (!replaySet || Number(replaySet.id) !== Number(replay.set_id)) m.fail('requestId уже использован для другой записи.', 409, 'idempotency_conflict');
      return response(q, salonId, identity, replaySet);
    }
    let set = await findSet(q, salonId, identity, true);
    if (!set) {
      if (Number(b.version) !== 0) m.fail('Состав записи изменился.', 409, 'version_conflict');
      set = (await q(`INSERT INTO appointment_goods_sets(salon_id,local_outbox_id,yclients_record_id,client_id)
        VALUES($1,$2,$3,$4) RETURNING *`, [salonId, identity.localOutboxId, identity.ycRecordId, identity.client.id])).rows[0];
    } else {
      if (Number(set.client_id) !== Number(identity.client.id)) m.fail('Клиент не совпадает с продажей.', 409, 'client_mismatch');
      if (Number(set.version) !== Number(b.version)) m.fail('Состав записи изменился.', 409, 'version_conflict');
      if (identity.ycRecordId && set.yclients_record_id == null) {
        set = (await q(`UPDATE appointment_goods_sets SET yclients_record_id=$3,updated_at=NOW()
          WHERE salon_id=$1 AND id=$2 RETURNING *`, [salonId, set.id, identity.ycRecordId])).rows[0];
        await q(`UPDATE stock_documents SET record_id=$3,updated_at=NOW() WHERE salon_id=$1
          AND id IN (SELECT document_id FROM appointment_goods_lines WHERE salon_id=$1 AND set_id=$2)`,
        [salonId, set.id, identity.ycRecordId]);
        await q(`UPDATE stock_movements SET record_id=$3 WHERE salon_id=$1
          AND document_id IN (SELECT document_id FROM appointment_goods_lines WHERE salon_id=$1 AND set_id=$2)`,
        [salonId, set.id, identity.ycRecordId]);
      }
    }
    const oldDocs = (await q(`SELECT d.id FROM stock_documents d WHERE d.salon_id=$1 AND EXISTS
      (SELECT 1 FROM appointment_goods_lines l WHERE l.salon_id=$1 AND l.set_id=$2 AND l.document_id=d.id) FOR UPDATE`, [salonId, set.id])).rows;
    const paidDocIds = new Set();
    if (oldDocs.length) {
      const state = (await q(`SELECT count(*) FILTER (WHERE status IN ('queued','sending')) AS pending,
        stock_document_id, COALESCE(SUM(amount) FILTER (WHERE status='confirmed'),0) AS paid FROM finance_operations
        WHERE salon_id=$1 AND stock_document_id=ANY($2::bigint[]) GROUP BY stock_document_id`, [salonId, oldDocs.map(d => d.id)])).rows;
      for (const s of state) if (Number(s.pending) > 0 || m.kop(s.paid) > 0) paidDocIds.add(Number(s.stock_document_id));
    }
    const goodsRows = b.lines.length ? (await q(`SELECT * FROM yclients_goods_catalog
      WHERE salon_id=$1 AND id=ANY($2::bigint[])`, [salonId, b.lines.map(l => Number(l.goodRowId))])).rows : [];
    const goods = new Map(goodsRows.map(g => [Number(g.id), g]));
    const storageRows = b.lines.length ? (await q(`SELECT * FROM stock_storages
      WHERE salon_id=$1 AND id=ANY($2::bigint[]) AND is_active=TRUE`, [salonId, b.lines.map(l => Number(l.storageId))])).rows : [];
    const storages = new Map(storageRows.map(s => [Number(s.id), s]));
    const normalized = [], errors = [], seenLines = new Set(), seenCodes = new Set();
    for (let i = 0; i < b.lines.length; i++) {
      const l = b.lines[i] || {}, good = goods.get(Number(l.goodRowId)), storage = storages.get(Number(l.storageId));
      const lineId = l.lineId == null ? crypto.randomUUID() : String(l.lineId).toLowerCase();
      const qty = Number(l.qty), unitType = Number(l.unitType), price = Number(l.price), discount = l.discount == null ? 0 : Number(l.discount);
      if (!validUuid(lineId) || seenLines.has(lineId)) errors.push(`Строка ${i + 1}: некорректный lineId.`); else seenLines.add(lineId);
      if (!good || good.stock_active === false) errors.push(`Строка ${i + 1}: товар не найден или неактивен.`);
      if (!storage || storage.for_sale !== true) errors.push(`Строка ${i + 1}: склад не найден или не предназначен для продажи.`);
      if (!Number.isFinite(qty) || !(qty > 0) || ![1, 2].includes(unitType) || !Number.isFinite(price) || !(price >= 0) ||
        !Number.isFinite(discount) || !(discount >= 0 && discount <= 100)) errors.push(`Строка ${i + 1}: некорректные количество, цена или скидка.`);
      if (l.masterStaffYcId != null && !validId(l.masterStaffYcId)) errors.push(`Строка ${i + 1}: некорректный специалист.`);
      const total = Math.round(qty * price * (1 - discount / 100) * 100) / 100;
      if (l.total != null && m.kop(l.total) !== m.kop(total)) errors.push(`Строка ${i + 1}: итог не совпадает с ценой и скидкой.`);
      const kind = kindOf(good);
      if (good && good.loyalty_certificate_type_id != null && good.loyalty_abonement_type_id != null)
        errors.push(`Строка ${i + 1}: у товара одновременно указаны тип сертификата и абонемента.`);
      if (kind !== 'good' && qty !== 1) errors.push(`Строка ${i + 1}: сертификат или абонемент продаётся по одному.`);
      if (kind !== 'good' && !validUuid(l.codeReservationId)) errors.push(`Строка ${i + 1}: нужен уникальный код.`);
      if (kind === 'good' && l.codeReservationId != null) errors.push(`Строка ${i + 1}: код доступен только сертификату или абонементу.`);
      if (l.codeReservationId && seenCodes.has(String(l.codeReservationId).toLowerCase())) errors.push(`Строка ${i + 1}: код повторяется.`);
      if (l.codeReservationId) seenCodes.add(String(l.codeReservationId).toLowerCase());
      const base = good ? m.toBaseInfo({ kind: 'sale', qty, unitType, unitEquals: good.unit_equals, costPerUnit: price, cost: total }) : {};
      normalized.push({ lineId, good, storage, goodRowId: Number(l.goodRowId), storageId: Number(l.storageId), qty, unitType,
        price, discount, total, qtyBase: base.qtyBase, masterStaffYcId: l.masterStaffYcId == null ? null : Number(l.masterStaffYcId),
        codeId: l.codeReservationId ? String(l.codeReservationId).toLowerCase() : null, kind });
    }
    if (errors.length) validation(errors);
    const staffIds = [...new Set(normalized.map(l => l.masterStaffYcId).filter(Boolean))];
    if (staffIds.length) {
      const ref = (await q("SELECT payload FROM journal_reference_cache WHERE salon_id=$1 AND kind='staff'", [salonId])).rows[0]?.payload;
      const active = new Set((Array.isArray(ref) ? ref : []).filter(s => s && !s.fired).map(s => Number(s.id)));
      if (staffIds.some(id => !active.has(id))) validation(['Специалист не найден в салоне.']);
    }
    const codeIds = normalized.filter(l => l.codeId).map(l => l.codeId);
    const codeRows = codeIds.length ? (await q(`SELECT * FROM appointment_goods_codes WHERE salon_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE`, [salonId, codeIds])).rows : [];
    const codes = new Map(codeRows.map(c => [String(c.id), c]));
    for (const l of normalized.filter(x => x.codeId)) {
      const c = codes.get(l.codeId);
      const sameSetIssued = c && ['issued', 'active'].includes(c.status) && (await q(`SELECT 1 FROM appointment_goods_lines
        WHERE salon_id=$1 AND set_id=$2 AND code_id=$3`, [salonId, set.id, c.id])).rows.length > 0;
      if (!c || Number(c.good_row_id) !== l.goodRowId || c.kind !== l.kind || !(c.status === 'reserved' || sameSetIssued))
        m.fail('Код не принадлежит этому товару или уже недоступен.', 409, 'code_unavailable');
    }
    if (paidDocIds.size) {
      const locked = (await q(`SELECT line_id,document_id,good_row_id,storage_id,qty,unit_type,price,discount,total,master_staff_yc_id,code_id
        FROM appointment_goods_lines WHERE salon_id=$1 AND set_id=$2 AND document_id=ANY($3::bigint[])`,
      [salonId, set.id, [...paidDocIds]])).rows;
      const incoming = new Map(normalized.map(l => [l.lineId, l]));
      for (const old of locked) {
        const l = incoming.get(String(old.line_id));
        const same = l && l.goodRowId === Number(old.good_row_id) && l.storageId === Number(old.storage_id) &&
          l.qty === Number(old.qty) && l.unitType === Number(old.unit_type) && m.kop(l.price) === m.kop(old.price) &&
          l.discount === Number(old.discount) && m.kop(l.total) === m.kop(old.total) &&
          (l.masterStaffYcId || null) === (old.master_staff_yc_id == null ? null : Number(old.master_staff_yc_id)) &&
          (l.codeId || null) === (old.code_id ? String(old.code_id) : null);
        if (!same) m.fail('Оплаченные товары нельзя изменить или удалить. Добавьте новую позицию отдельно.', 409, 'paid_sale_immutable');
        incoming.delete(String(old.line_id));
      }
      normalized.splice(0, normalized.length, ...normalized.filter(l => incoming.has(l.lineId)));
    }
    const replaceDocIds = oldDocs.map(d => Number(d.id)).filter(id => !paidDocIds.has(id));
    for (const d of oldDocs.filter(x => replaceDocIds.includes(Number(x.id)))) {
      await store.cancelDocument(q, salonId, Number(d.id), 'Состав товаров записи изменён');
      await store.softDeleteDocumentMovements(q, salonId, Number(d.id));
    }
    const retainedCodes = new Set(codeIds);
    await q(`UPDATE appointment_goods_codes SET status='cancelled',updated_at=NOW()
      WHERE salon_id=$1 AND id IN (SELECT code_id FROM appointment_goods_lines WHERE salon_id=$1 AND set_id=$2 AND document_id=ANY($4::bigint[]))
      AND NOT(id=ANY($3::uuid[]))`, [salonId, set.id, [...retainedCodes], replaceDocIds]);
    if (replaceDocIds.length) await q(`DELETE FROM appointment_goods_lines WHERE salon_id=$1 AND set_id=$2
      AND document_id=ANY($3::bigint[])`, [salonId, set.id, replaceDocIds]);
    const groups = new Map();
    for (const l of normalized) { const key = `${l.storageId}:${l.kind}:${l.masterStaffYcId || ''}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(l); }
    for (const lines of groups.values()) {
      const storageId = lines[0].storageId;
      const totalCost = lines.reduce((sum, l) => sum + m.kop(l.total), 0) / 100;
      const masterIds = [...new Set(lines.map(l => l.masterStaffYcId).filter(Boolean))];
      const now = (await q('SELECT NOW() AS now')).rows[0].now;
      const doc = await store.insertDocument(q, salonId, { kind: 'sale', origin: 'loyalpro', status: 'posted', storageId,
        clientId: identity.client.id, ycClientId: identity.client.yclients_client_id, recordId: identity.documentRecordId,
        masterStaffYcId: masterIds.length === 1 ? masterIds[0] : null, docDate: now, totalCost, createdBy: userId });
      await ledger.postDocument(q, salonId, { ...doc, storageId, recordId: identity.documentRecordId, docDate: now, source: 'loyalpro' },
        lines.map(l => ({ goodRowId: l.goodRowId, qty: l.qty, unitType: l.unitType, qtyBase: l.qtyBase,
          costPerUnit: l.price, discount: l.discount, cost: l.total, masterStaffYcId: l.masterStaffYcId })));
      for (const l of lines) {
        await q(`INSERT INTO appointment_goods_lines(set_id,salon_id,line_id,document_id,good_row_id,storage_id,qty,unit_type,price,discount,total,master_staff_yc_id,code_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [set.id, salonId, l.lineId, doc.id, l.goodRowId, l.storageId, l.qty, l.unitType, l.price, l.discount, l.total, l.masterStaffYcId, l.codeId]);
        if (l.codeId) await q(`UPDATE appointment_goods_codes SET status='issued',document_id=$3,updated_at=NOW()
          WHERE salon_id=$1 AND id=$2`, [salonId, l.codeId, doc.id]);
      }
    }
    set = (await q(`UPDATE appointment_goods_sets SET version=version+1,updated_at=NOW(),
      yclients_record_id=COALESCE(yclients_record_id,$3) WHERE salon_id=$1 AND id=$2 RETURNING *`,
    [salonId, set.id, identity.ycRecordId])).rows[0];
    await q(`INSERT INTO appointment_goods_requests(salon_id,request_id,request_hash,set_id,version)
      VALUES($1,$2,$3,$4,$5)`, [salonId, b.requestId, hash, set.id, set.version]);
    return response(q, salonId, identity, set);
  });
}

async function reserveCode(salonId, userId, goodRowId, requestId) {
  if (!validId(goodRowId) || !validUuid(requestId)) validation(['Некорректный товар или requestId.']);
  return transaction(salonId, async q => {
    await q('SELECT pg_advisory_xact_lock(hashtext($1))', [requestId.toLowerCase()]);
    const prior = (await q('SELECT * FROM appointment_goods_codes WHERE salon_id=$1 AND request_id=$2', [salonId, requestId])).rows[0];
    if (prior) {
      if (Number(prior.good_row_id) !== Number(goodRowId)) m.fail('requestId уже использован для другого товара.', 409, 'idempotency_conflict');
      return { id: prior.id, value: prior.code, kind: prior.kind, goodRowId: Number(prior.good_row_id), status: prior.status };
    }
    const good = (await q('SELECT * FROM yclients_goods_catalog WHERE salon_id=$1 AND id=$2 AND stock_active=TRUE', [salonId, Number(goodRowId)])).rows[0];
    const kind = kindOf(good);
    if (!good || kind === 'good' || (good.loyalty_certificate_type_id != null && good.loyalty_abonement_type_id != null))
      validation(['Код можно создать только для однозначно настроенного сертификата или абонемента.']);
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = crypto.randomUUID(), value = codeValue(), normalized = normalizeCode(value);
      const row = (await q(`INSERT INTO appointment_goods_codes(id,request_id,salon_id,reserved_by,good_row_id,kind,code,normalized_code,status,reserved_until)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',NOW()+INTERVAL '100 years')
          ON CONFLICT(normalized_code) DO NOTHING RETURNING *`,
        [id, requestId, salonId, userId, goodRowId, kind, value, normalized])).rows[0];
      if (row) return { id: row.id, value: row.code, kind: row.kind, goodRowId: Number(row.good_row_id), status: row.status };
    }
    m.fail('Не удалось сгенерировать уникальный код.', 503, 'code_generation_failed');
  });
}

async function syncCodesForDocument(q, salonId, documentId, status) {
  if (!['active', 'cancelled'].includes(status)) throw new Error('invalid code status');
  await q(`UPDATE appointment_goods_codes SET status=$3,updated_at=NOW()
    WHERE salon_id=$1 AND document_id=$2 AND status ${status === 'active' ? "IN ('issued','active')" : "<>'cancelled'"}`,
  [salonId, documentId, status]);
}

async function saleKindForDocument(q, salonId, documentId) {
  const rows = (await q(`SELECT DISTINCT CASE
      WHEN g.loyalty_certificate_type_id IS NOT NULL THEN 'certificate_sale'
      WHEN g.loyalty_abonement_type_id IS NOT NULL THEN 'abonement_sale'
      ELSE 'goods_sale' END AS kind
    FROM appointment_goods_lines l JOIN yclients_goods_catalog g
      ON g.id=l.good_row_id AND g.salon_id=l.salon_id
    WHERE l.salon_id=$1 AND l.document_id=$2`, [salonId, documentId])).rows;
  return rows.length === 1 ? rows[0].kind : 'goods_sale';
}

module.exports = { get, save, reserveCode, syncCodesForDocument, saleKindForDocument, normalizeCode, kindOf, requestHash };
