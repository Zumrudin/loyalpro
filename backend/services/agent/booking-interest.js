'use strict';

// Pure policy over the already loaded, tenant-scoped conversation. No storage,
// tools or provider calls. An invitation is not consent to create a booking.
const { SCENARIOS, detectPromptScenarios, isPriceQuestion } = require('./prompt-scenarios');
const { DEFAULT_GAP_HOURS } = require('./session-gap');
const { stripStamp } = require('./transcript-time');
const { isPureClosing } = require('./closing');
const { parseDayPart } = require('./patient-time');
const { resolveDateInfo } = require('./offer-attribution');

const STEP_QUESTION = 'Подобрать Вам удобное время для записи?';
const GAP_MS = DEFAULT_GAP_HOURS * 60 * 60 * 1000;
const INVITATION_RE = /(?:подобрать|подберу|подбер[её]м|подобрала|посмотреть|посмотрим|предложить|предложу|выбрать|выберем)[^.!?\n]{0,65}(?:врем|день|дат|окош|запис|консультац)|(?:записать|запишу|запишем)(?![\p{L}])|(?:хотите|можем|можно|предлагаю|приглашаю)[^.!?\n]{0,55}(?:записаться|консультацию)|(?:какой|какая|когда|какое)[^.!?\n]{0,35}(?:день|дата|время|удобн)/iu;
const INTEREST_RE = /что\s+(?:у\s+вас\s+)?(?:входит|включ)|(?:входит|включен|включ[её]н)|как\s+(?:она\s+|он\s+|это\s+)?проход|сколько[^?!\n]{0,40}(?:длится|длительность|занимает)|расскажите\s+(?:про|об?|подробнее)|чем[^?!\n]{0,35}отлич|какой[^?!\n]{0,30}(?:эффект|результат)|(?:делаете|проводите)\s+ли/iu;
const DECLINE_RE = /не\s+(?:хочу|хотим|планирую|собираюсь|готов[аы]?|надо|нужно)[^.!?\n]{0,35}(?:запис|предлаг|приход)|не\s+(?:записывайте|предлагайте|записывай|предлагай)|(?:пока|сейчас)\s+не\s+(?:надо|нужно)|нет,?\s+спасибо|подумаю|подумаем|напишу\s+сам[аи]?|вернусь\s+позже|просто\s+(?:узнаю|спрашиваю|интересуюсь)|только\s+(?:узнаю|спрашиваю|интересуюсь)|без\s+(?:записи|предложений)/iu;
const MEDICAL_RISK_RE = /болит|боль|от[её]к|осложнен|покрасн|сып[ьи]|беремен|лактац|аллерг|диабет|противопоказ|реабилит|подготовк|можно\s+ли\s+мне|после\s+(?:визита|процедуры)[^.!?\n]{0,30}(?:плохо|жж[её]т)/iu;
const PERSONAL_RISK_RE = /беремен|лактац|аллерг|диабет|противопоказ|можно\s+ли\s+мне|после\s+(?:визита|процедуры)[^.!?\n]{0,40}(?:болит|от[её]к|покрасн|плохо|жж[её]т)/iu;
const REFUSAL_RE = /не\s+(?:проводим|делаем|оказываем|занимаемся|предоставляем)|не\s+могу\s+(?:предложить|записать)|(?:услуг[аи]|процедур[аы]|препарат)[^.!?\n]{0,35}(?:нет|недоступ|отсутств)|(?:у\s+нас|в\s+клинике)\s+нет|обратитесь|нужен\s+профильный|уточн[ию][^.!?\n]{0,30}администратор/iu;
const BOOKED_RE = /(?:вы|вас)\s+(?:уже\s+)?записан|записала|запись\s+(?:подтверждена|оформлена|создана)|жд[её]м\s+вас/iu;

function hasBookingInvitation(text) {
  return INVITATION_RE.test(String(text || ''));
}

function isServiceInterest(text) {
  return isPriceQuestion(text) || INTEREST_RE.test(String(text || ''));
}

// Preserve raw chronology (including leading clinic messages and delayed echo).
// A six-hour gap starts a new conversation. Incomplete/missing timestamps cannot
// establish multi-turn interest; retain their text only to suppress repetition.
function recentConversation(conversation, nowMs) {
  const rows = Array.isArray(conversation) ? conversation : [];
  let start = 0;
  let previous = null;
  for (let i = 0; i < rows.length; i++) {
    const ts = Number(rows[i].msg_ts) * 1000;
    if (!Number.isFinite(ts) || ts <= 0 || ts > nowMs + 60000) { previous = null; continue; }
    if (previous !== null && ts - previous >= GAP_MS) start = i;
    previous = ts;
  }
  return rows.slice(start).filter(r => {
    const ts = Number(r.msg_ts) * 1000;
    return !Number.isFinite(ts) || ts <= 0 || (ts <= nowMs + 60000 && nowMs - ts < GAP_MS);
  });
}

function bookingInterest(opts = {}) {
  const patient = stripStamp(String(opts.patientLastText || ''));
  const reply = String(opts.replyText || '');
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const rows = recentConversation(opts.conversation, nowMs);
  const sc = detectPromptScenarios(patient);
  const deny = reason => ({ allowStep: false, contextual: false, reason });
  // Never turn a read-only answer into a competing booking flow.
  if (opts.hasBookings || opts.bookingInProgress) return deny('booking_in_progress');
  if (sc.includes(SCENARIOS.BOOKING) || sc.includes(SCENARIOS.MANAGE_BOOKING)
    || parseDayPart(patient) || resolveDateInfo(patient, { nowMs })) return deny('booking_in_progress');
  if (DECLINE_RE.test(patient) || rows.some(r => r.direction === 'incoming' && DECLINE_RE.test(r.text || ''))) return deny('declined');
  if (sc.some(s => [SCENARIOS.ESCALATION,
    SCENARIOS.MEDICAL, SCENARIOS.PERSONAL, SCENARIOS.CLINIC, SCENARIOS.OBJECTION].includes(s))) return deny('sensitive_or_active');
  if (MEDICAL_RISK_RE.test(patient) || REFUSAL_RE.test(reply) || BOOKED_RE.test(reply)
    || /уже\s+записан|не\s+понрав|жалуюсь|хамств|хамите/iu.test(patient)
    || /(?:решает|определит)\s+врач|только\s+(?:после\s+осмотра|врач)/iu.test(reply)
    || isPureClosing(patient)) return deny('not_sales');
  if ((opts.stopTopics || []).some(t => t && patient.toLowerCase().includes(String(t).toLowerCase()))) return deny('stop_topic');
  if (rows.some(r => r.direction === 'incoming' && PERSONAL_RISK_RE.test(r.text || ''))) return deny('medical_context');
  if (rows.some(r => r.direction === 'outgoing' && (hasBookingInvitation(r.text) || BOOKED_RE.test(r.text || '')))) return deny('already_offered');

  // Count answered user turns, not separate messages in one incoming burst.
  // System notifications cannot manufacture interest or count as an answer.
  let interested = false;
  let answeredTurns = 0;
  for (const r of rows) {
    const ts = Number(r.msg_ts) * 1000;
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (r.direction === 'incoming') interested = interested || isServiceInterest(r.text);
    else if (r.authored_by !== 'system') {
      if (interested) answeredTurns++;
      interested = false;
    }
  }
  return { allowStep: true, contextual: !isPriceQuestion(patient) && isServiceInterest(patient)
    && answeredTurns >= 1 && !!opts.hasServiceEvidence, reason: null };
}

function applyContextualOffer(replies, policy) {
  const list = Array.isArray(replies) ? replies : [];
  const joined = list.join('\n');
  // A clarifying question must be answered first; facts about composition or
  // duration alone do NOT count as an invitation.
  if (!policy.allowStep || !policy.contextual || !joined.trim() || joined.includes('?')
    || hasBookingInvitation(joined)) return list;
  const out = list.slice();
  out[out.length - 1] = `${String(out[out.length - 1]).trimEnd()} ${STEP_QUESTION}`;
  return out;
}

// Remove only a standalone, generic repeated CTA. Never cut a sentence with
// service details, a verified time or an answer to the patient's question.
const GENERIC_INVITATION_RE = /^(?:подобрать(?:\s+вам)?(?:\s+удобное)?\s+время(?:\s+для\s+записи)?|хотите\s+записаться|записать(?:\s+вас)?(?:\s+на\s+консультацию)?|какой\s+день\s+вам\s+удобен)\?$/iu;
function removeRepeatedOffer(replies, policy) {
  if (!['already_offered', 'declined'].includes(policy.reason)) return replies;
  const out = replies.map(text => {
    const sentences = String(text).split(/(?<=[.!?])\s+|\n+/u);
    if (!sentences.some(sentence => GENERIC_INVITATION_RE.test(sentence.trim()))) return text;
    return sentences.filter(sentence => !GENERIC_INVITATION_RE.test(sentence.trim())).join(' ').trim();
  }).filter(Boolean);
  // Do not create an empty reply: the dispatcher would treat it as a failure.
  return out.length && out.join('\n') !== replies.join('\n') ? out : replies;
}

module.exports = { STEP_QUESTION, hasBookingInvitation, bookingInterest, applyContextualOffer, removeRepeatedOffer };
