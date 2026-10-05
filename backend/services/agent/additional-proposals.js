'use strict';

// One pending additional visit per tenant/dialog. Restart or eviction requires a
// new offer, never restores consent from model arguments or a slot lookup.
const { randomUUID } = require('crypto');
const { stripAllStamps } = require('./transcript-time');
const TTL_MS = 30 * 60 * 1000;
const MAX_DIALOGS = 500;
const store = new Map();
const key = (salon, dialog) => JSON.stringify([String(salon), String(dialog)]);
const normalize = text => stripAllStamps(String(text || '')).replace(/\s+/g, ' ').trim();
const phoneKey = value => {
  const raw = String(value || '');
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : raw;
};
const snapshot = rows => JSON.stringify(rows.map(b => ({ id: b.record_id,
  at: Date.parse(b.datetime), staff: Number(b.staff_yc_id),
  services: b.service_yc_ids.map(Number).sort((a, b) => a - b) })).sort((a, b) => Number(a.id) - Number(b.id)));
function peek(salon, dialog, now = Date.now()) {
  const p = store.get(key(salon, dialog));
  return p && now < p.expiresAt ? p : null;
}
function prepare(salon, ctx, input, text) {
  const p = Object.freeze({ id: randomUUID(), operation: 'additional',
    staff_yc_id: input.staff_yc_id, service_yc_id: input.service_yc_id,
    datetime: input.datetime, seance_length: input.seance_length,
    phone: phoneKey(ctx.clientPhone), existing: snapshot(ctx.liveBookings),
    text, deliveredText: null, sentAt: null, expiresAt: (ctx.nowMs || Date.now()) + TTL_MS });
  const k = key(salon, ctx.dialogKey);
  store.delete(k);
  store.set(k, p);
  while (store.size > MAX_DIALOGS) store.delete(store.keys().next().value);
  return p;
}
function markSent(salon, dialog, id, replies, now = Date.now()) {
  const p = peek(salon, dialog, now);
  const text = (replies || []).join('\n');
  if (!p || p.id !== id || !text.includes(p.text)) return false;
  store.set(key(salon, dialog), Object.freeze({ ...p, deliveredText: normalize(text), sentAt: Math.floor(now / 1000) }));
  return true;
}
function offered(salon, ctx) {
  const p = peek(salon, ctx.dialogKey, ctx.nowMs || Date.now());
  return p && p.deliveredText && Number(ctx.patientWatermark) > p.sentAt && p.phone === phoneKey(ctx.clientPhone)
    && p.deliveredText === normalize(ctx.previousAssistantText) ? p : null;
}
function rejection(salon, input, ctx) {
  const reject = reason => ({ invalid_args: true, needs_confirmation: true,
    confirmation_reason: reason,
    error: 'Дополнительный визит не подтверждён для этого предложения. При отказе или вопросе ответь пациенту. При изменении условий вызови prepare_additional_booking и дождись нового согласия. Не повторяй тот же вызов.' });
  const p = offered(salon, ctx);
  // Snapshot is populated before the model runs; a newly prepared offer cannot
  // authorize another call in the same turn, even if the model claims consent.
  if (!p || p.id !== ctx.additionalProposalId || p.id !== input.proposal_id) return reject('proposal_not_delivered_or_expired');
  if (input.patient_confirmed !== true) return reject('confirmation_flag_missing');
  if (!String(ctx.patientLastText || '').trim()) return reject('missing_context');
  if (phoneKey(input.client_phone || ctx.clientPhone) !== p.phone) return reject('proposal_patient_mismatch');
  if (Number(input.staff_yc_id) !== p.staff_yc_id || Number(input.service_yc_id) !== p.service_yc_id
      || input.datetime !== p.datetime
      || input.seance_length !== p.seance_length) return reject('proposal_target_changed');
  if (!Array.isArray(ctx.liveBookings) || ctx.liveBookings.some(b => !Array.isArray(b.service_yc_ids))) return reject('proposal_bookings_unverified');
  if (snapshot(ctx.liveBookings) !== p.existing) {
    // A successful earlier attempt (including a lost response) may now be in
    // CRM. Permit only this exact extra visit; the write guard returns its ID.
    const originalIds = new Set(JSON.parse(p.existing).map(b => String(b.id)));
    const added = ctx.liveBookings.filter(b => !originalIds.has(String(b.record_id)));
    const isTarget = b => b.service_yc_ids.length === 1 && Number(b.service_yc_ids[0]) === p.service_yc_id
      && Number(b.staff_yc_id) === p.staff_yc_id && Date.parse(b.datetime) === Date.parse(p.datetime);
    if (added.length !== 1 || !isTarget(added[0])
        || snapshot(ctx.liveBookings.filter(b => originalIds.has(String(b.record_id)))) !== p.existing) {
      return reject('proposal_bookings_changed');
    }
  }
  return null;
}
function operationRejection(tool, input, ctx) {
  if (!ctx.additionalProposalId || !['create_booking', 'book_chain', 'reschedule_booking', 'cancel_booking', 'modify_booking_services'].includes(tool)) return null;
  if (tool === 'create_booking' && input.proposal_id === ctx.additionalProposalId) return null;
  return { needs_confirmation: true, invalid_args: true, confirmation_reason: 'proposal_operation_changed',
    error: 'Последнее предложение — только дополнительный визит с сохранением прежних записей. Используй create_booking с его proposal_id только при согласии. Для другого действия сначала предложи его отдельно и дождись нового ответа пациента.' };
}
function prompt(p) {
  return p ? `\n\nСЕРВЕРНОЕ ПРЕДЛОЖЕНИЕ ДОПОЛНИТЕЛЬНОГО ВИЗИТА (отправлено пациенту):\n${JSON.stringify({ proposal_id: p.id, operation: p.operation, service_yc_id: p.service_yc_id, staff_yc_id: p.staff_yc_id, datetime: p.datetime, seance_length: p.seance_length })}\nОцени смысл ответа пациента на это предложение. Только явное согласие именно на дополнительный визит с сохранением прежних позволяет create_booking с этим proposal_id и patient_confirmed:true. Отказ, неоднозначность или изменение условий не являются согласием. Для других параметров сначала prepare_additional_booking. Отрицание переноса старого визита само по себе не отрицает новый визит.` : '';
}
module.exports = { prepare, markSent, offered, rejection, operationRejection, prompt, TTL_MS, _reset: () => store.clear() };
