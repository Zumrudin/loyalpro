'use strict';
// Живые записи клиента от даты якоря: retention-проверке нужны состоявшиеся
// визиты ПОСЛЕ якоря, care-промпту — будущие записи. Один запрос YClients
// обслуживает обоих.

const { db } = require('../../db');
const identity = require('../agent/identity');
const { ycGetClientRecords } = require('../yclients-records');
const { evaluateRule } = require('../notifications');
const { parseVisitAt } = require('./schedule');

function moscowDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(ms));
}

/**
 * Чистая: делит записи на состоявшиеся-после-якоря и будущие.
 * Дата парсится через parseVisitAt (якорь +03:00, без опоры на TZ процесса) —
 * Date.parse() на «голой» строке YClients ('2026-08-20 14:00:00', без зоны)
 * взял бы TZ процесса; в не-московской TZ якорный визит перестал бы совпадать
 * с anchorMs и ложно засчитался бы как повторный (hasMatchingRepeatVisit=true
 * на самом якоре → программа молча завершается как «цель достигнута»).
 */
function splitRecords(recs, anchorMs, nowMs) {
  const completedAfter = [];
  const future = [];
  for (const r of (recs || [])) {
    if (r.deleted) continue;
    const d = parseVisitAt(r.datetime || r.date);
    if (!d) continue;
    const t = d.getTime();
    const att = Number(r.attendance);
    if (att === 1 && t > anchorMs) completedAfter.push(r);
    // att===0 (ожидание отметки) и att===2 (подтверждено, но исход визита ещё
    // не проставлен салоном) в прошлом сознательно не попадают никуда: не
    // completedAfter (нет подтверждения, что визит состоялся) и не future
    // (дата уже прошла) — засчитать их как состоявшиеся значило бы ложно
    // завершать программу по визитам, о которых YClients ничего не сказал.
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

/**
 * Живая загрузка. THROWS при сбое YClients (ycGetClientRecords не оборачивается
 * в try/catch здесь) — вызывающий обязан ловить и решать сам (см. Task 9: fail-open,
 * warn + слать касание без retention-проверки). Пустые списки возвращаются только
 * когда клиент не резолвится в YClients (нет client_id) или салон не подключён
 * (нет yclients_company_id) — это не сбой, а отсутствие данных.
 */
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
