'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
const { db } = require('./db');
const h = require('./services/journal/history');
const base = { id: 8, datetime: '2026-11-12T10:00:00+03:00', staff: { id: 1, name: 'Юлия' }, staff_id: 1, seance_length: 3600, attendance: 0,
  services: [{ id: 7, title: 'Чистка', amount: 1, cost: 3000 }], comment: '', custom_color: '', record_labels: [], paid_full: 0, deleted: false,
  client: { name: 'Анна', phone: '79200255591', email: 'a@b.c' } };
beforeEach(() => jest.clearAllMocks());

describe('diffRecords', () => {
  test('no previous state → no changes (creation)', () => expect(h.diffRecords(null, base)).toEqual([]));
  test('time, master, services, length, status, comment, colour, labels, payment, deletion', () => {
    const next = { ...base, datetime: '2026-11-12T12:30:00+03:00', staff: { id: 2, name: 'Пери' }, staff_id: 2, seance_length: 4500, attendance: 2,
      services: [{ id: 7, title: 'Чистка', amount: 2, cost: 6000 }], comment: 'Позвонить', custom_color: 'F4A0A0',
      record_labels: [{ id: 3, title: 'VIP' }], paid_full: 1, deleted: true };
    expect(h.diffRecords(base, next).map(c => [c.label, c.from, c.to])).toEqual([
      ['Время', '12.11 10:00', '12.11 12:30'], ['Специалист', 'Юлия', 'Пери'], ['Услуги', 'Чистка — 3000 ₽', 'Чистка ×2 — 6000 ₽'],
      ['Длительность', '60 мин', '75 мин'], ['Статус', 'Ожидание', 'Подтвердил'], ['Комментарий', null, 'Позвонить'],
      ['Цвет', null, '#f4a0a0'], ['Метки', null, 'VIP'], ['Оплата', 'не оплачено', 'оплачено'], ['Удалена', 'нет', 'да'],
    ]);
  });
  test('client phone and email never appear', () => {
    const out = h.diffRecords(base, { ...base, client: { name: 'Другая', phone: '79000000000', email: 'x@y.z' } });
    expect(out).toEqual([]);
  });
});

describe('mergeHistory', () => {
  const hook = (at, status, data) => ({ created_at: new Date(at), status, data });
  test('webhooks diffed in order, empty repeats dropped; packages with author and step states; newest first', () => {
    const events = h.mergeHistory([
      hook('2026-11-12T07:00:00Z', 'create', base),
      hook('2026-11-12T07:05:00Z', 'update', base),
      hook('2026-11-12T07:10:00Z', 'update', { ...base, comment: 'Позвонить' }),
    ], [
      { id: 5, user_id: 4, status: 'failed', error_text: 'Время занято', created_at: new Date('2026-11-12T07:07:00Z'),
        steps: [{ kind: 'move', state: 'failed', draftJson: '{"client":{"phone":"79200255591"}}', params: { clientPhone: '79200255591' } }] },
    ], new Map([[4, 'Мария']]));
    expect(events.map(e => [e.source, e.title])).toEqual([
      ['yclients', 'Изменена в YClients'], ['journal', 'перенос — ошибка'], ['yclients', 'Создана в YClients'],
    ]);
    expect(events[0].changes).toEqual([{ field: 'comment', label: 'Комментарий', from: null, to: 'Позвонить' }]);
    expect(events[1]).toMatchObject({ author: 'LoyalPro: Мария', status: 'failed', steps: [{ kind: 'move', state: 'failed' }], error: 'Время занято' });
    expect(JSON.stringify(events)).not.toMatch(/79200255591|a@b\.c/);
  });
  test('cancelled package with empty steps does not crash', () => {
    const ev = h.mergeHistory([], [{ id: 1, user_id: 4, status: 'cancelled', steps: [], created_at: new Date('2026-11-12T07:00:00Z') }], new Map());
    expect(ev[0]).toMatchObject({ title: 'Удалена до отправки в YClients', steps: [], error: null, author: 'LoyalPro' });
    expect(() => h.mergeHistory([], [{ id: 2, status: 'failed', steps: null, created_at: new Date() }], new Map())).not.toThrow();
  });
  test('cap 200', () => {
    const many = Array.from({ length: 250 }, (_, i) => hook(new Date(Date.UTC(2026, 10, 12, 0, i)).toISOString(), 'update', { ...base, comment: 'c' + i }));
    expect(h.mergeHistory(many, [], new Map())).toHaveLength(200);
  });
});

describe('load', () => {
  test('salon-scoped queries; webhooks by record id as text; packages of the record and of its create', async () => {
    db.any.mockImplementation(async sql => {
      if (/FROM webhook_logs/.test(sql)) return [{ created_at: new Date('2026-11-12T07:00:00Z'), status: 'create', data: base }];
      if (/FROM journal_outbox/.test(sql)) return [{ id: 5, user_id: 4, status: 'done', steps: [{ kind: 'create', state: 'done' }], created_at: new Date('2026-11-12T06:59:00Z') }];
      if (/FROM users/.test(sql)) return [{ id: 4, name: 'Мария' }];
      return [];
    });
    const out = await h.load(3, 8);
    expect(out.recordId).toBe(8);
    expect(out.events.map(e => e.author)).toEqual(['YClients', 'LoyalPro: Мария']);
    const hooks = db.any.mock.calls.find(([sql]) => /FROM webhook_logs/.test(sql));
    expect(hooks[0]).toMatch(/event_type='record'/); expect(hooks[1]).toEqual([3, '8']);
    const outbox = db.any.mock.calls.find(([sql]) => /FROM journal_outbox/.test(sql));
    expect(outbox[1]).toEqual([3, 8, null]);
    expect(db.any.mock.calls.find(([sql]) => /FROM users/.test(sql))[1]).toEqual([3, [4]]);
  });
  test('negative id = unsent new record: its packages; webhooks of the created record once known', async () => {
    db.oneOrNone.mockResolvedValue({ yclients_record_id: '900' });
    db.any.mockResolvedValue([]);
    await h.load(3, -5);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([3, 5]);
    expect(db.any.mock.calls.find(([sql]) => /FROM journal_outbox/.test(sql))[1]).toEqual([3, 900, 5]);
    expect(db.any.mock.calls.find(([sql]) => /FROM webhook_logs/.test(sql))[1]).toEqual([3, '900']);
    db.oneOrNone.mockResolvedValue(null);
    await expect(h.load(3, -6)).rejects.toMatchObject({ status: 404 });
  });
});
