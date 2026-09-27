'use strict';

// The server compares the last delivered offer with cached chains. A model's
// option_id alone is not consent to change the time or the specialists.
const { extractTimes } = require('./reply-guard');
const { fmtWhen } = require('./bookings-block');
const { sanitizeLine } = require('./sanitize');

const words = text => String(text || '').toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z]+/g) || [];
const stem = word => word.replace(/(?:ой|ей|а|я|ы|и|е|у|ю)$/u, '');
const sameName = (a, b) => stem(a).length >= 3 && stem(b).length >= 3
  && stem(a) === stem(b);

function matchingOffers(offers, text) {
  const times = extractTimes(String(text || ''));
  const tokens = words(text);
  const dates = [...String(text || '').matchAll(/\b(\d{1,2})\.(\d{2})(?:\.\d{4})?\b/g)]
    .filter(m => Number(m[1]) <= 31 && Number(m[2]) >= 1 && Number(m[2]) <= 12)
    .map(m => `${m[1].padStart(2, '0')}.${m[2]}`);
  const months = ['январ', 'феврал', 'март', 'апрел', 'май', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
  for (const m of String(text || '').toLowerCase().matchAll(/(?<![:\d])\b(\d{1,2})\s+([а-я]+)/g)) {
    const month = months.findIndex((v, i) => i === 4 ? /^(май|мая)$/.test(m[2]) : m[2].startsWith(v));
    if (month >= 0) dates.push(`${m[1].padStart(2, '0')}.${String(month + 1).padStart(2, '0')}`);
  }
  return Object.entries(offers || {}).filter(([, offer]) => {
    if (!offer || !Array.isArray(offer.chain) || !offer.chain.length) return false;
    const dt = String(offer.chain[0].datetime || '');
    if (dates.length && !dates.includes(`${dt.slice(8, 10)}.${dt.slice(5, 7)}`)) return false;
    let timePos = 0;
    let namePos = 0;
    let previousStaff = null;
    for (const link of offer.chain) {
      const time = /T(\d{2}:\d{2})/.exec(link.datetime || '');
      const pos = time ? times.indexOf(time[1], timePos) : -1;
      if (pos < 0) return false;
      timePos = pos + 1;
      if (String(link.staff_yc_id) !== previousStaff) {
        const names = words(link.staff_name);
        const idx = tokens.findIndex((token, i) => i >= namePos && names.some(n => sameName(n, token)));
        if (idx < 0) return false;
        namePos = idx + 1;
        previousStaff = String(link.staff_yc_id);
      }
    }
    return true;
  }).map(([id]) => id);
}

function validateChoice(offers, optionId, ctx) {
  // Non-dialog internal callers retain the existing contract. The orchestrator
  // always supplies these server-derived fields, never tool arguments.
  if (!Object.prototype.hasOwnProperty.call(ctx, 'previousAssistantText')) return null;
  const text = String(ctx.patientLastText || '').trim().toLowerCase();
  const consent = /^(да(?:[\s,!\.]+|$)|давайте|соглас[енна]|подтверждаю|запиш|записыва|подходит|хорошо|ок(?:ей)?(?:[\s.!]+|$))/u.test(text)
    && !/(?:^|\s)(?:не|нет)(?:\s|[,!.]|$)|\?/u.test(text)
    && words(text).every(w => ['да', 'давайте', 'пожалуйста', 'запиши', 'запишите', 'записывай',
      'записывайте', 'меня', 'нас', 'на', 'в', 'это', 'время', 'хорошо', 'ок', 'окей', 'подходит',
      'все', 'верно', 'подтверждаю', 'согласна', 'согласен'].includes(w))
    && !/\d/u.test(text.replace(/\b\d{1,2}:\d{2}\b/g, ''));
  const matching = matchingOffers(offers, ctx.previousAssistantText);
  const patientTimes = extractTimes(text);
  const selected = offers && offers[optionId];
  const chainTimes = (selected && selected.chain || []).map(l => (l.datetime || '').slice(11, 16));
  if (consent && matching.length === 1 && matching[0] === optionId
      && patientTimes.every(t => chainTimes.includes(t))) return null;
  return {
    needs_confirmation: true, booked_all: false, records: [],
    matching_option_ids: matching,
    error: 'Выбранная цепочка не подтверждена последним предложением и согласием пациента. Записи не создавались.',
    hint: consent && matching.length === 1
      ? `Последнему предложению соответствует ${matching[0]}. Используй его без изменения специалистов и времени.`
      : 'Назови дату, время КАЖДОЙ услуги и специалистов одного варианта и дождись нового согласия. Не оформляй через create_booking.',
  };
}

function recordFact(link, recordId) {
  return { record_id: recordId, service_yc_id: link.service_yc_id,
    service_title: link.service_title, datetime: link.datetime,
    staff_yc_id: link.staff_yc_id, staff_name: link.staff_name };
}

function formatFacts(records) {
  return (records || []).map(r => {
    const when = fmtWhen(r.datetime);
    if (!when) return null;
    const services = Array.isArray(r.services) ? r.services : [r.service_title];
    const title = services.map(s => sanitizeLine(s, 180)).filter(Boolean).join(', ') || 'услуга';
    const staff = sanitizeLine(r.staff_name, 100) || 'специалист не указан';
    return `${when} — ${title}; специалист: ${staff}.`;
  }).filter(Boolean);
}

function confirmationReply(result) {
  const lines = formatFacts(result && result.records);
  if (!lines.length) return null;
  return `${result.booked_all ? 'Запись оформлена:' : 'Удалось оформить только часть записи:'}\n${lines.join('\n')}`;
}

function isBookingCheck(text) {
  const s = String(text || '').toLowerCase();
  // A read-only question about an existing appointment, never a change request.
  if (/перенес|перенос|отмен|перезап|запиши|запишите|записаться|запишусь|хочу запис|мам|муж|жен[ау]|подруг/u.test(s)) return false;
  return /запис/u.test(s) && /к кому|у кого|к какому|к разным|к одному|точно|проверь|проверить|правильно|ты.*к\s|вы.*к\s|меня.*к\s|я.*к\s|(?:^|\s)к\s.+запис|запис(?:ала|али|ан[аы]?|аны).*к\s/u.test(s);
}

module.exports = { matchingOffers, validateChoice, recordFact, confirmationReply, formatFacts, isBookingCheck };
