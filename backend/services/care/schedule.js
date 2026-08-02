'use strict';
// Планирование care-касаний. Всё время — московское. Модуль не полагается на
// TZ процесса: МСК фиксируется смещением +03:00 (в Москве нет перевода часов).

/** '2026-08-02 14:00:00' (строка YClients, салон-локальная) → Date | null. */
function parseVisitAt(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:00+03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'YYYY-MM-DD' московской даты момента. */
function moscowDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
}

/** МСК-дата визита + delayDays, в send_time ('HH:MM') по Москве → Date. */
function computeScheduledAt(visitAt, delayDays, sendTime) {
  const visit = visitAt instanceof Date ? visitAt : new Date(visitAt);
  if (Number.isNaN(visit.getTime())) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(sendTime || '').trim());
  const hm = m ? m[0] : '10:30';
  const [y, mo, d] = moscowDateStr(visit).split('-').map(Number);
  const base = new Date(Date.UTC(y, mo - 1, d + Number(delayDays || 0)));
  const ymd = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
  return new Date(`${ymd}T${hm}:00+03:00`);
}

/** +24 часа: анти-спам «1 касание в день» сдвигает касание, не скипает. */
function plusOneDay(dt) { return new Date(dt.getTime() + 24 * 3600 * 1000); }

module.exports = { parseVisitAt, computeScheduledAt, plusOneDay };
