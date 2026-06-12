'use strict';
// Сверка revenue_operations с YClients: операции, удалённые в YClients
// (переразбивка/исправление оплаты), чьи delete-webhook'и до нас не дошли,
// остаются в нашей БД и завышают выручку на дашбордах. Здесь находим их
// по-дневным сравнением с /transactions и удаляем.

const { db } = require('../db');
const { ycGet } = require('./yclients');
const { createLogger } = require('../logger');

const logger = createLogger('RevenueReconcile');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Московская дата «сегодня минус N дней» (operation_date хранится по МСК).
function mskDateDaysAgo(days) {
  const now = new Date(new Date().toLocaleString('sv', { timeZone: 'Europe/Moscow' }).slice(0, 10) + 'T00:00:00Z');
  now.setUTCDate(now.getUTCDate() - days);
  return now.toISOString().slice(0, 10);
}

// Все id финансовых операций YClients за день (с пагинацией).
async function fetchDayOpIds(salon, day, rateMs) {
  const ids = new Set();
  for (let page = 1; ; page++) {
    let rows;
    for (let attempt = 1; ; attempt++) {
      try {
        rows = await ycGet(salon, `/transactions/${salon.yclients_company_id}`, {
          start_date: day, end_date: day, page, count: 200,
        });
        break;
      } catch (e) {
        if (e.response?.status === 429 && attempt <= 3) { await sleep(5000); continue; }
        throw e;
      }
    }
    if (!rows || rows.length === 0) break;
    for (const t of rows) ids.add(String(t.id));
    if (rows.length < 200) break;
    await sleep(rateMs);
  }
  return ids;
}

// Сверяет один салон за период [fromDay..toDay] (включительно, даты МСК).
// apply=false — только отчёт. Возвращает { checked, stale: [...], deleted }.
async function reconcileSalon(salon, fromDay, toDay, { apply = false, rateMs = 300, onStale = null } = {}) {
  let checked = 0, deleted = 0;
  const stale = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    const ours = await db.any(
      `SELECT id, yclients_operation_id, category, amount
       FROM revenue_operations WHERE salon_id=$1 AND operation_date=$2::date`,
      [salon.id, day]);
    if (!ours.length) continue;
    checked += ours.length;

    let ycIds;
    try {
      ycIds = await fetchDayOpIds(salon, day, rateMs);
    } catch (e) {
      logger.warn(`salon=${salon.id} ${day}: YClients недоступен (${e.message}) — день пропущен`);
      continue;
    }

    for (const o of ours) {
      if (ycIds.has(String(o.yclients_operation_id))) continue;
      stale.push({ ...o, day });
      if (onStale) onStale(o, day);
      if (apply) {
        await db.query(`DELETE FROM revenue_operations WHERE id=$1`, [o.id]);
        deleted++;
        logger.info(`salon=${salon.id} ${day}: удалена зависшая op_id=${o.yclients_operation_id} (${o.category}, ${o.amount} ₽)`);
      }
    }
    await sleep(rateMs);
  }
  return { checked, stale, deleted };
}

// Для cron: все активные салоны, последние N дней, с удалением.
async function reconcileRecentAllSalons(days = 7) {
  const salons = await db.any(
    `SELECT * FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`);
  const from = mskDateDaysAgo(days);
  const to = mskDateDaysAgo(0);
  let totalStale = 0, totalDeleted = 0;
  for (const salon of salons) {
    try {
      const r = await reconcileSalon(salon, from, to, { apply: true });
      totalStale += r.stale.length;
      totalDeleted += r.deleted;
    } catch (e) {
      logger.error(`salon=${salon.id}: ${e.message}`);
    }
  }
  return { from, to, stale: totalStale, deleted: totalDeleted };
}

module.exports = { reconcileSalon, reconcileRecentAllSalons, mskDateDaysAgo, addDays };
