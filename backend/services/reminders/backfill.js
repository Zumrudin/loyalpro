'use strict';
// Разовый догон по базе: «кому ушло бы напоминание, если бы правило работало
// последние N дней». Чистые функции — ни БД, ни сети (сеть в routes/reminders.js).
//
// Нужен потому, что планирование ЧИСТО СОБЫТИЙНОЕ: у только что созданного
// правила очередь пуста, и без превью не отличить «условия кривые» от
// «подходящих визитов ещё не было».
//
// Отбор гоняет ТОТ ЖЕ evaluateRule и ТОТ ЖЕ предикат «визит состоялся»
// (visitReallyHappened из ./eligibility), что и боевое планирование
// (services/reminders/enroll.js) — предикат экспортируется ОДИН на оба
// модуля именно затем, чтобы расхождение было невозможно молча.
//
// Будущие записи берутся из ТОЙ ЖЕ сводной выдачи /records (вызывающий тянет
// диапазон, захватывающий будущее) — по отдельному запросу на каждого клиента
// догон по базе в сотни человек стоил бы сотни обращений к YClients.

const { evaluateRule } = require('../notifications');
const { normalizePhoneKey } = require('../agent-gate');
const { parseVisitAt, computeScheduledAt } = require('../care/schedule');
const { recordContext, visitReallyHappened } = require('./eligibility');

/**
 * @returns {{ totals: object, rows: object[] }}
 * skipReason: null | 'no_phone' | 'blacklist' | 'muted' | 'already_queued'
 *             | 'future_booking' | 'superseded'
 */
function matchBackfillVisits({ records = [], conditions, catMap = new Map(),
                               blacklisted = new Set(), mutedPhones = new Set(),
                               queuedRecordIds = new Set(), queuedPhones = new Set(),
                               nowMs = Date.now() } = {}) {
  const matches = (r) => {
    try { return evaluateRule(conditions, recordContext(r, catMap)); } catch { return false; }
  };

  // Телефоны, у которых есть БУДУЩАЯ запись под условия правила. Это ДРУГОЙ
  // вопрос, чем «визит состоялся» ниже: тут «жива ли будущая бронь», а не
  // «был ли прошлый визит» — visitReallyHappened() тут не подходит по
  // смыслу (он для СОСТОЯВШИХСЯ визитов, у будущей записи attendance/paid_full
  // ещё не проставлены). Отменённую/удалённую будущую запись считать «клиент
  // уже записан» нельзя — отсюда те же признаки (r.deleted, attendance=-1),
  // но своей отдельной проверкой, не дублирующей ниже: там она отсеивает
  // визиты ИЗ ВЫБОРКИ, здесь — записи ИЗ МНОЖЕСТВА «занятых» телефонов.
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
    // Голого isVisitCompleted() мало: предоплаченная неявка (attendance=-1
    // при paid_full=1) и удалённая запись (deleted=true при живом attendance)
    // прошли бы его наивно. visitReallyHappened — ОБЩИЙ предикат с боевым
    // планировщиком (services/reminders/enroll.js), чтобы догон по базе не
    // мог разъехаться с ним молча.
    if (!visitReallyHappened(r)) continue;
    completed++;
    if (!matches(r)) continue;

    const phone = normalizePhoneKey(r.client && r.client.phone);
    const visitAt = parseVisitAt(r.date);
    let skipReason = null;
    if (!phone) skipReason = 'no_phone';
    else if (blacklisted.has(phone)) skipReason = 'blacklist';
    else if (mutedPhones.has(phone)) skipReason = 'muted';
    // Две проверки одного смысла «этот клиент уже ждёт напоминание»: по ЗАПИСИ
    // (эта же строка уже стоит в очереди) и по ТЕЛЕФОНУ (живая строка очереди
    // от визита, которого в окне догона может не быть вовсе — например
    // поставленная вебхуком). Без второй клиент получил бы вторую строку от
    // другого визита, и напоминание ушло бы ему дважды.
    else if (queuedRecordIds.has(String(r.id)) || queuedPhones.has(phone)) skipReason = 'already_queued';
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
  // только от САМОГО ПОЗДНЕГО (боевое планирование supersede'ит прежние). Это
  // сортировка ТОЛЬКО ради дедупликации — очерёдность ОТПРАВКИ (кто первым
  // получит напоминание в многодневном догоне) задаёт отдельная сортировка
  // в planBackfillSchedule, и с этой она не совпадает (там наоборот — самый
  // давний визит первым).
  rows.sort((a, b) => b.visitMs - a.visitMs || Number(b.recordId) - Number(a.recordId));
  // Телефон занимает САМЫЙ СВЕЖИЙ визит клиента — независимо от того, уйдёт ли
  // по нему напоминание. Пропускать занятие телефона для строк со skipReason
  // (как было до 09.08.2026) нельзя: skipReason бывает РЕКОРД-уровневым
  // (already_queued — про конкретную запись), и тогда следующий, БОЛЕЕ СТАРЫЙ
  // визит того же человека проезжал в очередь вторым напоминанием. Вскрылось
  // на подготовке широкого догона поверх уже поставленных 131 строки.
  const claimed = new Set();
  for (const row of rows) {
    if (!row.phone) continue;
    if (claimed.has(row.phone)) { if (!row.skipReason) row.skipReason = 'superseded'; continue; }
    claimed.add(row.phone);
  }
  for (const row of rows) delete row.visitMs;

  const sendable = rows.filter(r => !r.skipReason);
  return {
    totals: { records: records.length, completed, matched: rows.length,
              willSend: sendable.length,
              // Именно те, КОМУ УЙДЁТ (не все занявшие телефон): на экране это
              // число читается как «столько людей получит сообщение».
              clients: new Set(sendable.map(r => r.phone)).size,
              excluded: rows.length - sendable.length },
    rows,
  };
}

/** ISO-строка visitAt → мс, либо null (нет даты / не распарсилась). */
function visitMsOf(row) {
  const ms = Date.parse(row && row.visitAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * План отправок догона.
 *
 * Естественная дата строки = дата визита + delay_days в send_time, и считает
 * её ТА ЖЕ computeScheduledAt, что и боевой событийный планировщик
 * (services/reminders/enroll.js) — вторая копия правила означала бы, что
 * догон и боевой путь молча разъедутся, а догон ровно этим и обещает быть:
 * «что было бы, если бы правило работало».
 *
 * Две корзины:
 *  - естественная дата ЕЩЁ ВПЕРЕДИ (визит моложе задержки) — строка встаёт на
 *    неё, кап НЕ применяется: всплеска тут нет по построению, на каждый день
 *    падает столько строк, сколько в тот день было визитов;
 *  - естественная дата УЖЕ ПРОШЛА (просрочен) — догоняющая пачка: сортировка
 *    по дате визита ПО ВОЗРАСТАНИЮ (решение владельца салона: первым получает
 *    тот, кто не был дольше всех — он самый просроченный по смыслу правила),
 *    раскладка по ближайшим дням пачками по maxPerDay, старт сегодня, если
 *    send_time ещё не прошло, иначе завтра (строка в прошлом ушла бы
 *    немедленно, минуя кап).
 *
 * Строка без разбираемой даты визита попадает в догоняющую пачку: своей даты
 * у неё нет, а терять её молча нельзя. ОГОВОРКА: тут план и боевой путь
 * расходятся НАМЕРЕННО — enroll.js (строка ~135) при неразбираемой дате визита
 * зовёт computeScheduledAt(visitAt || new Date(), …), то есть считает «сейчас
 * + delay_days», а не «пачка следом за просроченными».
 *
 * @returns {object[]} те же строки + { scheduledAt: Date|null, overdue: boolean }.
 *   Порядок массива НЕ гарантирует возрастания scheduledAt: это [...caught,
 *   ...future], а future наследует порядок matchBackfillVisits («свежие визиты
 *   сверху») — вызывающий не вправе брать planned[planned.length - 1] как
 *   самую позднюю отправку.
 */
function planBackfillSchedule(rows, { delayDays = 0, sendTime = '11:00',
                                      maxPerDay = 30, nowMs = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const cap = Math.max(1, Math.floor(Number(maxPerDay) || 1));
  const now = new Date(nowMs);

  const future = [];
  const overdue = [];
  for (const row of list) {
    const natural = computeScheduledAt(row && row.visitAt, delayDays, sendTime);
    if (natural && natural.getTime() > nowMs) future.push({ ...row, scheduledAt: natural, overdue: false });
    else overdue.push(row);
  }

  // Устойчивая и безопасная сортировка: строки без даты не бросают и не
  // переставляются относительно друг друга (Array.prototype.sort в V8
  // стабильна с ES2019).
  overdue.sort((a, b) => {
    const ma = visitMsOf(a);
    const mb = visitMsOf(b);
    if (ma == null && mb == null) return 0;
    if (ma == null) return 1;
    if (mb == null) return -1;
    return ma - mb;
  });

  const today = computeScheduledAt(now, 0, sendTime);
  const startOffset = today && today.getTime() > nowMs ? 0 : 1;
  const caught = overdue.map((row, i) => ({
    ...row,
    scheduledAt: computeScheduledAt(now, startOffset + Math.floor(i / cap), sendTime),
    overdue: true,
  }));

  return [...caught, ...future];
}

module.exports = { matchBackfillVisits, planBackfillSchedule };
