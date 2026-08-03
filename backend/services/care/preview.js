'use strict';
// Сухой прогон программы заботы: «кого бы зацепило, если бы программа работала
// последние N дней». Нужен потому, что зачисление ЧИСТО СОБЫТИЙНОЕ (вебхук
// YClients в момент, когда визит стал состоявшимся) — бэкфилла нет, и сразу
// после создания программы дашборд пуст: непонятно, условия кривые или просто
// подходящих визитов ещё не было.
//
// Ничего не пишет в БД и никому ничего не шлёт: тянет записи из YClients за
// период и прогоняет их через ТОТ ЖЕ evaluateRule и ТЕ ЖЕ критерии
// «визит состоялся», что и services/care/enroll.js. Расхождение превью с
// боевым отбором = баг: правки условий обязаны идти в оба места.
//
// matchVisits — чистая (без БД/HTTP), юнит-тесты в care-preview.test.js.

const { ycGet } = require('../yclients');
const { evaluateRule } = require('../notifications');
const { normalizePhoneKey } = require('../agent-gate');
const { parseVisitAt, computeScheduledAt } = require('./schedule');
const { isVisitCompleted } = require('./enroll');
const { createLogger } = require('../../logger');

const log = createLogger('CarePreview');

const PAGE = 200;
const MAX_PAGES = 25;      // 5000 записей — потолок одного превью

/** 'YYYY-MM-DD' московской даты момента (как в schedule.js). */
function mskDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
}

/**
 * Записи салона за последние `days` дней (московские даты, включая сегодня).
 * Постранично, как в services/loyalty.js: /records/{cid} отдаёт по 200.
 * Бросает при сбое YClients — вызывающий отдаёт пользователю понятную ошибку
 * (в превью fail-open не нужен: пустая выдача вместо ошибки соврала бы
 * «никто не подходит»).
 */
async function fetchRecords(salon, days, nowMs = Date.now()) {
  const cid = salon && salon.yclients_company_id;
  if (!cid) throw new Error('у салона не настроен YClients');
  const endDate = mskDate(new Date(nowMs));
  const startDate = mskDate(new Date(nowMs - days * 86400000));
  let all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = await ycGet(salon, `/records/${cid}`, {
      start_date: startDate, end_date: endDate, page, count: PAGE,
    });
    if (!Array.isArray(chunk) || !chunk.length) break;
    all = all.concat(chunk);
    if (chunk.length < PAGE) break;
  }
  log.info(`salon=${salon.id} ${startDate}→${endDate}: ${all.length} записей`);
  return { records: all, startDate, endDate };
}

/**
 * Чистый отбор: записи YClients → строки превью.
 *
 * @param {object[]} records      сырые записи /records/{cid}
 * @param {object}   conditions   care_programs.conditions
 * @param {object[]} touches      [{ id, title, delay_days, send_time }]
 * @param {Map}      catMap       serviceId(str) → categoryId(str)
 * @param {Set}      blacklisted  каноничные телефоны из ЧС
 * @param {number}   nowMs
 * @returns {{ totals: object, rows: object[] }}
 *
 * Строка получает skipReason:
 *   null           — цепочка стартовала бы;
 *   'no_phone'     — у клиента нет телефона (enroll.js такие пропускает);
 *   'blacklist'    — клиент в чёрном списке;
 *   'superseded'   — более поздний подходящий визит того же клиента перезапустил
 *                    бы программу, эта цепочка не дожила бы до конца.
 */
function matchVisits({ records = [], conditions, touches = [], catMap = new Map(),
                       blacklisted = new Set(), nowMs = Date.now() } = {}) {
  let completed = 0;
  const rows = [];

  for (const r of records) {
    if (!r || r.id == null) continue;
    if (!isVisitCompleted(r)) continue;
    completed++;

    const serviceIds = (Array.isArray(r.services) ? r.services : [])
      .map(s => s && s.id).filter(v => v != null);
    const ctx = {
      staffId: r.staff && r.staff.id != null ? r.staff.id : null,
      serviceIds,
      categoryIds: [...new Set(serviceIds.map(id => catMap.get(String(id))).filter(Boolean))],
    };
    let ok = false;
    try { ok = evaluateRule(conditions, ctx); } catch { ok = false; }
    if (!ok) continue;

    const phone = normalizePhoneKey(r.client && r.client.phone);
    const visitAt = parseVisitAt(r.date);
    rows.push({
      recordId: r.id,
      phone: phone || null,
      clientName: (r.client && r.client.name) || '',
      visitAt: visitAt ? visitAt.toISOString() : null,
      visitMs: visitAt ? visitAt.getTime() : 0,
      staffName: (r.staff && r.staff.name) || '',
      services: (Array.isArray(r.services) ? r.services : []).map(s => s && s.title).filter(Boolean),
      skipReason: !phone ? 'no_phone' : (blacklisted.has(phone) ? 'blacklist' : null),
    });
  }

  // Свежие визиты — сверху. Из нескольких подходящих визитов одного клиента
  // до конца дожила бы только цепочка от САМОГО ПОЗДНЕГО (enroll.js: новый
  // подходящий визит → supersede прежней активной цепочки той же программы).
  rows.sort((a, b) => b.visitMs - a.visitMs || Number(b.recordId) - Number(a.recordId));
  const seen = new Set();
  for (const row of rows) {
    if (row.skipReason) continue;
    if (seen.has(row.phone)) row.skipReason = 'superseded';
    else seen.add(row.phone);
  }

  // Расписание касаний — только для живых цепочек: у перекрытых и отсеянных
  // его показывать нечестно, они бы не отработали.
  for (const row of rows) {
    row.touches = row.skipReason ? [] : touches.map(t => {
      const at = computeScheduledAt(row.visitAt ? new Date(row.visitAt) : null, t.delay_days, t.send_time);
      return {
        touchId: t.id != null ? t.id : null,
        title: t.title || '',
        delayDays: t.delay_days,
        scheduledAt: at ? at.toISOString() : null,
        past: at ? at.getTime() < nowMs : false,
      };
    });
    delete row.visitMs;
  }

  const willEnroll = rows.filter(r => !r.skipReason).length;
  return {
    totals: {
      records: records.length,
      completed,
      matched: rows.length,
      willEnroll,
      clients: seen.size,
      excluded: rows.length - willEnroll,
    },
    rows,
  };
}

module.exports = { fetchRecords, matchVisits, mskDate };
