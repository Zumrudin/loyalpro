'use strict';
// Explicit, one-way reconciliation. Never called by imports, cron or startup.
const { createHash, randomUUID } = require('crypto');
const { db } = require('../db');
const yc = require('./journal/yclients');
const catalog = require('./service-catalog');
const { fail, positiveId } = require('./journal/model');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byId = (a, b) => Number(a.id) - Number(b.id);
const number = value => value == null ? null : Number(value);
function invalid() { fail('YClients вернул неполный или некорректный каталог. Перенос не выполнен.', 502); }
function externalId(value) {
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) invalid();
  return Number(value);
}
function pricePair(min, max) {
  if (min == null && max == null) return { priceMin: null, priceMax: null };
  // Actual management API encodes fixed prices as max=0 or max=null.
  // The existing importer already clamps max=0 to min; preserve that contract.
  if (min != null && (max == null || (Number(max) === 0 && Number(min) > 0))) max = min;
  if ([min, max].some(v => v == null || !['number', 'string'].includes(typeof v) || String(v).trim() === '' || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 1e9 || Math.abs(Number(v) * 100 - Math.round(Number(v) * 100)) > 1e-5) || Number(max) < Number(min)) invalid();
  return { priceMin: Number(min), priceMax: Number(max) };
}
function minutes(value, optional = false) {
  if (value == null && optional) return null;
  if (!['number', 'string'].includes(typeof value)) invalid();
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400 || seconds % 60 !== 0) invalid();
  return seconds / 60;
}
// Both management endpoints return complete arrays and ignore page/count.
// Verified read-only against the connected company: page 1 and 2 each returned
// the same 272 services. Do not truncate these responses or treat page 2 as new.
async function readCatalog(salon, path) {
  const rows = await yc.list(salon, path);
  if (!Array.isArray(rows)) invalid();
  const seen = new Set();
  for (const row of rows) {
    const id = externalId(row?.id);
    if (seen.has(id) || (row.company_id != null && String(row.company_id) !== String(salon.yclients_company_id))) invalid();
    seen.add(id);
  }
  return rows;
}
async function fetchSource(salon) {
  let services, staff;
  try {
    [services, staff] = await Promise.all([
      readCatalog(salon, `/company/${salon.yclients_company_id}/services/`),
      readCatalog(salon, `/staff/${salon.yclients_company_id}`),
    ]);
  } catch (_) { invalid(); }
  if (!services.length || !staff.length) invalid();
  return { services, staff };
}
async function readState(c, salonId) {
  const salon = (await c.query('SELECT id,yclients_company_id FROM salons WHERE id=$1 FOR SHARE', [salonId])).rows[0];
  if (!salon?.yclients_company_id) fail('YClients не подключён.', 409);
  const services = (await c.query('SELECT * FROM service_catalog WHERE salon_id=$1 ORDER BY id FOR UPDATE', [salonId])).rows;
  const staff = (await c.query('SELECT id,yclients_staff_id,is_active FROM staff_members WHERE salon_id=$1 ORDER BY id FOR SHARE', [salonId])).rows;
  const assignments = (await c.query('SELECT service_id,staff_member_id,price_min,price_max,duration FROM service_staff_assignments WHERE salon_id=$1 ORDER BY service_id,staff_member_id', [salonId])).rows;
  return { companyId: String(salon.yclients_company_id), services, staff, assignments };
}
function fingerprint(state) {
  return hash({ companyId: state.companyId,
    services: [...state.services].sort(byId).map(s => ({ id: Number(s.id), version: Number(s.version), company: s.yclients_company_id == null ? null : String(s.yclients_company_id), external: number(s.yclients_id), active: s.active, min: number(s.price_min), max: number(s.price_max), duration: Number(s.duration), initialized: s.assignments_initialized, staff: s.staff })),
    staff: [...state.staff].sort(byId).map(s => [Number(s.id), number(s.yclients_staff_id), s.is_active]),
    assignments: [...state.assignments].sort((a, b) => Number(a.service_id) - Number(b.service_id) || Number(a.staff_member_id) - Number(b.staff_member_id)).map(a => [Number(a.service_id), Number(a.staff_member_id), number(a.price_min), number(a.price_max), number(a.duration)]),
  });
}
function beforeService(service, assignments) {
  return { priceMin: number(service.price_min), priceMax: number(service.price_max), duration: Number(service.duration),
    assignmentsInitialized: Boolean(service.assignments_initialized), staff: service.staff,
    assignments: assignments.filter(a => Number(a.service_id) === Number(service.id)).map(a => ({ staffMemberId: Number(a.staff_member_id), priceMin: number(a.price_min), priceMax: number(a.price_max), duration: number(a.duration) })),
  };
}
function buildSnapshot(state, source) {
  const exceptions = [], targets = [], seen = new Set();
  const sourceStaff = new Map();
  for (const employee of source.staff) {
    const id = externalId(employee?.id);
    if (sourceStaff.has(id)) invalid();
    sourceStaff.set(id, employee);
  }
  const localStaff = new Map();
  for (const employee of state.staff) {
    const id = Number(employee.yclients_staff_id);
    if (localStaff.has(id)) invalid();
    localStaff.set(id, employee);
  }
  const localServices = new Map(state.services.filter(s => String(s.yclients_company_id) === state.companyId && s.yclients_id != null).map(s => [Number(s.yclients_id), s]));
  for (const service of source.services) {
    const id = externalId(service?.id);
    if (seen.has(id) || (service.company_id != null && String(service.company_id) !== state.companyId)) invalid();
    seen.add(id);
    const local = localServices.get(id);
    if (!local) { exceptions.push({ code: 'service_not_imported', yclientsId: id, blocking: true }); continue; }
    if (service.deleted || service.is_deleted || service.archive || !local.active) {
      exceptions.push({ code: 'inactive_service', serviceId: Number(local.id), yclientsId: id, blocking: false }); continue;
    }
    if (!Array.isArray(service.staff)) invalid();
    try {
    // Some actual management services have zero base AND individual duration.
    // They cannot be booked locally; preserve them and report the exception,
    // rather than invent a duration or discard their existing assignments.
    if (Number(service.duration) === 0 && service.staff.every(a => a && Number(a.seance_length) === 0)) {
      exceptions.push({ code: 'zero_duration_service', serviceId: Number(local.id), yclientsId: id, blocking: false }); continue;
    }
    const target = { ...pricePair(service.price_min, service.price_max), duration: minutes(service.duration), assignments: [] };
    const seenStaff = new Set();
    let unresolvedAssignment = false, removedInactiveAssignments = 0;
    for (const assignment of service.staff) {
      if (!assignment || typeof assignment !== 'object') invalid();
      const staffId = externalId(assignment.id);
      if (seenStaff.has(staffId)) invalid();
      seenStaff.add(staffId);
      const employee = localStaff.get(staffId), upstream = sourceStaff.get(staffId);
      if (!employee || !upstream || !employee.is_active || upstream.fired || upstream.deleted || upstream.is_deleted) {
        const unknown = !employee || !upstream;
        exceptions.push({ code: unknown ? 'unknown_staff' : 'inactive_staff_removed', serviceId: Number(local.id), yclientsStaffId: staffId, blocking: unknown });
        if (unknown) unresolvedAssignment = true;
        else removedInactiveAssignments++;
        continue;
      }
      if (assignment.price != null && (typeof assignment.price !== 'object' || Array.isArray(assignment.price))) invalid();
      // Explicit source values remain explicit even when equal to the base.
      target.assignments.push({ staffMemberId: Number(employee.id), ...pricePair(assignment.price?.min, assignment.price?.max), duration: minutes(assignment.seance_length, true) });
    }
    if (unresolvedAssignment) continue; // Quarantine the WHOLE service; never apply a truncated staff list.
    target.assignments.sort((a, b) => a.staffMemberId - b.staffMemberId);
    targets.push({ serviceId: Number(local.id), removedInactiveAssignments, version: Number(local.version), yclientsId: id, before: beforeService(local, state.assignments), target });
    } catch (error) {
      if (error.status !== 502) throw error;
      exceptions.push({ code: 'invalid_service_parameters', serviceId: Number(local.id), yclientsId: id, blocking: false });
    }
  }
  for (const service of localServices.values()) if (service.active && !seen.has(Number(service.yclients_id))) exceptions.push({ code: 'service_missing_from_source', serviceId: Number(service.id), blocking: true });
  targets.sort((a, b) => a.serviceId - b.serviceId);
  return { schemaVersion: 1, companyId: state.companyId, capturedAt: new Date().toISOString(), fingerprint: fingerprint(state),
    sourceFingerprint: hash(source), sourceCounts: { services: source.services.length, staff: source.staff.length,
      normalizedBasePrices: source.services.filter(s => s.price_min != null && (s.price_max == null || (Number(s.price_max) === 0 && Number(s.price_min) > 0))).length,
      normalizedStaffPrices: source.services.flatMap(s => Array.isArray(s.staff) ? s.staff : []).filter(a => a?.price?.min != null && (a.price.max == null || (Number(a.price.max) === 0 && Number(a.price.min) > 0))).length,
    }, targets, exceptions,
    removedInactiveAssignments: targets.reduce((sum, target) => sum + target.removedInactiveAssignments, 0),
    skippedServices: new Set(exceptions.filter(e => e.serviceId != null && !targets.some(t => t.serviceId === e.serviceId)).map(e => e.serviceId)).size,
    canApply: exceptions.every(e => !e.blocking) && targets.length > 0 };
}
async function preview(salonId) {
  positiveId(salonId);
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon?.yclients_company_id) fail('YClients не подключён.', 409);
  const source = await fetchSource(salon);
  return catalog.transaction(salonId, async c => {
    const state = await readState(c, salonId);
    if (state.companyId !== String(salon.yclients_company_id)) fail('Подключение YClients изменилось. Повторите сверку.', 409);
    const snapshot = buildSnapshot(state, source), runId = randomUUID();
    await c.query("INSERT INTO service_catalog_sync_runs(id,salon_id,company_id,status,snapshot) VALUES($1,$2,$3,'preview',$4)", [runId, salonId, state.companyId, JSON.stringify(snapshot)]);
    return { runId, status: 'preview', ...snapshot };
  });
}
async function apply(salonId, runId) {
  positiveId(salonId);
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) fail('Некорректный ID сверки.');
  return catalog.transaction(salonId, async c => {
    const run = (await c.query('SELECT * FROM service_catalog_sync_runs WHERE salon_id=$1 AND id=$2 FOR UPDATE', [salonId, runId])).rows[0];
    if (!run) fail('Сверка не найдена.', 404);
    if (run.status === 'applied') return { runId, status: 'applied', alreadyApplied: true, updatedServices: 0 };
    const snapshot = run.snapshot;
    if (run.status !== 'preview' || snapshot?.schemaVersion !== 1 || !snapshot.canApply || snapshot.exceptions.some(e => e.blocking)) fail('Сначала устраните исключения и повторите сверку.', 409);
    const capturedAt = Date.parse(snapshot.capturedAt), age = Date.now() - capturedAt;
    if (!Number.isFinite(capturedAt) || age < 0 || age > 30 * 60 * 1000) fail('Сверка устарела. Создайте новую сверку.', 409);
    const state = await readState(c, salonId);
    if (state.companyId !== String(run.company_id) || fingerprint(state) !== snapshot.fingerprint) fail('Каталог или сотрудники изменились. Создайте новую сверку.', 409);
    for (const entry of snapshot.targets) {
      const target = entry.target;
      const result = await c.query(`UPDATE service_catalog SET price_min=$3,price_max=$4,duration=$5,version=version+1,updated_at=NOW()
        WHERE salon_id=$1 AND id=$2 AND version=$6 RETURNING id`, [salonId, entry.serviceId, target.priceMin, target.priceMax, target.duration, entry.version]);
      if (result.rows.length !== 1) fail('Каталог изменился. Создайте новую сверку.', 409);
      await catalog.replaceAssignments(c, salonId, entry.serviceId, target.assignments, { source: 'yclients' });
    }
    await c.query("UPDATE service_catalog_sync_runs SET status='applied',applied_at=NOW() WHERE salon_id=$1 AND id=$2", [salonId, runId]);
    return { runId, status: 'applied', alreadyApplied: false, updatedServices: snapshot.targets.length, skippedServices: snapshot.skippedServices, removedInactiveAssignments: snapshot.removedInactiveAssignments };
  });
}
module.exports = { preview, apply, buildSnapshot, fingerprint, fetchSource };
