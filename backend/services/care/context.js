'use strict';
// Живые записи клиента от даты якоря: retention-проверке нужны состоявшиеся
// визиты ПОСЛЕ якоря, care-промпту — будущие записи. Один запрос YClients
// обслуживает обоих.

const { db } = require('../../db');
const identity = require('../agent/identity');
const { ycGetClientRecords } = require('../yclients-records');
const { evaluateRule } = require('../notifications');

function moscowDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(ms));
}

/** Чистая: делит записи на состоявшиеся-после-якоря и будущие. */
function splitRecords(recs, anchorMs, nowMs) {
  const completedAfter = [];
  const future = [];
  for (const r of (recs || [])) {
    if (r.deleted) continue;
    const t = Date.parse(r.datetime || r.date || '');
    if (!Number.isFinite(t)) continue;
    const att = Number(r.attendance);
    if (att === 1 && t > anchorMs) completedAfter.push(r);
    if (att !== -1 && t >= nowMs) future.push(r);
  }
  return { completedAfter, future };
}

/** Чистая: есть ли среди состоявшихся визит, попадающий под условия программы. */
function hasMatchingRepeatVisit(completedAfter, conditions, catMap) {
  return (completedAfter || []).some(r => {
    const serviceIds = (Array.isArray(r.services) ? r.services : [])
      .map(s => s && s.id).filter(v => v != null);
    const ctx = {
      staffId: r.staff_id || (r.staff && r.staff.id) || null,
      serviceIds,
      categoryIds: [...new Set(serviceIds.map(id => (catMap || new Map()).get(String(id))).filter(Boolean))],
    };
    try { return evaluateRule(conditions, ctx); } catch { return false; }
  });
}

/** Живая загрузка: пустые списки при недоступности YClients (воркер решает, что делать). */
async function loadClientRecords(salonId, phone, anchorMs, nowMs) {
  const ycClientId = await identity.resolveYclientsClientId(salonId, phone);
  if (!ycClientId) return { completedAfter: [], future: [] };
  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id = $1`, [salonId]);
  if (!salon.yclients_company_id) return { completedAfter: [], future: [] };
  const recs = await ycGetClientRecords(salon, ycClientId, { startDate: moscowDate(anchorMs) });
  return splitRecords(recs, anchorMs, nowMs);
}

module.exports = { splitRecords, hasMatchingRepeatVisit, loadClientRecords };
