'use strict';

const { sanitizeLine } = require('./sanitize');

// Детерминированный ответ на узкий вопрос о графике НАЗВАННОГО мастера.
// Для такого вопроса услуга не нужна: get_available_slots без неё не может
// ответить, а get_available_dates читает именно смены из YClients. Не отдаём
// этот маршрут модели — инцидент 19.08.2026 показал, что после сжатия v2 она
// сначала спрашивала услугу, а затем путала «не работает» с «всё занято».

const SCHEDULE_RE = /(?:работа(?:ет|ют)|принима(?:ет|ют)|график|выходн|отпуск)/iu;
const BOOKING_RE = /(?:запис(?:аться|ать|ыва)|можно\s+(?:ли\s+)?(?:к|на)|хочу\s+(?:к|на))/iu;
// JS \b знает только ASCII-слова, поэтому для кириллицы — явные границы букв.
const TODAY_RE = /(?<!\p{L})сегодня(?!\p{L})/iu;
const TOMORROW_RE = /(?<!\p{L})завтра(?!\p{L})/iu;
const HORIZON_DAYS = 30;

function moscowIsoDate(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const byType = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function addDays(date, days) {
  const [year, month, day] = String(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86400000).toISOString().slice(0, 10);
}

function requestedDate(text, nowMs) {
  const value = String(text || '');
  const today = moscowIsoDate(nowMs);
  if (TOMORROW_RE.test(value)) return { date: addDays(today, 1), label: 'Завтра' };
  if (TODAY_RE.test(value)) return { date: today, label: 'Сегодня' };
  return null;
}

function tokenRe(token) {
  return new RegExp(`(?<!\\p{L})${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'iu');
}

function matchedStaff(text, staff) {
  const value = String(text || '');
  const matches = (Array.isArray(staff) ? staff : []).filter(person => {
    const words = String(person && person.name || '').split(/\s+/).filter(word => word.length >= 4);
    return words.some(word => tokenRe(word).test(value));
  });
  return matches.length === 1 ? matches[0] : null;
}

function formatDate(date) {
  const value = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(value.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: 'numeric', month: 'long',
  }).format(value);
}

function formatHours(hours) {
  return (Array.isArray(hours) ? hours : [])
    .filter(slot => slot && /^\d{2}:\d{2}$/.test(String(slot.from)) && /^\d{2}:\d{2}$/.test(String(slot.to)))
    .map(slot => `${slot.from}–${slot.to}`)
    .join(', ');
}

function renderReply(staff, target, schedule) {
  const name = sanitizeLine(staff && staff.name, 100) || 'этот специалист';
  const rows = Array.isArray(schedule) ? schedule : [];
  const current = rows.find(row => row && row.date === target.date);
  if (current) {
    const hours = formatHours(current.hours);
    return `${target.label} ${name} принимает${hours ? `: ${hours}.` : '.'}`;
  }
  const next = rows.filter(row => row && row.date > target.date).sort((a, b) => a.date.localeCompare(b.date))[0];
  return `${target.label} ${name} не принимает.${next ? ` Ближайший рабочий день — ${formatDate(next.date)}.` : ''}`;
}

async function run({ text, nowMs, salonId, listStaff, getAvailableDates }) {
  const value = String(text || '');
  const asksSchedule = SCHEDULE_RE.test(value);
  const asksBooking = BOOKING_RE.test(value);
  if (!asksSchedule && !asksBooking) return null;
  const target = requestedDate(text, nowMs);
  if (!target || typeof listStaff !== 'function' || typeof getAvailableDates !== 'function') return null;

  const listed = await listStaff(salonId, {});
  const found = matchedStaff(text, listed && listed.staff);
  const staffId = Number(found && found.yc_id);
  if (!found || !Number.isInteger(staffId) || staffId <= 0) return null;
  const staff = { ...found, yc_id: staffId };

  const input = {
    staff_yc_id: staff.yc_id,
    date_from: target.date,
    date_to: addDays(target.date, HORIZON_DAYS),
  };
  const dates = await getAvailableDates(salonId, input);
  if (!dates || dates.error || !Array.isArray(dates.schedule)) {
    return { staff, target, listed, dates, reply: 'К сожалению, сейчас не получается уточнить график. Попробуйте, пожалуйста, немного позже.' };
  }
  // Для запроса записи в рабочий день всё ещё нужна услуга и конкретные слоты —
  // возвращаемся в обычный tool-цикл. Но если смены нет, ответ известен уже
  // сейчас и нельзя создавать ложное впечатление доступности записи.
  const worksThatDay = dates.schedule.some(row => row && row.date === target.date);
  if (!asksSchedule && asksBooking && worksThatDay) return null;
  return { staff, target, listed, dates, reply: renderReply(staff, target, dates.schedule) };
}

function renderNotWorkingReply(name, nextWorkingDate) {
  const who = sanitizeLine(name, 100) || 'Этот специалист';
  return `${who} в этот день не принимает.${nextWorkingDate ? ` Ближайший рабочий день — ${formatDate(nextWorkingDate)}.` : ''}`;
}

module.exports = {
  SCHEDULE_RE, BOOKING_RE, HORIZON_DAYS, moscowIsoDate, addDays, requestedDate, matchedStaff,
  renderReply, renderNotWorkingReply, run,
};
