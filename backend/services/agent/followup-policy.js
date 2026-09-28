'use strict';

// A blocked followup is NOT proof of a completed CRM action. In particular,
// illness/unavailability must stop nudges while cancellation can remain pending.
const confirmation = require('./visit-confirmation');
const BURST_SECONDS = 30 * 60;
const ILLNESS = /(?<![\p{L}])(?:заболел(?:а|и)?|приболел(?:а|и)?|болею|простудил(?:ась|ся)|температур[ауы])(?=$|[^\p{L}])/giu;
const UNAVAILABLE = /не\s+(?:(?:смогу|могу|получится)\s+(?:к\s+вам\s+)?(?:прийти|приехать|попасть)|приду|приеду)|(?:отмените|отменить|снимите|уберите)\s+(?:(?:мою|пожалуйста|завтрашнюю|сегодняшнюю)\s+)*(?:запись|визит|прием)|(?:сама|сам)\s+(?:вам\s+)?(?:напишу|позвоню)|(?:напишу|позвоню)\s+(?:вам\s+)?(?:сама|сам)/iu;
function normalize(text) {
  return typeof text === 'string' ? text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim() : '';
}
function reportsIllness(text) {
  const s = normalize(text);
  for (const match of s.matchAll(ILLNESS)) {
    const before = s.slice(0, match.index);
    // Negated or hypothetical illness is not a cancellation reason.
    if (/(?:^|\s)(?:не|не была|не был)\s*$/.test(before)) continue;
    if (/(?:^|[.!?])[^.!?]*(?:если|вдруг)\s+[^.!?]*$/.test(before)) continue;
    return true;
  }
  return false;
}
function explicitlyReopens(text) {
  const s = normalize(text);
  // Future recovery is not readiness now. Neither an assistant's suggestion
  // nor an isolated "yes" may restart followups on the patient's behalf.
  if (/когда|если|потом|после выздоров|после болезн|пока|не\s+(?:хочу|надо|нужно|запис)/u.test(s)) return false;
  return /(?<![\p{L}])(?:хочу\s+(?:снова\s+)?записаться|запишите\s+(?:меня|на)|давайте\s+запишемся|подберите\s+(?:время|окно))(?=$|[^\p{L}])/u.test(s);
}
function unavailableForFollowup(rows) {
  let paused = false;
  let recent = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r.direction !== 'incoming') continue;
    const text = normalize(r.text);
    const ts = Number(r.msg_ts);
    if (!Number.isFinite(ts)) continue;
    if (explicitlyReopens(text) && !reportsIllness(text)) {
      paused = false;
      recent = [];
      continue;
    }
    recent = recent.filter(x => ts >= x.ts && ts - x.ts <= BURST_SECONDS);
    recent.push({ text, ts });
    recent = recent.slice(-6);
    const burst = recent.map(x => x.text).join('\n');
    if (reportsIllness(burst) && UNAVAILABLE.test(burst)) paused = true;
  }
  return paused;
}
function stopReason(rows) {
  if (unavailableForFollowup(rows)) return 'client_unavailable';
  return confirmation.conversationComplete(rows) ? 'visit_confirmed' : null;
}
async function loadStopReason(db, salonId, dialogKey) {
  return stopReason(await confirmation.loadRows(db, salonId, dialogKey));
}
module.exports = { stopReason, loadStopReason, unavailableForFollowup, reportsIllness, explicitlyReopens };
