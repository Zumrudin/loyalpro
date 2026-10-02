'use strict';

const { normalizePhoneKey } = require('../agent-gate');
const { createSlotEvidence } = require('./slot-evidence');
const { recordFact } = require('./chain-confirmation');
const writeGuard = require('./booking-write-guard');

function isTransferProposal(text) {
  const s = String(text || '');
  return /перен(?:ести|ес[её]м|осим|осить)/iu.test(s)
    && !/(?<!\p{L})не(?!\p{L})[^.!?\n]{0,60}перен|без\s+перен/iu.test(s);
}

// Only source IDs read by the server may be moved. We do not infer identity
// from service titles, pick the first of several visits, or split/merge visits.
function plan(offer, input, ctx) {
  if (!Object.prototype.hasOwnProperty.call(ctx, 'liveBookings')) return null;
  if (!ctx.clientPhone) return null; // create_booking retains its needs_phone flow.
  if (input.client_phone && normalizePhoneKey(input.client_phone) !== normalizePhoneKey(ctx.clientPhone)) return null;
  const refuse = () => ({ reschedule_blocked: true,
    error: 'Не удалось однозначно сопоставить услуги с существующими записями. Новые записи не создавались. Передай диалог администратору.' });
  if (!Array.isArray(ctx.liveBookings)) return refuse();
  if (ctx.liveBookings.some(b => !Array.isArray(b.service_yc_ids) || !b.service_yc_ids.length)) return refuse();
  const items = offer.chain.filter(l => !l.already_booked);
  // Услуга варианта УЖЕ записана, а пациент не сказал, что хочет перенос или
  // отдельный визит: это вопрос к пациенту, а не тупик. «Перенести» ведёт в
  // обычный перенос (Сценарий 3), «дополнительно» — в создание нового визита.
  const overlap = () => {
    const mine = b => (b.service_yc_ids || []).map(Number);
    const existing = ctx.liveBookings.filter(b => items.some(l => mine(b).includes(Number(l.service_yc_id))));
    return { needs_confirmation: true, existing_overlap: true, matching_option_ids: [input.option_id],
      existing_records: existing.map(b => ({ record_id: b.record_id, datetime: b.datetime,
        service_yc_ids: mine(b) })),
      booked_all: false, records: [],
      error: 'У пациента уже есть запись на услугу из этого варианта. Спроси: перенести её или оформить дополнительный визит с сохранением прежней. Новые записи не создавались.' };
  };
  const wantsAdditional = writeGuard.patientIntent([...(ctx.patientRecentTexts || []), ctx.patientLastText]) === 'additional'
    && /дополнител|ещ[её]\s+одн|прежн[а-яё]*\s+(?:запис[а-яё]*\s+)?остав/iu.test(String(ctx.previousAssistantText || ''));
  if (!offer.reschedulePlan && wantsAdditional) return null;
  const ids = b => (b.service_yc_ids || []).map(Number);
  const candidates = items.map(l => ctx.liveBookings.filter(b => ids(b).includes(Number(l.service_yc_id))));
  if (!offer.reschedulePlan && candidates.every(rows => !rows.length)) {
    if (offer.anchored) return null; // Adding new services after a fixed visit.
    return ctx.rescheduleRequested || isTransferProposal(ctx.previousAssistantText) ? refuse() : null;
  }
  // No mixed create+move transaction: stop before the first external effect.
  if (offer.anchored || items.length !== offer.chain.length) return refuse();
  if (!offer.reschedulePlan && !isTransferProposal(ctx.previousAssistantText)) {
    const oneToOne = candidates.every(rows => rows.length === 1)
      && new Set(candidates.map(rows => String(rows[0].record_id))).size === items.length
      && candidates.every((rows, i) => (rows[0].service_yc_ids || []).length === 1);
    if (!oneToOne) return overlap();
  }
  let sources;
  if (offer.reschedulePlan) {
    sources = offer.reschedulePlan.map(id => ctx.liveBookings.find(b => String(b.record_id) === String(id)));
  } else {
    if (candidates.some(rows => rows.length !== 1)) return refuse();
    sources = candidates.map(rows => rows[0]);
  }
  if (sources.length !== items.length || sources.some((b, i) => !b || !b.record_id
      || ids(b).length !== 1 || ids(b)[0] !== Number(items[i].service_yc_id))
      || new Set(sources.map(b => String(b.record_id))).size !== sources.length) return refuse();
  // Freeze the IDs even before reconfirmation. A later retry may not substitute
  // another visit after cancellation or a partial transfer.
  offer.reschedulePlan = sources.map(b => b.record_id);
  if (!isTransferProposal(ctx.previousAssistantText) || !writeGuard.transferConfirmed(items, ctx, true)) {
    return { needs_confirmation: true, reschedule_confirmation: true,
      matching_option_ids: [input.option_id], booked_all: false, records: [],
      error: 'Эти услуги уже записаны. Подтверди именно перенос существующих записей, а не создание новых.' };
  }
  return { sources, items };
}

async function execute(salonId, selected, ctx, rescheduleBooking) {
  const { sources, items } = selected;
  // Cached chain is the evidence, including when journal memory is disabled.
  // Keep all ordinary ownership, lead-time and service checks in reschedule_booking.
  const evidence = createSlotEvidence();
  evidence.add('get_sequential_slots', {}, { variants: [{ starts: [{ chain: items }] }] });
  const moveCtx = writeGuard.withChainTransfer({ ...ctx, slotEvidence: evidence, recentDialogText: ctx.previousAssistantText },
    items.map((link, i) => ({ record_id: sources[i].record_id, datetime: link.datetime, staff_yc_id: link.staff_yc_id })));
  const records = [];
  for (let i = 0; i < items.length; i++) {
    const link = items[i];
    let result;
    try {
      result = await rescheduleBooking(salonId, { record_id: sources[i].record_id,
        datetime: link.datetime, staff_yc_id: link.staff_yc_id, seance_length: link.seance_length },
        { ...moveCtx, expectedServiceYcIds: [link.service_yc_id] });
    } catch (_) { result = null; }
    if (!result || !result.rescheduled) {
      return { booked_all: false, reschedule_blocked: true, rescheduled: records.length > 0, partial: records.length > 0, records,
        failed_at: link.service_title, error: 'Не удалось перенести запись. Новые записи не создавались.',
        hint: 'Сообщи только о переносах из records. Остальные записи не перенесены; передай диалог администратору.' };
    }
    records.push(recordFact(link, sources[i].record_id));
  }
  return { booked_all: true, rescheduled: true, records };
}

module.exports = { plan, execute };
