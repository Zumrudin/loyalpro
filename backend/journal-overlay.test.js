'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
const { applyOverlay } = require('./services/journal/overlay');
const m = require('./services/journal/model');
const NOW = Date.parse('2030-04-01T12:00:00Z');
const rec = { id: 8, staff_id: 1, datetime: '2030-04-01T10:00:00+03:00', seance_length: 3600, services: [{ id: 7, title: 'A', cost: 500 }], client: { name: 'Тест' }, attendance: 0 };
const createOverlay = { kind: 'create', date: '2030-04-01', time: '11:30', duration: 45, staffId: 2, services: [{ id: 7, title: 'A', cost: 500 }], client: { name: 'Новая', phone: '79000000000' }, comment: 'c' };
const row = (over) => ({ id: 5, salon_id: 3, status: 'queued', yclients_record_id: null, overlay: createOverlay, updated_at: new Date(NOW).toISOString(), ...over });

test('create without record id → synthetic negative-id record with sync', () => {
  const input = [rec];
  const out = applyOverlay(input, [row({})], NOW);
  expect(input).toEqual([rec]);
  expect(out).toHaveLength(2);
  expect(out[1]).toMatchObject({ id: -5, datetime: '2030-04-01T11:30:00+03:00', seance_length: 2700, staff_id: 2, client: { name: 'Новая', phone: '79000000000' }, comment: 'c', attendance: 0, deleted: false });
  expect(out[1]._sync).toEqual({ outboxId: 5, status: 'queued', errorText: null, errorCode: null, failedStep: null, released: false });
});
test('create whose record already arrived → no duplicate, sync attached', () => {
  const out = applyOverlay([rec], [row({ status: 'running', yclients_record_id: '8' })], NOW);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ id: 8, datetime: rec.datetime });
  expect(out[0]._sync.status).toBe('running');
  expect(rec._sync).toBeUndefined();
});
test('patch move replaces fields; latest row wins sync', () => {
  const rows = [
    row({ id: 12, status: 'failed', yclients_record_id: 8, error_text: 'Занято', error_code: 'busy', failed_step: 1, overlay: { kind: 'patch', patch: { datetime: '2030-04-01T15:00:00+03:00', staff_id: 3 } } }),
    row({ id: 11, yclients_record_id: 8, overlay: { kind: 'patch', patch: { datetime: '2030-04-01T14:00:00+03:00', seance_length: 1800 } } }),
  ];
  const [out] = applyOverlay([rec], rows, NOW);
  expect(out).toMatchObject({ datetime: '2030-04-01T15:00:00+03:00', staff_id: 3, seance_length: 1800 });
  expect(out._sync).toEqual({ outboxId: 12, status: 'failed', errorText: 'Занято', errorCode: 'busy', failedStep: 1, released: false });
  expect(rec.datetime).toBe('2030-04-01T10:00:00+03:00');
});
test('cancel patch → attendance -1', () => {
  const [out] = applyOverlay([rec], [row({ yclients_record_id: 8, overlay: { kind: 'patch', patch: { cancel: true } } })], NOW);
  expect(out.attendance).toBe(-1);
});
test('cancelled and old done rows are ignored', () => {
  const old = new Date(NOW - 6 * 60000).toISOString();
  const out = applyOverlay([rec], [row({ status: 'cancelled' }), row({ id: 6, status: 'done', updated_at: old }), row({ id: 7, status: 'done', yclients_record_id: 8, updated_at: old, overlay: { kind: 'patch', patch: { cancel: true } } })], NOW);
  expect(out).toEqual([rec]);
});
test('recent done whose record is not yet mirrored → synthetic with the real id', () => {
  const out = applyOverlay([rec], [row({ status: 'done', yclients_record_id: 99, updated_at: new Date(NOW - 60000) })], NOW);
  expect(out).toHaveLength(2);
  expect(out[1]).toMatchObject({ id: 99 });
  expect(out[1]._sync.status).toBe('done');
});
test('recent done whose record already arrived → mirror is the truth', () => {
  const out = applyOverlay([rec], [row({ status: 'done', yclients_record_id: 8, overlay: { kind: 'patch', patch: { cancel: true } } })], NOW);
  expect(out).toEqual([rec]);
});
test('normalizeRecord exposes sync', () => {
  const out = applyOverlay([], [row({})], NOW);
  const n = m.normalizeRecord(out[0]);
  expect(n.id).toBe(-5);
  expect(n.sync).toMatchObject({ outboxId: 5, status: 'queued' });
  expect(m.normalizeRecord(rec).sync).toBeNull();
  expect(m.revision(out[0])).toBe(m.revision({ ...out[0], _sync: undefined }));
});
describe('done patch stays on until the mirror catches up (10.11.2026)', () => {
  const created = new Date(NOW - 30000).toISOString();
  const done = (over) => row({ status: 'done', yclients_record_id: 8, created_at: created, updated_at: new Date(NOW - 20000).toISOString(), overlay: { kind: 'patch', patch: { attendance: 1 } }, ...over });
  test('mirror older than the package (webhook not arrived) → overlay applied', () => {
    const [out] = applyOverlay([{ ...rec, last_change_date: '2030-04-01T14:50:00+0300' }], [done()], NOW);
    expect(out.attendance).toBe(1);
    expect(out._sync.status).toBe('done');
  });
  test('mirror changed after the package was created → mirror is the truth', () => {
    const [out] = applyOverlay([{ ...rec, attendance: 2, last_change_date: '2030-04-01T14:59:45+0300' }], [done()], NOW);
    expect(out.attendance).toBe(2);
  });
});

test('change of an unsent new record lands on its synthetic record (manual dispatch)', () => {
  const create = row({ id: 5, status: 'queued' });
  const child = { id: 9, status: 'queued', yclients_record_id: null, create_outbox_id: 5, created_at: NOW, updated_at: NOW,
    overlay: { kind: 'patch', patch: { attendance: 1 } }, steps: [] };
  const out = applyOverlay([], [create, child], NOW);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ id: -5, attendance: 1 });
  expect(out[0]._sync).toMatchObject({ outboxId: 9, released: false });
});
test('patch carries parity fields (12.11.2026)', () => {
  const p = { comment: 'Позвонить', client: { name: 'Новый', phone: '79200255591' }, custom_color: '#f4a0a0', record_labels: [3],
    technical_break_duration: 600, notify_client: false, seance_length: 4500 };
  const [out] = applyOverlay([rec], [row({ yclients_record_id: 8, overlay: { kind: 'patch', patch: p } })], NOW);
  expect(out).toMatchObject(p);
  expect(m.normalizeRecord(out)).toMatchObject({ comment: 'Позвонить', clientName: 'Новый', customColor: '#f4a0a0',
    labels: [{ id: 3, title: '', color: '' }], technicalBreak: 600, duration: 75 });
});
