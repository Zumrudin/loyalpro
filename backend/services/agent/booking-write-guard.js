'use strict';

const { extractTimes } = require('./reply-guard');
const { resolveDate } = require('./offer-attribution');
const { stripAllStamps } = require('./transcript-time');
const { moscowDateKey, moscowHHMM } = require('./slot-evidence');
const { mentionsAdditionalVisit } = require('./additional-visit');

// Capabilities are server-only Symbols, bound to exact targets. Tool JSON cannot
// opt out of consent or turn a rejected transfer into creation.
const CHAIN_MOVE = Symbol('confirmed chain transfer');
const CHAIN_CREATE = Symbol('confirmed new chain link');
const ADDITIONAL = Symbol('confirmed additional proposal');
function withAdditionalProposal(ctx, input) { return { ...ctx, [ADDITIONAL]: input }; }
const MONTH = '(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-яё]*';
const DATE = new RegExp(`\\d{4}-\\d{2}-\\d{2}|(?<![\\d:.])\\d{1,2}\\.(?:0[1-9]|1[0-2])(?:\\.\\d{4})?(?![\\d:.])|(?<![:\\d])\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4}(?:\\s*года)?)?`, 'giu');
const RELATIVE = /(?<!\p{L})(?:послезавтра|завтра|сегодня)(?!\p{L})/giu;
const WEEKDAY = /(?<!\p{L})(?:понедельник|вторник|сред[ауе]|четверг|пятниц[ауе]|суббот[ауе]|воскресенье)(?!\p{L})/giu;
const TIME = /(?<!\d)(?:[01]?\d|2[0-3])[:.][0-5]\d(?!\d)/g;
const clean = s => stripAllStamps(String(s || '')).replace(/\*/g, '').trim();

// A separate sentence preserving a verified old visit is not a second choice
// of date for the new one. Do not discard unknown dates or mixed instructions.
const RETAINED_VISIT = new RegExp(`(^|[.!?]\\s+|\\n)\\s*(?:визит|запись|при[её]м)\\s+(?:на\\s+)?(${DATE.source})\\s+(?:оста[её]тся|оставляем|сохраняем)(?=[.!?](?:\\s|$)|$)`, 'giu');
function withoutRetainedVisit(text, ctx, nowMs) {
  const existingDates = new Set((Array.isArray(ctx.liveBookings) ? ctx.liveBookings : [])
    .map(b => Date.parse(b.datetime)).filter(Number.isFinite).map(ms => moscowDateKey(ms)));
  return text.replace(RETAINED_VISIT, (whole, boundary, date) => {
    const { keys } = datesIn(date, nowMs);
    return keys.length === 1 && existingDates.has(keys[0]) ? boundary : whole;
  });
}

function datesIn(text, nowMs) {
  const keys = [];
  let rest = clean(text).replace(DATE, raw => {
    let key = /^\d{4}-/.test(raw) ? raw : resolveDate(raw, { nowMs });
    const year = /(?:\.|\s)(\d{4})(?:\s*года)?$/.exec(raw);
    if (key && year) key = `${year[1]}${key.slice(4)}`;
    const day = /^\d{4}-/.test(raw) ? Number(raw.slice(8, 10)) : Number(/^\d+/.exec(raw)[0]);
    if (!key || Number(key.slice(8, 10)) !== day) key = 'invalid';
    keys.push(key);
    return ' ';
  });
  rest = rest.replace(RELATIVE, raw => { keys.push(resolveDate(raw, { nowMs })); return ' '; });
  const hasDate = keys.length > 0;
  rest = rest.replace(WEEKDAY, raw => {
    if (!hasDate) keys.push(resolveDate(raw, { nowMs }));
    return ' ';
  });
  return { keys: [...new Set(keys)], rest };
}

// Remove only an explicit preservation clause referring to a live CRM visit.
// Negation about the new visit (or an unknown old date/time) must remain visible.
const OLD_REFERENCE = `(?:(?:прежн|стар|существующ)[а-яё]*\\s+)?(?:запис[а-яё]*|визит[а-яё]*|при[её]м[а-яё]*)(?:\\s+(?:на\\s+)?(?:${DATE.source})(?:\\s+в\\s+${TIME.source})?)?`;
const KEEP_ACTION = '(?:не\\s+(?:переносим|переносите|переносить|трогаем|трогайте|трогать)|сохраняем|сохраните|оставляем|оставьте|оста[её]тся)';
const KEEP_CLAUSE = new RegExp(`(?<!\\p{L})(?:${OLD_REFERENCE}\\s+${KEEP_ACTION}|без\\s+переноса\\s+${OLD_REFERENCE})(?=\\s*(?:[,;.!?\\n]|$))`, 'giu');
function withoutPreservedBooking(text, ctx) {
  const nowMs = ctx.nowMs || Date.now();
  const live = (Array.isArray(ctx.liveBookings) ? ctx.liveBookings : [])
    .filter(b => b && Number.isFinite(Date.parse(b.datetime)));
  return clean(text).replace(KEEP_CLAUSE, clause => {
    const dates = datesIn(clause, nowMs).keys;
    const times = extractTimes(clause);
    if (!dates.length && !/(?:прежн|стар|существующ)[а-яё]*\s/iu.test(clause)) return clause;
    const verified = live.some(b => (!dates.length || (dates.length === 1
      && dates[0] === moscowDateKey(Date.parse(b.datetime))))
      && times.every(t => t === moscowHHMM(b.datetime)));
    return verified ? ' ' : clause;
  });
}

const ADDITIONAL_REASONS = {
  confirmation_flag_missing: 'Нет подтверждения: patient_confirmed должен быть true только после согласия пациента.',
  missing_context: 'Нет предложения или ответа пациента. Предложи конкретный дополнительный визит и дождись согласия.',
  patient_refusal: 'В ответе пациента есть отказ или отмена. Не создавай запись.',
  patient_question: 'Пациент задал вопрос. Ответь и дождись согласия на дополнительный визит.',
  negative_proposal: 'Предложение содержит отрицание нового визита. Уточни, нужен ли он пациенту.',
  additional_not_offered: 'Дополнительный визит с сохранением прежней записи ещё не предложен явно.',
  invalid_datetime: 'Дата или время новой записи некорректны.',
  date_not_offered: 'Дата новой записи не была предложена. Согласуй дату.',
  date_conflict: 'Дата в ответе пациента не совпадает с выбранным новым визитом или неоднозначна.',
  time_not_offered: 'Время новой записи не было предложено. Согласуй время.',
  time_conflict: 'Время в ответе пациента отличается от выбранного нового визита.',
  ambiguous_proposal: 'Предложено несколько дат или времён без однозначного выбора. Уточни вариант.',
  consent_unclear: 'Согласие на дополнительный визит не установлено. Уточни согласие.',
};
function additionalConfirmationRejection(input, ctx) {
  const reject = reason => ({ needs_confirmation: true, invalid_args: true,
    confirmation_reason: reason, error: ADDITIONAL_REASONS[reason] });
  const semantic = input.patient_confirmed === true;
  if (Object.prototype.hasOwnProperty.call(input, 'patient_confirmed') && !semantic) return reject('confirmation_flag_missing');
  const previous = withoutPreservedBooking(ctx.previousAssistantText, ctx);
  const patient = withoutPreservedBooking(ctx.patientLastText, ctx).toLowerCase();
  if (!previous.trim() || !patient.trim()) return reject('missing_context');
  if (/(?<!\p{L})(?:нет|не)(?!\p{L})|отмен|неудоб/iu.test(patient)) return reject('patient_refusal');
  if (/\?/.test(patient)) return reject('patient_question');
  if (/(?<!\p{L})(?:не|нет)(?!\p{L})|без\s+перен|неудоб/iu.test(previous)) return reject('negative_proposal');
  if (!mentionsAdditionalVisit(clean(ctx.previousAssistantText))
      && !/дополнител|ещ[её]\s+одн|прежн[а-яё]*\s+(?:запис[а-яё]*\s+)?остав/iu.test(ctx.previousAssistantText || '')) return reject('additional_not_offered');
  if (!Number.isFinite(Date.parse(input.datetime))) return reject('invalid_datetime');
  const day = moscowDateKey(Date.parse(input.datetime)), time = moscowHHMM(input.datetime);
  const nowMs = ctx.nowMs || Date.now();
  const proposal = datesIn(previous, nowMs), answer = datesIn(patient, nowMs);
  if (!proposal.keys.includes(day)) return reject('date_not_offered');
  if (answer.keys.some(d => d !== day)) return reject('date_conflict');
  const offered = [...new Set(extractTimes(previous))], selected = [...new Set(extractTimes(patient))];
  if (!offered.includes(time)) return reject('time_not_offered');
  if (selected.some(t => t !== time)) return reject('time_conflict');
  if ((proposal.keys.length > 1 && answer.keys.length !== 1)
      || (offered.length > 1 && selected.length !== 1)
      || /\d\s*(?:или|и|[,–—-])\s*\d{1,2}\s+[а-яё]/iu.test(previous)) return reject('ambiguous_proposal');
  if (!semantic) {
    // Compatibility for internal callers without a model consent flag.
    const words = answer.rest.replace(TIME, ' ').match(/[а-яa-z]+/giu) || [];
    const allowed = new Set(['да', 'давайте', 'пожалуйста', 'хорошо', 'ок', 'окей', 'подходит',
      'подтверждаю', 'согласен', 'согласна', 'все', 'всё', 'верно', 'на', 'в', 'это', 'время', 'меня']);
    if (words.some(w => !allowed.has(w)) || /\d/.test(answer.rest.replace(TIME, ' '))
        || (!selected.length && !words.some(w => /^(да|давайте|хорошо|ок|окей|подходит|подтверждаю|согласен|согласна|верно)$/.test(w)))) return reject('consent_unclear');
  }
  return null;
}

function transferConfirmed(targets, ctx, multiple = false, allowAdditional = false) {
  const previous = clean(ctx.previousAssistantText);
  const patient = clean(ctx.patientLastText).toLowerCase().replace(/ё/g, 'е');
  const nowMs = ctx.nowMs || Date.now();
  if (!targets.length || targets.some(t => !Number.isFinite(Date.parse(t.datetime)))) return false;
  if (!previous || !patient || /\?/.test(patient)) return false;
  // «Да» after a negative proposal is not affirmative consent to move.
  if (/(?<!\p{L})не(?!\p{L})[^.!?\n]{0,60}перен|без\s+перен|не\s+подходит|не\s*удоб/iu.test(previous)) return false;
  // A short «Да» cannot choose a day from a shorthand date list.
  if (/\d\s*(?:или|и|[,–—-])\s*\d{1,2}\s+[а-яё]/iu.test(previous)) return false;
  if (!allowAdditional && /дополнител|нов(?:ая|ую)\s+запис/iu.test(previous)) return false;
  const proposal = datesIn(previous, nowMs);
  const answer = datesIn(allowAdditional ? withoutRetainedVisit(patient, ctx, nowMs) : patient, nowMs);
  const targetDates = targets.map(t => moscowDateKey(Date.parse(t.datetime)));
  const semantic = ctx.patientConfirmed === true;
  if (semantic ? targetDates.some(d => !proposal.keys.includes(d))
    : proposal.keys.length !== 1 || targetDates.some(d => d !== proposal.keys[0])) return false;
  if (answer.keys.length && (answer.keys.length !== 1 || !targetDates.includes(answer.keys[0]))) return false;
  const offered = [...new Set(extractTimes(previous))];
  const selected = [...new Set(extractTimes(patient))];
  const required = [...new Set(targets.map(t => moscowHHMM(t.datetime)))];
  const compact = multiple && ctx.bookingMode === 'single_record' && offered.length === 1
    && targets.every(t => t.staff_yc_id === targets[0].staff_yc_id);
  if ((compact ? required.slice(0, 1) : required).some(t => !t || !offered.includes(t))) return false;
  if (semantic) return selected.every(t => required.includes(t));
  const words = answer.rest.replace(TIME, ' ').match(/[а-яa-z]+/giu) || [];
  const allowed = new Set(['да', 'давайте', 'пожалуйста', 'хорошо', 'ок', 'окей', 'подходит',
    'подтверждаю', 'согласен', 'согласна', 'все', 'верно', 'перенеси', 'перенесите', 'переносите',
    'на', 'в', 'это', 'время', 'меня']);
  if (words.some(w => !allowed.has(w)) || /\d/.test(answer.rest.replace(TIME, ' '))) return false;
  const affirmative = words.some(w => ['да', 'давайте', 'хорошо', 'ок', 'окей', 'подходит', 'подтверждаю',
    'согласен', 'согласна', 'перенеси', 'перенесите', 'переносите', 'верно'].includes(w));
  if (!affirmative && !selected.length) return false;
  if (selected.length) return selected.length === required.length && selected.every(t => required.includes(t));
  return affirmative && offered.length === required.length && (multiple || offered.length === 1);
}

function withChainTransfer(ctx, targets) {
  return transferConfirmed(targets, ctx, true) ? { ...ctx, [CHAIN_MOVE]: targets } : ctx;
}

// Согласие на ОБЫЧНЫЙ перенос определяет МОДЕЛЬ (patient_confirmed), а не разбор
// реплик. Инцидент 2026-09-30 (79110624600): пациентка четырежды подтвердила
// перенос, а transferConfirmed отказывал — в вопросе Милы стояли две даты
// («с 9 октября на 10 октября»), а «Переносим» не входило в белый список слов.
// Любой список слов согласия заведомо неполон, поэтому код сверяет только
// ФАКТЫ: флаг выставлен и новое время звучало в переписке цифрами (слот и
// принадлежность записи проверяются отдельно — slot-evidence, booking-modify).
// Строгая проверка оставлена ТЕЛЕМЕТРИЕЙ (strictMismatch → лог в инструменте):
// мерить, как часто модель подтверждает там, где текст согласия не показывает.
// Цепочка получает серверную capability CHAIN_MOVE только после проверки
// выбранного варианта и исходных записей; флаг модели сам её не создаёт.
function rescheduleRejection(input, ctx) {
  const bound = ctx[CHAIN_MOVE];
  if (bound && bound.some(t => t.record_id === input.record_id && t.datetime === input.datetime
      && t.staff_yc_id === input.staff_yc_id)) return null;
  return confirmationRejection(input, ctx, 'Перенос');
}

function confirmationRejection(input, ctx, operation = 'Оформление записи') {
  const hhmm = moscowHHMM(input.datetime);
  const when = hhmm ? `${input.datetime} (${hhmm})` : input.datetime;
  if (input.patient_confirmed !== true) {
    return { needs_confirmation: true, invalid_args: true,
      error: `${operation} на ${when} не подтверждён: patient_confirmed не равен true. Если пациент УЖЕ явно согласился на это время (любыми словами) — повтори вызов с patient_confirmed:true, не переспрашивай. Если согласия ещё не было — назови дату и время и спроси. Тип операции менять нельзя.` };
  }
  if (!hhmm || !extractTimes(clean(ctx.recentDialogText || ctx.previousAssistantText)).includes(hhmm)) {
    return { needs_confirmation: true, invalid_args: true,
      error: `${operation} на ${when} не подтверждён: это время ещё не звучало в переписке. Назови пациенту дату и время цифрами и дождись согласия. Тип операции менять нельзя.` };
  }
  return null;
}

// Телеметрия для прохода по флагу модели: что сказала бы прежняя строгая проверка.
function strictMismatch(input, ctx) {
  if (ctx[CHAIN_MOVE]) return false;
  const moveIntent = ctx.rescheduleRequested || /перенес|перенести|перенос|перезапис/iu.test(clean(ctx.previousAssistantText));
  return !(moveIntent && transferConfirmed([input], ctx));
}

function patientIntent(texts, ctx = {}) {
  for (const text of [...(texts || [])].reverse()) {
    const s = withoutPreservedBooking(text, ctx).toLowerCase();
    if (/перенес|перенести|перенос|перезапис/iu.test(s)
        && !/(?<!\p{L})не(?!\p{L})[^.!?\n]{0,40}перен|без\s+перен/iu.test(s)) return 'reschedule';
    if (/\?|отмен|(?<!\p{L})(?:нет|не)(?!\p{L})/iu.test(s)) return null;
    if (mentionsAdditionalVisit(s)) return 'additional';
    if (/хочу\s+запис|(?<!\p{L})запиши(?:те)?(?!\p{L})|нов(?:ая|ую)\s+запис/iu.test(s)) return 'new';
  }
  return null;
}

function withNewChainLink(ctx, input) { return { ...ctx, [CHAIN_CREATE]: input }; }

function creationRejection(input, ctx) {
  const scope = Object.prototype.hasOwnProperty.call(ctx, 'liveBookings');
  const intent = patientIntent([...(ctx.patientRecentTexts || []), ctx.patientLastText], ctx);
  const link = ctx[CHAIN_CREATE];
  const trustedLink = link && link.service_yc_id === input.service_yc_id && link.datetime === input.datetime;
  const previous = clean(ctx.previousAssistantText);
  const offeredTransfer = /перенести|перенес[её]м|переносим/iu.test(previous)
    && !/(?<!\p{L})не(?!\p{L})[^.!?\n]{0,60}перен|без\s+перен/iu.test(previous);
  const additional = ctx[ADDITIONAL];
  const trustedAdditional = additional && additional.proposal_id === input.proposal_id
    && additional.datetime === input.datetime && additional.staff_yc_id === input.staff_yc_id
    && additional.service_yc_id === input.service_yc_id;
  const moving = intent === 'reschedule' || offeredTransfer
    || (!['additional', 'new'].includes(intent) && ctx.rescheduleRequested);
  const blocked = { requires_reschedule: true, invalid_args: true,
    error: 'Создание новой записи вместо переноса запрещено. Используй исходный record_id из list_client_bookings и reschedule_booking после подтверждения. Для отдельного дополнительного визита требуется явный запрос пациента.' };
  if (moving && !trustedLink && !trustedAdditional) return blocked;
  if (!scope) return null; // Existing non-dialog internal callers retain their contract.
  if (!Array.isArray(ctx.liveBookings) || ctx.liveBookings.some(b => !Array.isArray(b.service_yc_ids) || !b.service_yc_ids.length)) {
    return { unverified_existing_bookings: true, invalid_args: true,
      error: 'Не удалось проверить существующие записи. Сначала проверь list_client_bookings; пока не создавай новую запись.' };
  }
  const matches = ctx.liveBookings.filter(b => b.service_yc_ids.some(id => Number(id) === Number(input.service_yc_id)));
  const identical = matches.filter(b => b.service_yc_ids.length === 1
    && Number(b.staff_yc_id) === Number(input.staff_yc_id) && Date.parse(b.datetime) === Date.parse(input.datetime));
  if (identical.length === 1 && identical[0].record_id) {
    return { created: false, duplicate: true, record_id: identical[0].record_id };
  }
  if (trustedAdditional) return null;
  if (matches.length && ctx.requireStructuredAdditional && !trustedLink) {
    return { needs_confirmation: true, invalid_args: true, confirmation_reason: 'structured_proposal_required',
      error: 'Для дополнительного визита вызови prepare_additional_booking. Сервер покажет конкретный вариант пациенту; после его согласия используй create_booking с proposal_id. Если пациент просит перенос, используй reschedule_booking.' };
  }
  if (matches.length) {
    if (intent !== 'additional') return blocked;
    const rejection = additionalConfirmationRejection(input, ctx);
    if (rejection) return rejection;
  }
  if (!trustedLink && Object.prototype.hasOwnProperty.call(input, 'patient_confirmed')) {
    return confirmationRejection(input, ctx);
  }
  return null;
}

module.exports = { withAdditionalProposal, creationRejection, rescheduleRejection, strictMismatch, withChainTransfer, withNewChainLink, transferConfirmed, patientIntent };
