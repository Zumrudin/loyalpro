'use strict';
jest.mock('./services/agent/booking', () => ({ createBookingRecord: jest.fn(async () => ({ created: true, record_id: 900 })) }));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn() }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => null) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: jest.fn(() => true) }));
jest.mock('./services/agent/identity', () => ({ resolveClient: jest.fn() }));
const proposals = require('./services/agent/additional-proposals');
const prepare = require('./services/agent/tools/prepare-additional-booking');
const create = require('./services/agent/tools/create-booking');
const booking = require('./services/agent/booking');
const catalog = require('./services/agent/tools/list-services');
const { createSlotEvidence } = require('./services/agent/slot-evidence');
const nowMs = Date.parse('2026-10-05T09:00:00Z');
const input = { service_yc_id: 101, staff_yc_id: 7, datetime: '2026-10-18T17:00:00+03:00' };
function context() {
  const evidence = createSlotEvidence();
  evidence.add('get_available_slots', input, { slots: [{ datetime: input.datetime }], staff_name: 'Тестовый специалист' });
  return { patientWatermark: nowMs / 1000 + 2, dialogKey: 'synthetic', clientPhone: 'test-owner', clientName: 'Тест', nowMs,
    liveBookings: [{ record_id: 501, service_yc_ids: [101], staff_yc_id: 7, datetime: '2026-10-09T16:00:00+03:00' }],
    slotEvidence: evidence, patientLastText: 'Да, старую запись не трогаем',
    patientRecentTexts: ['Хочу ещё один визит'], rescheduleRequested: true, requireStructuredAdditional: true };
}
async function delivered(ctx = context()) {
  const p = await prepare.run(1, input, ctx);
  expect(p.proposal_id).toBeTruthy();
  expect(proposals.markSent(1, ctx.dialogKey, p.proposal_id, [p.proposal_text], nowMs)).toBe(true);
  ctx.previousAssistantText = p.proposal_text;
  ctx.additionalProposalId = p.proposal_id;
  return { ctx, p, args: { ...input, proposal_id: p.proposal_id, patient_confirmed: true } };
}
beforeEach(() => {
  proposals._reset(); jest.clearAllMocks();
  catalog.run.mockResolvedValue({ services: [{ yc_id: 101, title: 'Тестовая услуга', staff: [{ yc_id: 7, name: 'Тестовый специалист' }] }] });
});
test('prepare uses verified catalog and slots without writing CRM', async () => {
  const p = await prepare.run(1, input, context());
  expect(p.proposal_text).toContain('18.10.2026 в 17:00');
  expect(p.proposal_text).toContain('Все прежние записи сохраняем');
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('delivered offer delegates consent despite negation of old transfer', async () => {
  const { ctx, args } = await delivered();
  expect((await create.run(1, args, ctx)).created).toBe(true);
  expect(booking.createBookingRecord).toHaveBeenCalledTimes(1);
});
test.each([
  ['flag false', { patient_confirmed: false }, {}, 'confirmation_flag_missing'],
  ['flag string', { patient_confirmed: 'true' }, {}, 'confirmation_flag_missing'],
  ['another date', { datetime: '2026-10-19T17:00:00+03:00' }, {}, 'proposal_target_changed'],
  ['another time', { datetime: '2026-10-18T18:00:00+03:00' }, {}, 'proposal_target_changed'],
  ['another service', { service_yc_id: 102 }, {}, 'proposal_target_changed'],
  ['another staff', { staff_yc_id: 8 }, {}, 'proposal_target_changed'],
  ['another duration', { seance_length: 7200 }, {}, 'proposal_target_changed'],
  ['another patient', { client_phone: 'synthetic-123' }, {}, 'proposal_patient_mismatch'],
  ['another id', { proposal_id: 'invented' }, {}, 'proposal_not_delivered_or_expired'],
  ['same turn', {}, { additionalProposalId: null }, 'proposal_not_delivered_or_expired'],
  ['other dialog', {}, { dialogKey: 'other' }, 'proposal_not_delivered_or_expired'],
  ['expired', {}, { nowMs: nowMs + proposals.TTL_MS }, 'proposal_not_delivered_or_expired'],
  ['different last reply', {}, { previousAssistantText: 'Другой вариант. Подтверждаете?' }, 'proposal_not_delivered_or_expired'],
  ['answer before sending', {}, { patientWatermark: nowMs / 1000 - 1 }, 'proposal_not_delivered_or_expired'],
  ['no patient answer', {}, { patientLastText: '' }, 'missing_context'],
  ['unverified CRM', {}, { liveBookings: null }, 'proposal_bookings_unverified'],
  ['changed CRM', {}, { liveBookings: [] }, 'proposal_bookings_changed'],
])('%s cannot authorize a write', async (_name, patch, contextPatch, reason) => {
  const { ctx, args } = await delivered();
  const result = await create.run(1, { ...args, ...patch }, { ...ctx, ...contextPatch });
  expect(result.confirmation_reason).toBe(reason);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('another tenant cannot use the proposal', async () => {
  const { ctx, args } = await delivered();
  expect((await create.run(2, args, ctx)).confirmation_reason).toBe('proposal_not_delivered_or_expired');
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('undelivered draft cannot authorize write even with its text in context', async () => {
  const ctx = context(); const p = await prepare.run(1, input, ctx);
  const out = await create.run(1, { ...input, proposal_id: p.proposal_id, patient_confirmed: true }, {
    ...ctx, additionalProposalId: p.proposal_id, previousAssistantText: p.proposal_text,
  });
  expect(out.confirmation_reason).toBe('proposal_not_delivered_or_expired');
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('new proposal invalidates previous consent, even with identical parameters', async () => {
  const { ctx, args } = await delivered(); await prepare.run(1, input, ctx);
  expect((await create.run(1, args, ctx)).confirmation_reason).toBe('proposal_not_delivered_or_expired');
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('restart fails closed', async () => {
  const { ctx, args } = await delivered(); proposals._reset();
  expect((await create.run(1, args, ctx)).confirmation_reason).toBe('proposal_not_delivered_or_expired');
});
test('prepare rejects slots for another service', async () => {
  const ctx = context(); ctx.slotEvidence = createSlotEvidence();
  ctx.slotEvidence.add('get_available_slots', { ...input, service_yc_id: 102 }, { slots: [{ datetime: input.datetime }] });
  expect((await prepare.run(1, input, ctx)).invalid_args).toBe(true);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('prepare fails closed without verified specialist', async () => {
  catalog.run.mockResolvedValue({ services: [] });
  expect((await prepare.run(1, input, context())).invalid_args).toBe(true);
});
test('retry after successful creation returns the CRM duplicate without another write', async () => {
  const { ctx, args } = await delivered();
  ctx.liveBookings.push({ record_id: 900, service_yc_ids: [101], staff_yc_id: 7, datetime: input.datetime });
  expect(await create.run(1, args, ctx)).toEqual({ created: false, duplicate: true, record_id: 900 });
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test.each(['Нет, новый визит не нужен', 'А сколько длится процедура?', 'Лучше другой день'])('model does not confirm refusal/question/change: %s', async patientLastText => {
  const { ctx, args } = await delivered();
  expect((await create.run(1, { ...args, patient_confirmed: false }, { ...ctx, patientLastText })).confirmation_reason).toBe('confirmation_flag_missing');
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test.each(['reschedule_booking', 'cancel_booking', 'modify_booking_services', 'book_chain', 'create_booking'])('additional consent cannot authorize %s without its exact proposal', tool => {
  expect(proposals.operationRejection(tool, { patient_confirmed: true }, { additionalProposalId: 'server-id' }).confirmation_reason).toBe('proposal_operation_changed');
});
test('a delivery response without the actual proposal text cannot activate it', async () => {
  const ctx = context(); const p = await prepare.run(1, input, ctx);
  expect(proposals.markSent(1, ctx.dialogKey, p.proposal_id, ['Другой ответ'], nowMs)).toBe(false);
});
test('alternate serialization of the same moment cannot change the idempotency key', async () => {
  const { ctx, args } = await delivered();
  expect((await create.run(1, { ...args, datetime: '2026-10-18T14:00:00Z' }, ctx)).confirmation_reason).toBe('proposal_target_changed');
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
