'use strict';
// Сверка revenue_operations с YClients по-дневным сравнением с /transactions:
// 1) операции, удалённые в YClients (переразбивка/исправление оплаты), чьи
//    delete-webhook'и до нас не дошли, остаются в нашей БД и завышают выручку
//    на дашбордах — их удаляем;
// 2) (с 28.10.2026) операции, чьи create-webhook'и до нас НЕ ДОШЛИ, — добавляем
//    тем же recordRevenueOperation, что и вебхук (source='reconcile'). Разбор:
//    23.10 YClients показывал оплаты 48 000 / 21 600 / 10 000 ₽ по записям
//    2056697734 / 2018785335 / 2066025014, у нас их не было (за октябрь —
//    86 800 ₽ на 5 визитах из 302): экономика теряла эквайринг этих оплат,
//    дашборды — выручку. Кэшбэк этот путь НЕ начисляет (он живёт в вебхуке).

const { db } = require('../db');
const { ycGet } = require('./yclients');
const { classifyExpense, recordRevenueOperation } = require('./revenue');
const finOps = require('./finance-ops');
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

// Все финансовые операции YClients за день (с пагинацией).
async function fetchDayOps(salon, day, rateMs) {
  const ops = [];
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
    ops.push(...rows);
    if (rows.length < 200) break;
    await sleep(rateMs);
  }
  return ops;
}

const mskDay = (date) => new Date(date).toLocaleDateString('sv', { timeZone: 'Europe/Moscow' });

// Операция YClients, которую recordRevenueOperation положил бы в таблицу: приход
// (amount > 0) по известной статье, с датой. Московская дата обязана совпасть с
// днём выгрузки: YClients режет дни по поясу компании (+04 у PERI), мы — по Москве,
// и операция 00:30 +04 у них лежит в следующем дне, а у нас — в предыдущем. Удаление
// (ниже) такую операцию уже считает зависшей в «своём» дне; добавление по «чужому»
// дню вернуло бы её обратно, и каждая ночь начиналась бы спором двух веток.
function isRecordable(t, day) {
  if (!t || !t.id || !(parseFloat(t.amount) > 0) || !t.date) return false;
  if (!classifyExpense(t.expense && t.expense.title)) return false;
  const d = new Date(t.date);
  return !Number.isNaN(d.getTime()) && mskDay(d) === day;
}

// Сверяет один салон за период [fromDay..toDay] (включительно, даты МСК).
// apply=false — только отчёт. Возвращает { checked, stale: [...], deleted, missing: [...], added }.
// День сверяется, даже если у нас за него НИ ОДНОЙ операции: ровно так выглядит день,
// все вебхуки которого потерялись.
// Два прохода: сначала по всем дням удаляем зависшие и собираем кандидатов на
// добавление, потом добавляем. Порядок важен для операции, которой в YClients
// ПЕРЕНЕСЛИ дату: update-вебхук дату у нас не меняет (ON CONFLICT DO NOTHING), и в
// старом дне она выглядит зависшей. Удалив её первым проходом, второй вернёт её под
// новой датой в ту же ночь (дев 26–27.10: депозит 671 ₽, сертификат 25 000 ₽ и товары
// 16 470 ₽ так пропадали насовсем — прежняя сверка умела только удалять).
async function reconcileSalon(salon, fromDay, toDay, { apply = false, rateMs = 300, onStale = null, onMissing = null } = {}) {
  let checked = 0, deleted = 0, added = 0;
  const stale = [], missing = [], candidates = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    const ours = await db.any(
      `SELECT id, yclients_operation_id, category, amount
       FROM revenue_operations WHERE salon_id=$1 AND operation_date=$2::date`,
      [salon.id, day]);
    checked += ours.length;

    let ycOps;
    try {
      ycOps = await fetchDayOps(salon, day, rateMs);
    } catch (e) {
      logger.warn(`salon=${salon.id} ${day}: YClients недоступен (${e.message}) — день пропущен`);
      continue;
    }
    const ycIds = new Set(ycOps.map(t => String(t.id)));
    const ourIds = new Set(ours.map(o => String(o.yclients_operation_id)));
    for (const t of ycOps) if (!ourIds.has(String(t.id)) && isRecordable(t, day)) candidates.push({ t, day });

    for (const o of ours) {
      if (ycIds.has(String(o.yclients_operation_id))) continue;
      stale.push({ ...o, day });
      if (onStale) onStale(o, day);
      if (apply) {
        await db.query(`DELETE FROM revenue_operations WHERE id=$1`, [o.id]);
        await finOps.safely('revenue-reconcile-delete', () => finOps.cancelRevenueOp(salon.id, o.yclients_operation_id));
        deleted++;
        logger.info(`salon=${salon.id} ${day}: удалена зависшая op_id=${o.yclients_operation_id} (${o.category}, ${o.amount} ₽)`);
      }
    }
    await sleep(rateMs);
  }

  // Кандидат — нет в нашем дне; добавляем, только если его нет у нас ВООБЩЕ (мог
  // лечь под другую дату). Зависшая из первого прохода «нашей» уже не считается:
  // в apply она удалена, в dry-run отчёт показывает, что будет после apply. От гонки
  // с вебхуком страхует ON CONFLICT в recordRevenueOperation.
  if (candidates.length) {
    const known = await db.any(
      `SELECT yclients_operation_id FROM revenue_operations WHERE salon_id=$1 AND yclients_operation_id = ANY($2::bigint[])`,
      [salon.id, candidates.map(c => Number(c.t.id))]);
    const knownIds = new Set(known.map(k => String(k.yclients_operation_id)));
    const staleIds = new Set(stale.map(o => String(o.yclients_operation_id)));
    for (const { t, day } of candidates) {
      const id = String(t.id);
      if (knownIds.has(id) && !staleIds.has(id)) continue;
      const moved = staleIds.has(id);
      missing.push({ day, yclients_operation_id: t.id, amount: t.amount, expense_title: t.expense && t.expense.title, record_id: t.record_id || null, moved });
      if (onMissing) onMissing(t, day, { moved });
      if (!apply) continue;
      try {
        if (await recordRevenueOperation({ status: 'create', data: t }, salon, 'reconcile')) {
          added++;
          logger.info(`salon=${salon.id} ${day}: добавлена ${moved ? 'перенесённая в YClients' : 'потерянная'} op_id=${t.id} (${t.expense && t.expense.title}, ${t.amount} ₽, запись ${t.record_id || '—'})`);
        }
      } catch (e) {
        logger.warn(`salon=${salon.id} ${day}: не удалось добавить op_id=${t.id}: ${e.message}`);
      }
    }
  }
  return { checked, stale, deleted, missing, added };
}

// Для cron: все активные салоны, последние N дней, с удалением.
async function reconcileRecentAllSalons(days = 7) {
  const salons = await db.any(
    `SELECT * FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`);
  const from = mskDateDaysAgo(days);
  const to = mskDateDaysAgo(0);
  let totalStale = 0, totalDeleted = 0, totalMissing = 0, totalAdded = 0;
  for (const salon of salons) {
    try {
      const r = await reconcileSalon(salon, from, to, { apply: true });
      totalStale += r.stale.length;
      totalDeleted += r.deleted;
      totalMissing += r.missing.length;
      totalAdded += r.added;
    } catch (e) {
      logger.error(`salon=${salon.id}: ${e.message}`);
    }
  }
  return { from, to, stale: totalStale, deleted: totalDeleted, missing: totalMissing, added: totalAdded };
}

module.exports = { reconcileSalon, reconcileRecentAllSalons, mskDateDaysAgo, addDays };
