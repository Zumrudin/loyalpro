'use strict';
// Разовый догон по базе: «кому ушло бы напоминание, если бы правило работало
// последние N дней». Чистые функции — ни БД, ни сети (сеть в routes/reminders.js).
//
// Нужен потому, что планирование ЧИСТО СОБЫТИЙНОЕ: у только что созданного
// правила очередь пуста, и без превью не отличить «условия кривые» от
// «подходящих визитов ещё не было».
//
// Отбор гоняет ТОТ ЖЕ evaluateRule и тот же критерий «визит состоялся», что и
// боевое планирование (services/reminders/enroll.js). Расхождение — это баг:
// правки условий обязаны идти в оба места.
//
// Будущие записи берутся из ТОЙ ЖЕ сводной выдачи /records (вызывающий тянет
// диапазон, захватывающий будущее) — по отдельному запросу на каждого клиента
// догон по базе в сотни человек стоил бы сотни обращений к YClients.

const { evaluateRule } = require('../notifications');
const { normalizePhoneKey } = require('../agent-gate');
const { parseVisitAt, computeScheduledAt } = require('../care/schedule');
const { isVisitCompleted } = require('../care/enroll');
const { recordContext } = require('./eligibility');

/**
 * @returns {{ totals: object, rows: object[] }}
 * skipReason: null | 'no_phone' | 'blacklist' | 'muted' | 'already_queued'
 *             | 'future_booking' | 'superseded'
 */
function matchBackfillVisits({ records = [], conditions, catMap = new Map(),
                               blacklisted = new Set(), mutedPhones = new Set(),
                               queuedRecordIds = new Set(), nowMs = Date.now() } = {}) {
  const matches = (r) => {
    try { return evaluateRule(conditions, recordContext(r, catMap)); } catch { return false; }
  };

  // Телефоны, у которых есть БУДУЩАЯ запись под условия правила.
  const busy = new Set();
  for (const r of records) {
    if (!r || r.deleted) continue;
    if (Number(r.attendance) === -1) continue;
    const at = parseVisitAt(r.date);
    if (!at || at.getTime() < nowMs) continue;
    if (!matches(r)) continue;
    const p = normalizePhoneKey(r.client && r.client.phone);
    if (p) busy.add(p);
  }

  const rows = [];
  let completed = 0;
  for (const r of records) {
    if (!r || r.id == null) continue;
    if (!isVisitCompleted(r)) continue;
    completed++;
    if (!matches(r)) continue;

    const phone = normalizePhoneKey(r.client && r.client.phone);
    const visitAt = parseVisitAt(r.date);
    let skipReason = null;
    if (!phone) skipReason = 'no_phone';
    else if (blacklisted.has(phone)) skipReason = 'blacklist';
    else if (mutedPhones.has(phone)) skipReason = 'muted';
    else if (queuedRecordIds.has(String(r.id))) skipReason = 'already_queued';
    else if (busy.has(phone)) skipReason = 'future_booking';

    rows.push({
      recordId: r.id,
      phone: phone || null,
      ycClientId: (r.client && r.client.id) || null,
      clientName: (r.client && r.client.name) || '',
      visitAt: visitAt ? visitAt.toISOString() : null,
      visitMs: visitAt ? visitAt.getTime() : 0,
      staffName: (r.staff && r.staff.name) || '',
      services: (Array.isArray(r.services) ? r.services : [])
        .map(s => ({ id: s && s.id, title: s && s.title })).filter(s => s.title),
      skipReason,
    });
  }

  // Свежие визиты сверху; из нескольких визитов клиента напоминание ушло бы
  // только от САМОГО ПОЗДНЕГО (боевое планирование supersede'ит прежние).
  rows.sort((a, b) => b.visitMs - a.visitMs || Number(b.recordId) - Number(a.recordId));
  const seen = new Set();
  for (const row of rows) {
    if (row.skipReason) continue;
    if (seen.has(row.phone)) row.skipReason = 'superseded';
    else seen.add(row.phone);
  }
  for (const row of rows) delete row.visitMs;

  const willSend = rows.filter(r => !r.skipReason).length;
  return {
    totals: { records: records.length, completed, matched: rows.length, willSend,
              clients: seen.size, excluded: rows.length - willSend },
    rows,
  };
}

/**
 * Раскладка по ближайшим дням с капом: веерная рассылка сотне клиентов в одну
 * минуту исключена по построению. Старт — сегодня в send_time, а если это
 * время уже прошло, то завтра: строка в прошлом ушла бы немедленно, минуя кап.
 */
function spreadOverDays(rows, { maxPerDay = 30, sendTime = '11:00', nowMs = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const cap = Math.max(1, Math.floor(Number(maxPerDay) || 1));
  const now = new Date(nowMs);
  const today = computeScheduledAt(now, 0, sendTime);
  const startOffset = today && today.getTime() > nowMs ? 0 : 1;

  return list.map((row, i) => ({
    ...row,
    scheduledAt: computeScheduledAt(now, startOffset + Math.floor(i / cap), sendTime),
  }));
}

module.exports = { matchBackfillVisits, spreadOverDays };
