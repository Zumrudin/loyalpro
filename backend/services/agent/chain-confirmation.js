'use strict';

// The server compares the last delivered offer with cached chains. A model's
// option_id alone is not consent to change the time or the specialists.
const { extractTimes } = require('./reply-guard');
const { fmtWhen } = require('./bookings-block');
const { sanitizeLine } = require('./sanitize');
const { mentionsAdditionalVisit } = require('./additional-visit');

// Уточнение «уже есть запись» перечисляет СТАРЫЕ записи (даты, время) перед новым
// вариантом. Их времена не должны сопоставляться с кэшем вариантов: иначе чужой
// вариант, начинающийся в то же время, что и старая запись, делает выбор неоднозначным.
const VARIANT_MARK = 'Новый вариант:';
const variantPart = text => { const t = String(text || ''), i = t.lastIndexOf(VARIANT_MARK); return i >= 0 ? t.slice(i + VARIANT_MARK.length) : t; };

const words = text => String(text || '').toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z]+/g) || [];
const stem = word => word.replace(/(?:ой|ей|а|я|ы|и|е|у|ю)$/u, '');
const sameName = (a, b) => stem(a).length >= 3 && stem(b).length >= 3
  && stem(a) === stem(b);

function mentionedStaff(offers, text) {
  const staff = new Map();
  for (const offer of Object.values(offers || {})) {
    for (const link of Array.isArray(offer && offer.chain) ? offer.chain : []) {
      staff.set(String(link.staff_yc_id), words(link.staff_name));
    }
  }
  const normalized = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\*/g, '');
  const tokens = [...normalized.matchAll(/[а-яa-z]+/g)];
  const mentions = [];
  let previousEnd = -1;
  for (const token of tokens) {
    const prefix = normalized.slice(0, token.index);
    // Only explicit staff references: «у Анны Ивановой», «к Анне»,
    // «15:00 Анна». A patient's name in a greeting is not a staff choice.
    const startsMention = /(?:^|[^а-яa-z])(?:у|к)\s+$/.test(prefix)
      || /\b\d{1,2}:\d{2}\s*(?:[—–-]\s*)?$/.test(prefix)
      || /(?:^|[^а-яa-z])специалист\s*:\s*$/.test(prefix);
    const continuesMention = previousEnd >= 0 && /^\s+$/.test(normalized.slice(previousEnd, token.index));
    const ids = [...staff].filter(([, names]) => names.some(n => sameName(n, token[0]))).map(([id]) => id);
    if (ids.length && (startsMention || continuesMention)) {
      mentions.push(ids);
      previousEnd = token.index + token[0].length;
    } else {
      previousEnd = -1;
    }
  }
  return mentions;
}

function datesIn(text) {
  const dates = [...String(text || '').matchAll(/\b(\d{1,2})\.(\d{2})(?:\.\d{4})?\b/g)]
    .filter(m => Number(m[1]) <= 31 && Number(m[2]) >= 1 && Number(m[2]) <= 12)
    .map(m => `${m[1].padStart(2, '0')}.${m[2]}`);
  const months = ['январ', 'феврал', 'март', 'апрел', 'май', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
  for (const m of String(text || '').toLowerCase().matchAll(/(?<![:\d])\b(\d{1,2})\s+([а-я]+)/g)) {
    const month = months.findIndex((v, i) => i === 4 ? /^(май|мая)$/.test(m[2]) : m[2].startsWith(v));
    if (month >= 0) dates.push(`${m[1].padStart(2, '0')}.${String(month + 1).padStart(2, '0')}`);
  }
  return dates;
}

function matchingOffers(offers, text, { loose = false } = {}) {
  const times = extractTimes(String(text || ''));
  const tokens = words(text);
  const mentions = mentionedStaff(offers, text);
  const dates = datesIn(text);
  const fullyNamed = new Set();
  const matched = Object.entries(offers || {}).filter(([id, offer]) => {
    if (!offer || !Array.isArray(offer.chain) || !offer.chain.length) return false;
    // Subsequence matching alone accepts «Anna then Maria» as «both Maria»:
    // it finds Maria later in the text and skips the name for the second link.
    // Every explicitly named specialist must be represented in the chain.
    // Shared names keep all possible IDs, so genuine ambiguity stays blocked.
    const staffIds = new Set(offer.chain.map(link => String(link.staff_yc_id)));
    if (!loose && mentions.some(ids => !ids.some(id => staffIds.has(id)))) return false;
    const dt = String(offer.chain[0].datetime || '');
    if (dates.length && !dates.includes(`${dt.slice(8, 10)}.${dt.slice(5, 7)}`)) return false;
    // One continuous visit with one specialist is presented by its start.
    // Separate specialists, gaps and explicitly listed starts retain full checks.
    const compact = offer.booking_mode === 'single_record' && times.length >= 1
      && offer.chain.every((link, i, chain) => String(link.staff_yc_id) === String(chain[0].staff_yc_id)
        && (!i || (Number(chain[i - 1].seance_length) > 0
          && Date.parse(link.datetime) === Date.parse(chain[i - 1].datetime) + Number(chain[i - 1].seance_length) * 1000)));
    let timePos = 0;
    let namePos = 0;
    let previousStaff = null;
    let everyTimeNamed = true;
    for (const link of offer.chain) {
      const time = /T(\d{2}:\d{2})/.exec(link.datetime || '');
      const pos = time ? times.indexOf(time[1], timePos) : -1;
      if (pos < 0 && !(compact && timePos > 0)) return false;
      if (pos < 0) everyTimeNamed = false;
      if (pos >= 0) timePos = pos + 1;
      if (String(link.staff_yc_id) !== previousStaff) {
        const names = words(link.staff_name);
        const idx = tokens.findIndex((token, i) => i >= namePos && names.some(n => sameName(n, token)));
        if (idx < 0) return false;
        namePos = idx + 1;
        previousStaff = String(link.staff_yc_id);
      }
    }
    if (everyTimeNamed) fullyNamed.add(id);
    return true;
  }).map(([id]) => id);
  // Вариант, у которого названы ВСЕ времена, точнее варианта, совпавшего лишь по
  // началу визита: время второй услуги из реплики не должно делать «стартом»
  // чужой вариант.
  const full = matched.filter(id => fullyNamed.has(id));
  return full.length ? full : matched;
}

const ORDINALS = [/(?<![а-яё])перв/u, /(?<![а-яё])втор/u, /(?<![а-яё])трет/u, /(?<![а-яё])четв[её]рт/u];

// В прошлой реплике могло быть показано несколько вариантов. Выбор пациента
// («давайте на 16:00», «первый вариант») снимает неоднозначность только когда
// он СОВПАДАЕТ с option_id модели: код проверяет согласованность двух сигналов,
// а не подставляет вариант сам.
function resolveAmongMatching(matching, offers, optionId, patientText, previousText, { needDiscriminator = false } = {}) {
  if (matching.length === 1 && !needDiscriminator) return matching[0];
  if (matching.length < 1 || !matching.includes(optionId)) return null;
  // Имя специалиста и дата из ответа пациента («К Юлии 29 октября») сужают выбор.
  const staffMentions = mentionedStaff(offers, patientText);
  const patientDates = datesIn(patientText);
  const narrowed = matching.filter(id => {
    const chain = (offers[id] || {}).chain || [];
    const staffIds = new Set(chain.map(l => String(l.staff_yc_id)));
    const dt = String((chain[0] || {}).datetime || '');
    return staffMentions.every(ids => ids.some(x => staffIds.has(x)))
      && (!patientDates.length || patientDates.includes(`${dt.slice(8, 10)}.${dt.slice(5, 7)}`));
  });
  if (!narrowed.includes(optionId)) return null;
  if (narrowed.length === 1 && (staffMentions.length || patientDates.length)) return optionId;
  if (needDiscriminator && narrowed.length === 1 && extractTimes(patientText).length) return optionId;
  matching = narrowed;
  const startOf = id => (((offers[id] || {}).chain || [])[0] || {}).datetime || '';
  const patientTimes = extractTimes(patientText);
  if (patientTimes.length) {
    const byTime = matching.filter(id => patientTimes.every(t =>
      ((offers[id] || {}).chain || []).some(l => (l.datetime || '').slice(11, 16) === t)));
    // Время пациента обязано быть НАЧАЛОМ варианта: «в 17:00» не выбирает вариант,
    // у которого 17:00 — вторая услуга.
    const starts = byTime.filter(id => patientTimes.includes(startOf(id).slice(11, 16)));
    return starts.length === 1 ? starts[0] : null;
  }
  const ordinal = ORDINALS.findIndex(re => re.test(patientText));
  if (ordinal < 0 || ORDINALS.filter(re => re.test(patientText)).length !== 1) return null;
  const shown = extractTimes(String(previousText || ''));
  const order = [...matching].sort((a, b) => {
    const pa = shown.indexOf(startOf(a).slice(11, 16)), pb = shown.indexOf(startOf(b).slice(11, 16));
    return pa - pb || Date.parse(startOf(a)) - Date.parse(startOf(b));
  });
  return order[ordinal] === optionId ? optionId : null;
}

function validateChoice(offers, optionId, ctx, input = {}) {
  // Non-dialog internal callers retain the existing contract. The orchestrator
  // always supplies these server-derived fields, never tool arguments.
  if (!Object.prototype.hasOwnProperty.call(ctx, 'previousAssistantText')) return null;
  const text = String(ctx.patientLastText || '').trim().toLowerCase();
  const legacyConsent = /^(да(?:[\s,!\.]+|$)|давайте|соглас[енна]|подтверждаю|запиш|записыва|подходит|хорошо|ок(?:ей)?(?:[\s.!]+|$))/u.test(text)
    && !/(?:^|\s)(?:не|нет)(?:\s|[,!.]|$)|\?/u.test(text)
    && words(text).every(w => ['да', 'давайте', 'пожалуйста', 'запиши', 'запишите', 'записывай',
      'записывайте', 'меня', 'нас', 'на', 'в', 'это', 'время', 'хорошо', 'ок', 'окей', 'подходит',
      'все', 'верно', 'подтверждаю', 'согласна', 'согласен'].includes(w))
    && !/\d/u.test(text.replace(/\b\d{1,2}:\d{2}\b/g, ''));
  // New tool calls use semantic consent, as ordinary reschedules do. Legacy
  // callers retain their previous contract; false/string values never fall back.
  const consent = Object.prototype.hasOwnProperty.call(input, 'patient_confirmed')
    ? input.patient_confirmed === true && !!text : legacyConsent;
  const matching = matchingOffers(offers, variantPart(ctx.previousAssistantText));
  const patientTimes = extractTimes(text);
  const selected = offers && offers[optionId];
  const chainTimes = (selected && selected.chain || []).map(l => (l.datetime || '').slice(11, 16));
  // Реплика с вариантами РАЗНЫХ специалистов не совпадает ни с одним вариантом по
  // строгому правилу. Тогда ответ пациента сам должен указать вариант (имя, дату,
  // время или номер): без этого запасной режим не включается.
  const pool = matching.length === 1 ? matching
    : matchingOffers(offers, variantPart(ctx.previousAssistantText), { loose: true });
  const resolved = consent ? resolveAmongMatching(pool, offers || {}, optionId, text, variantPart(ctx.previousAssistantText),
    { needDiscriminator: matching.length !== 1 }) : null;
  if (consent && resolved === optionId
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

function formatExisting(records, chain) {
  const titles = new Map((chain || []).map(l => [Number(l.service_yc_id), l.service_title]));
  return (records || []).map(r => {
    const when = fmtWhen(r.datetime);
    const names = (r.service_yc_ids || []).map(id => titles.get(Number(id))).filter(Boolean);
    return when && names.length ? `${when} — ${names.map(n => sanitizeLine(n, 180)).join(', ')}.` : null;
  }).filter(Boolean);
}

function confirmationReply(result) {
  const lines = formatFacts(result && result.records);
  if (!lines.length) return null;
  if (result.rescheduled) {
    return `${result.booked_all ? 'Записи перенесены:' : 'Удалось перенести только часть записей:'}\n${lines.join('\n')}`;
  }
  return `${result.booked_all ? 'Запись оформлена:' : 'Удалось оформить только часть записи:'}\n${lines.join('\n')}`;
}

function isBookingCheck(text) {
  const s = String(text || '').toLowerCase();
  // A read-only question about an existing appointment, never a change request.
  if (mentionsAdditionalVisit(s)) return false;
  if (/перенес|перенос|отмен|перезап|запиши|запишите|записаться|запишусь|хочу запис|мам|муж|жен[ау]|подруг/u.test(s)) return false;
  return /запис/u.test(s) && /к кому|у кого|к какому|к разным|к одному|точно|проверь|проверить|правильно|ты.*к\s|вы.*к\s|меня.*к\s|я.*к\s|(?:^|\s)к\s.+запис|запис(?:ала|али|ан[аы]?|аны).*к\s/u.test(s);
}

module.exports = { VARIANT_MARK, matchingOffers, validateChoice, recordFact, formatExisting, confirmationReply, formatFacts, isBookingCheck };
