'use strict';
// Physical cabinet numbers, independent of legally numbered contracts.
const { db, withTransaction } = require('../db');
const { applyOverlay } = require('./journal/overlay');
const { isCalendarDate, todayMsk } = require('../utils/period');
const logger = require('../logger').createLogger('PaperFolders');
const CAPACITY = 2000;
const phoneKey = value => String(value || '').replace(/\D/g, '').slice(-10);
const dayKey = value => value instanceof Date || /[TZ+]/.test(String(value || ''))
  ? new Date(value).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }) : String(value || '').slice(0, 10);
const millis = value => value instanceof Date ? value.getTime() : Date.parse(value);
const dateTime = r => r.datetime || r.date || '';
const live = r => !r.deleted && (r._sync || !['cancelled', 'deleted', 'no_show'].includes(r._status)) && Number(r.attendance) !== -1;
const paidVisit = r => live(r) && Number(r.attendance) === 1 && Number(r.paid_full) === 1;
const view = row => ({ number: row?.number ?? null, archived: !!row?.archived, prepared: !!row?.prepared,
  archivedAt: row?.archived_at ?? null });
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
async function safely(fn) {
  try { return await fn(); } catch (_) { logger.warn('Paper folder reconciliation failed; retry on next record event or cabinet reconciliation.'); return null; }
}
const rows = async (q, sql, args) => (await q.query(sql, args)).rows;
const one = async (q, sql, args) => (await rows(q, sql, args))[0] || null;
async function lock(q, salonId) {
  // Every allocator/archiver uses the same tenant lock, including provisional drafts.
  await q.query('SELECT pg_advisory_xact_lock(714032, $1::integer)', [salonId]);
}
async function event(q, f, action, userId = null, number = f.number) {
  await q.query(`INSERT INTO paper_folder_events(salon_id,folder_id,client_id,number,action,user_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [f.salon_id, f.id, f.client_id, number, action, userId]);
}
async function freeNumber(q, salonId) {
  return (await one(q, `SELECT n FROM generate_series(1,2000) n WHERE NOT EXISTS
    (SELECT 1 FROM paper_folders f WHERE f.salon_id=$1 AND f.number=n) ORDER BY n LIMIT 1`, [salonId]))?.n ?? null;
}
async function client(q, salonId, clientId) {
  return one(q, 'SELECT id,salon_id,yclients_client_id,name,phone,visits_count,last_visit_at FROM clients WHERE salon_id=$1 AND id=$2', [salonId, clientId]);
}
async function state(q, salonId, clientId) {
  return one(q, 'SELECT * FROM paper_folders WHERE salon_id=$1 AND client_id=$2', [salonId, clientId]);
}
async function ensure(q, salonId, clientId) {
  return one(q, `INSERT INTO paper_folders(salon_id,client_id) VALUES($1,$2)
    ON CONFLICT(salon_id,client_id) DO UPDATE SET client_id=EXCLUDED.client_id RETURNING *`, [salonId, clientId]);
}
async function outbox(q, salonId) {
  return rows(q, `SELECT id,salon_id,create_outbox_id,yclients_record_id,overlay,status,created_at,updated_at,released_at
    FROM journal_outbox WHERE salon_id=$1 AND (status IN ('queued','running','failed')
      OR (status='done' AND updated_at>NOW()-INTERVAL '5 minutes')) ORDER BY id`, [salonId]);
}
function belongs(r, c) {
  if (r._clientId != null && !r._sync) return Number(r._clientId) === Number(c.id);
  if (r.client?.id != null && c.yclients_client_id != null) return String(r.client.id) === String(c.yclients_client_id);
  const p = phoneKey(r.client?.phone);
  return p.length === 10 && p === phoneKey(c.phone);
}
async function snapshot(q, salonId, c, f) {
  const since = f?.cycle_started_at ? dayKey(f.cycle_started_at) : todayMsk();
  const stored = await rows(q, `SELECT id,client_id,yclients_record_id,visit_datetime,status,raw_payload,created_at
    FROM records WHERE salon_id=$1 AND (client_id=$2 OR (client_id IS NULL AND yclients_client_id=$4))
      AND visit_date>= $3::date`, [salonId, c.id, since, c.yclients_client_id]);
  const raw = stored.map(r => ({ ...(r.raw_payload || {}), id: r.yclients_record_id,
    datetime: r.visit_datetime ? new Date(r.visit_datetime).toISOString() : r.raw_payload?.datetime || r.raw_payload?.date,
    _clientId: r.client_id ?? c.id, _status: r.status, _createdAt: r.created_at }));
  const pending = await outbox(q, salonId);
  const overlaid = applyOverlay(raw, pending);
  return { actual: raw, effective: overlaid.filter(r => belongs(r, c)),
    reassigned: raw.some(r => overlaid.some(next => String(next.id) === String(r.id) && !belongs(next, c))), pending };
}
async function primary(q, c, actual = []) {
  if (c.last_visit_at) return false;
  if (await one(q, `SELECT 1 FROM records WHERE salon_id=$1 AND
    (client_id=$2 OR (client_id IS NULL AND yclients_client_id=$3))
    AND status IN ('arrived','completed') AND COALESCE(raw_payload->>'deleted','false') NOT IN ('true','1')
    AND visit_datetime <= NOW() LIMIT 1`, [c.salon_id, c.id, c.yclients_client_id])) return false;
  // YClients counters can already include the upcoming first appointment.
  // Prefer its explicit new-client flag; actual attendance above wins over it.
  const flags = actual.filter(r => [true,false,'true','false',1,0,'1','0'].includes(r.client?.is_new))
    .sort((a,b) => (millis(b.last_change_date) || millis(b._createdAt) || 0) - (millis(a.last_change_date) || millis(a._createdAt) || 0));
  if (flags.length) return [true,'true',1,'1'].includes(flags[0].client.is_new);
  return Number(c.visits_count || 0) === 0;
}
async function reserve(q, f) {
  if (f.number != null) return f;
  const number = await freeNumber(q, f.salon_id);
  const next = await one(q, `UPDATE paper_folders SET number=$3, cycle_started_at=COALESCE(cycle_started_at,NOW()),updated_at=NOW()
    WHERE salon_id=$1 AND id=$2 RETURNING *`, [f.salon_id, f.id, number]);
  if (number != null) await event(q, next, 'reserved');
  return next;
}
async function release(q, f) {
  if (f.number != null) await event(q, f, 'released');
  return one(q, `UPDATE paper_folders SET number=NULL,cycle_started_at=NULL,tracked_records='{}',updated_at=NOW()
    WHERE salon_id=$1 AND id=$2 RETURNING *`, [f.salon_id, f.id]);
}
async function adopt(q, c) {
  // A local new patient's slot exists before YClients returns an id. Claim only
  // a unique draft match; ambiguous phone identities never transfer a slot.
  const existing = await state(q, c.salon_id, c.id);
  if (existing?.number != null) return existing;
  const matches = await rows(q, `SELECT f.* FROM paper_folders f JOIN journal_outbox o ON o.salon_id=f.salon_id AND o.id=f.outbox_id
    WHERE f.salon_id=$1 AND f.client_id IS NULL AND f.number IS NOT NULL AND
    (EXISTS(SELECT 1 FROM records r WHERE r.salon_id=$1 AND r.client_id=$2 AND r.yclients_record_id=o.yclients_record_id)
     OR ($3<>'' AND right(regexp_replace(o.overlay->'client'->>'phone','[^0-9]','','g'),10)=$3
       AND (SELECT count(*) FROM clients WHERE salon_id=$1 AND right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=$3)=1))`,
  [c.salon_id, c.id, phoneKey(c.phone).length === 10 ? phoneKey(c.phone) : '']);
  if (matches.length !== 1) return existing;
  const draft = matches[0];
  // Preserve a known client's archive state when claiming a draft lease.
  if (existing) {
    await q.query('UPDATE paper_folders SET number=NULL WHERE salon_id=$1 AND id=$2', [c.salon_id, draft.id]);
    const next = await one(q, `UPDATE paper_folders SET number=$3,cycle_started_at=$4,prepared=prepared OR $5,committed=committed OR $6,updated_at=NOW()
      WHERE salon_id=$1 AND id=$2 RETURNING *`, [c.salon_id, existing.id, draft.number, draft.cycle_started_at,draft.prepared,draft.committed]);
    await event(q, next, 'linked'); return next;
  }
  const next = await one(q, 'UPDATE paper_folders SET client_id=$3,updated_at=NOW() WHERE salon_id=$1 AND id=$2 RETURNING *', [c.salon_id, draft.id, c.id]);
  await event(q, next, 'linked'); return next;
}
async function reconcileInside(q, c, bookingDate = null, removed = false) {
  let f = await adopt(q, c) || await state(q, c.salon_id, c.id);
  const snap = await snapshot(q, c.salon_id, c, f);
  const today = todayMsk();
  const afterArchive = r => !f?.archived_at || millis(dateTime(r)) >= millis(f.archived_at) ||
    (millis(r._createdAt) > millis(f.archived_at) && dayKey(dateTime(r)) >= dayKey(f.archived_at));
  const trackedVisit = r => (f?.tracked_records || []).some(id=>Number(id)===Number(r.id));
  // A paid history row first imported today is not a new booking. Its local
  // created_at says when the mirror learned about it, not when it was booked.
  const upcomingRecords = snap.effective.filter(r => live(r) && dayKey(dateTime(r)) >= today && afterArchive(r)
    && (!paidVisit(r) || trackedVisit(r)));
  const upcoming = upcomingRecords.length > 0;
  const explicitlyBooked = bookingDate && dayKey(bookingDate) >= today;
  const eligible = f?.archived || f?.cycle_started_at || await primary(q, c, snap.actual);
  const starting = !f?.cycle_started_at;
  if ((upcoming || explicitlyBooked) && eligible && f?.number == null) {
    f = await reserve(q, f || await ensure(q, c.salon_id, c.id));
  }
  if (!f) return view(null);
  if (f.cycle_started_at) {
    const ids = upcomingRecords.filter(r => Number(r.id)>0 && (starting || millis(r._createdAt)>=millis(f.cycle_started_at) || millis(dateTime(r))>=millis(f.cycle_started_at))).map(r=>Number(r.id));
    const tracked=[...new Set([...(f.tracked_records || []).map(Number),...ids])];
    if (tracked.length !== (f.tracked_records || []).length) f=await one(q, 'UPDATE paper_folders SET tracked_records=$3 WHERE salon_id=$1 AND id=$2 RETURNING *',[c.salon_id,f.id,tracked]);
  }
  // Only persisted provider evidence may clear Archive, never an optimistic
  // attendance/payment overlay or a historical paid visit before this cycle.
  const boundary = Math.max(millis(f.archived_at) || 0, millis(f.cycle_started_at) || Infinity);
  const inCycle = r => afterArchive(r) && ((f.tracked_records || []).some(id=>Number(id)===Number(r.id)) || millis(dateTime(r))>=boundary);
  const completed = snap.actual.some(r => paidVisit(r) && inCycle(r));
  if (completed && f.cycle_started_at) {
    if (f.archived || !f.committed) {
      f = await one(q, `UPDATE paper_folders SET archived=FALSE,committed=TRUE,updated_at=NOW()
        WHERE salon_id=$1 AND id=$2 RETURNING *`, [c.salon_id, f.id]);
      await event(q, f, 'activated');
    }
  }
  const attendedUnpaid = snap.actual.some(r => live(r) && Number(r.attendance) === 1 && inCycle(r));
  // Do not free a lease on a transient missing webhook after a confirmed create.
  // Release requires positive cancellation/deletion evidence from this cycle.
  const cancelled = snap.effective.some(r => !live(r) && inCycle(r));
  if (f.cycle_started_at && !f.committed && !f.prepared && !upcoming && !attendedUnpaid && !explicitlyBooked && (cancelled || snap.reassigned || removed)) f = await release(q, f);
  return view(f);
}
async function reconcile(salonId, clientId, { removed = false } = {}) {
  if (!clientId) return null;
  return withTransaction(async q => { await lock(q, salonId); const c = await client(q, salonId, clientId); return c ? reconcileInside(q, c, null, removed) : null; });
}
async function reconcileRecord(salonId, recordId) {
  const r = await db.oneOrNone(`SELECT COALESCE(r.client_id,c.id) AS client_id FROM records r
    LEFT JOIN clients c ON c.salon_id=r.salon_id AND r.client_id IS NULL AND c.yclients_client_id=r.yclients_client_id
    WHERE r.salon_id=$1 AND r.id=$2`, [salonId, recordId]);
  return r?.client_id ? reconcile(salonId, r.client_id) : null;
}
async function reconcileYcClient(salonId, ycClientId) {
  const c = await db.oneOrNone('SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salonId, ycClientId]);
  return c ? reconcile(salonId, c.id) : null;
}
async function bookingCreated(salonId, ycClientId, visitDate) {
  if (!ycClientId) return null;
  return withTransaction(async q => {
    await lock(q, salonId);
    const c = await one(q, 'SELECT id,salon_id,yclients_client_id,name,phone,visits_count,last_visit_at FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salonId, ycClientId]);
    return c ? reconcileInside(q, c, visitDate) : null;
  });
}
async function reconcileOutbox(salonId, outboxId) {
  return withTransaction(async q => {
    await lock(q, salonId);
    let o = await one(q, 'SELECT * FROM journal_outbox WHERE salon_id=$1 AND id=$2', [salonId, outboxId]);
    if (o?.create_outbox_id) o = await one(q, 'SELECT * FROM journal_outbox WHERE salon_id=$1 AND id=$2', [salonId, o.create_outbox_id]);
    if (!o || o.overlay?.kind !== 'create') return null;
    const p = phoneKey(o.overlay.client?.phone);
    const matches = p.length !== 10 ? [] : await rows(q, `SELECT id,salon_id,yclients_client_id,name,phone,visits_count,last_visit_at FROM clients
      WHERE salon_id=$1 AND right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=$2 LIMIT 2`, [salonId, p]);
    if (matches.length === 1) return reconcileInside(q, matches[0], null, o.status === 'cancelled');
    if (matches.length > 1) return null; // manual identity resolution required
    let f = await one(q, `SELECT f.* FROM paper_folders f JOIN journal_outbox o ON o.salon_id=f.salon_id AND o.id=f.outbox_id
      WHERE f.salon_id=$1 AND f.client_id IS NULL AND (f.outbox_id=$2 OR
        ($3<>'' AND right(regexp_replace(o.overlay->'client'->>'phone','[^0-9]','','g'),10)=$3))
      ORDER BY f.number NULLS LAST,f.id LIMIT 1`, [salonId, o.id, p.length === 10 ? p : '']);
    const drafts = applyOverlay([], await outbox(q, salonId));
    const other = drafts.find(r => p.length === 10 && phoneKey(r.client?.phone) === p && live(r) && dayKey(dateTime(r)) >= todayMsk());
    if (o.status === 'cancelled') {
      if (f && !f.prepared && !f.committed && !other) await release(q, f);
      return null;
    }
    const effective = drafts.find(r => r.id === (o.yclients_record_id ? Number(o.yclients_record_id) : -Number(o.id)));
    if (!effective || !live(effective) || dayKey(dateTime(effective)) < todayMsk()) {
      if (f && !f.prepared && !f.committed && effective && !live(effective) && !other) await release(q, f);
      return null;
    }
    if (!f) f = await one(q, 'INSERT INTO paper_folders(salon_id,outbox_id) VALUES($1,$2) RETURNING *', [salonId, o.id]);
    return view(await reserve(q, f));
  });
}
async function get(salonId, clientId) {
  try { return view(await state(db, salonId, clientId)); }
  catch (e) { if (e.code === '42P01') return view(null); throw e; }
}
async function update(salonId, clientId, userId, patch) {
  const keys = Object.keys(patch || {});
  if (keys.length !== 1 || !['archived','prepared','number'].includes(keys[0])) fail(400, 'Укажите одно изменение папки');
  const field = keys[0], value = patch[field];
  if (field === 'number' ? !Number.isInteger(value) || value < 1 || value > CAPACITY : typeof value !== 'boolean') fail(400, 'Некорректное значение');
  if (field === 'archived' && value === false) fail(409, 'Архив снимается автоматически после выполненного и полностью оплаченного визита');
  return withTransaction(async q => {
    await lock(q, salonId);
    const c = await client(q, salonId, clientId);
    if (!c) fail(404, 'Клиент не найден');
    let f = await ensure(q, salonId, clientId);
    if (field === 'archived') {
      const snap = await snapshot(q, salonId, c, f);
      if (snap.effective.some(r => live(r) && dayKey(dateTime(r)) >= todayMsk() && Number(r.attendance) !== 1)) fail(409, 'Есть действующая запись. Сначала отмените её или дождитесь визита');
      if (f.archived && f.number == null) return view(f);
      await event(q, f, 'archived', userId);
      f = await one(q, `UPDATE paper_folders SET number=NULL,archived=TRUE,prepared=FALSE,committed=FALSE,
        archived_at=NOW(),cycle_started_at=NULL,tracked_records='{}',updated_at=NOW() WHERE salon_id=$1 AND id=$2 RETURNING *`, [salonId, f.id]);
    } else if (field === 'number') {
      if (f.archived || f.number != null) fail(409, 'Номер уже назначен или пакет находится в архиве');
      if (await one(q, 'SELECT 1 FROM paper_folders WHERE salon_id=$1 AND number=$2', [salonId, value])) fail(409, 'Номер уже занят');
      f = await one(q, `UPDATE paper_folders SET number=$3,prepared=TRUE,committed=TRUE,updated_at=NOW()
        WHERE salon_id=$1 AND id=$2 RETURNING *`, [salonId, f.id, value]);
      await event(q, f, 'registered', userId);
    } else {
      if (f.number == null) fail(409, 'Сначала должен быть выделен номер');
      if (!value && f.committed) fail(409, 'Действующий пакет освобождается только переносом в архив');
      if (f.prepared !== value) {
        f = await one(q, 'UPDATE paper_folders SET prepared=$3,updated_at=NOW() WHERE salon_id=$1 AND id=$2 RETURNING *', [salonId, f.id, value]);
        await event(q, f, value ? 'prepared' : 'unprepared', userId);
      }
      if (!value) { await reconcileInside(q, c); f = await state(q, salonId, clientId); }
    }
    return view(f);
  });
}
async function day(salonId, date) {
  if (!isCalendarDate(date)) fail(400, 'Некорректная дата');
  const stored = await db.any(`SELECT r.yclients_record_id,COALESCE(c.id,r.client_id) AS client_id,r.visit_datetime,r.raw_payload,r.status,c.name
    FROM records r LEFT JOIN clients c ON c.salon_id=r.salon_id AND
      (c.id=r.client_id OR (r.client_id IS NULL AND c.yclients_client_id=r.yclients_client_id))
    WHERE r.salon_id=$1 AND (r.visit_date=$2::date OR EXISTS(SELECT 1 FROM journal_outbox o
      WHERE o.salon_id=r.salon_id AND o.yclients_record_id=r.yclients_record_id AND o.status IN ('queued','running','failed')))`, [salonId, date]);
  const pending = await outbox(db, salonId);
  const actual = stored.map(r => ({ ...(r.raw_payload || {}), id: r.yclients_record_id, _clientId:r.client_id, _name:r.name,
    datetime:r.visit_datetime ? new Date(r.visit_datetime).toISOString() : r.raw_payload?.datetime || r.raw_payload?.date, _status:r.status }));
  const effective = applyOverlay(actual, pending).filter(r => live(r) && dayKey(new Date(dateTime(r))) === date);
  const folders = await db.any(`SELECT f.*,o.overlay->'client'->>'phone' AS pending_phone FROM paper_folders f
    LEFT JOIN journal_outbox o ON o.salon_id=f.salon_id AND o.id=f.outbox_id WHERE f.salon_id=$1`, [salonId]);
  const clients = await db.any(`SELECT id,name,phone,yclients_client_id FROM clients WHERE salon_id=$1 AND
    (id=ANY($2::integer[]) OR yclients_client_id=ANY($3::bigint[]) OR right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=ANY($4::text[]))`,
  [salonId,effective.map(r=>r._clientId).filter(Boolean),effective.map(r=>r.client?.id).filter(Boolean),effective.map(r=>phoneKey(r.client?.phone)).filter(p=>p.length===10)]);
  const items = new Map();
  for (const r of effective) {
    const candidates = clients.filter(c => belongs(r,c));
    const c = candidates.length === 1 ? candidates[0] : null;
    const f = c ? folders.find(x=>x.client_id===c.id) : folders.find(x=>x.client_id==null && x.outbox_id &&
      (Number(x.outbox_id)===Number(r._sync?.outboxId) ||
        (phoneKey(r.client?.phone).length===10 && phoneKey(x.pending_phone)===phoneKey(r.client?.phone))));
    const p = phoneKey(r.client?.phone);
    const key = c ? `c${c.id}` : p.length === 10 ? `draft-${pending.find(o => phoneKey(o.overlay?.client?.phone) === p)?.id || r.id}` : `r${r.id}`;
    const time = new Date(dateTime(r)).toLocaleTimeString('ru', {timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
    if (items.has(key)) { const item=items.get(key); item.visits++; if(time<item.time)item.time=time; continue; }
    items.set(key,{key,outboxId:f?.outbox_id ? Number(f.outbox_id) : null,clientId:c?.id ?? null,name:c?.name || r.client?.name || r._name || 'Новая запись',...view(f),time,visits:1,
      needsNumber:!f?.number,task:!f?.number ? (f?.cycle_started_at ? 'Нет свободного номера папки' : 'Папка не зарегистрирована — проверить')
        : (f.prepared || f.committed) ? 'Подготовить папку к приёму'
          : f.archived ? 'Подготовить новый договор' : 'Создать бумажный пакет'});
  }
  const occupied=folders.filter(f=>f.number!=null).length;
  return {date,capacity:CAPACITY,occupied,free:CAPACITY-occupied,items:[...items.values()].sort((a,b)=>(a.number??Infinity)-(b.number??Infinity)||a.time.localeCompare(b.time)),updatedAt:new Date().toISOString()};
}
module.exports={CAPACITY,view,live,paidVisit,phoneKey,safely,reconcile,reconcileRecord,reconcileYcClient,reconcileOutbox,bookingCreated,get,update,day};

async function updateOutbox(salonId, outboxId, userId, patch) {
  if (Object.keys(patch || {}).length !== 1 || typeof patch.prepared !== 'boolean') fail(400,'Укажите отметку создания пакета');
  return withTransaction(async q => {
    await lock(q,salonId);
    let f = await one(q,'SELECT * FROM paper_folders WHERE salon_id=$1 AND outbox_id=$2',[salonId,outboxId]);
    if (!f) fail(404,'Папка не найдена');
    if (f.client_id) fail(409,'Пациент уже зарегистрирован. Обновите список');
    if (f.number == null) fail(409,'Номер ещё не выделен');
    if (f.prepared !== patch.prepared) {
      f = await one(q,'UPDATE paper_folders SET prepared=$3,updated_at=NOW() WHERE salon_id=$1 AND id=$2 RETURNING *',[salonId,f.id,patch.prepared]);
      await event(q,f,patch.prepared?'prepared':'unprepared',userId);
    }
    return view(f);
  });
}

// Recovery after a transient hook failure / exhausted cabinet. No provider calls,
// document sends or changes to appointments. Starts only after migrations.
let timer = null, running = false;
async function sweep() {
  if (running) return;
  running = true;
  try {
    const salons = await db.any('SELECT id FROM salons WHERE is_active=TRUE');
    for (const salon of salons) {
      const candidates = await db.any(`SELECT DISTINCT c.id FROM clients c
        LEFT JOIN paper_folders f ON f.salon_id=c.salon_id AND f.client_id=c.id
        WHERE c.salon_id=$1 AND ((f.cycle_started_at IS NOT NULL AND (NOT f.committed OR f.number IS NULL)) OR
          ((f.archived OR c.last_visit_at IS NULL) AND f.number IS NULL AND EXISTS
            (SELECT 1 FROM records r WHERE r.salon_id=c.salon_id AND
             (r.client_id=c.id OR (r.client_id IS NULL AND r.yclients_client_id=c.yclients_client_id))
             AND r.visit_date >= (NOW() AT TIME ZONE 'Europe/Moscow')::date
             AND COALESCE(r.status,'') NOT IN ('deleted','cancelled','no_show')))) ORDER BY c.id`,[salon.id]);
      for (const c of candidates) await safely(()=>reconcile(salon.id,c.id));
      const drafts=await db.any(`SELECT id FROM journal_outbox WHERE salon_id=$1 AND overlay->>'kind'='create'
        AND (status IN ('queued','running','failed') OR id IN
          (SELECT outbox_id FROM paper_folders WHERE salon_id=$1 AND client_id IS NULL AND number IS NOT NULL)) ORDER BY id`,[salon.id]);
      for(const o of drafts) await safely(()=>reconcileOutbox(salon.id,o.id));
    }
  } finally { running=false; }
}
function start() {
  if (!timer) { timer=setInterval(()=>safely(sweep),60000); timer.unref(); }
}
module.exports.updateOutbox=updateOutbox;
module.exports.sweep=sweep;
module.exports.start=start;
