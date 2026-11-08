'use strict';
// Номера договоров (services/edocs/counter.js). SQL проверяется на дев-БД скриптом
// scripts/edocs-board-smoke.js; здесь — порядок источников номера и пропуск занятых.
const mockClient = { query: jest.fn() };
jest.mock('./db', () => ({
  db: { query: jest.fn(), oneOrNone: jest.fn() },
  withTransaction: jest.fn(async (fn) => fn(mockClient)),
}));
const { db } = require('./db');
const counter = require('./services/edocs/counter');

/** Ответы транзакции по тексту SQL: identity — строка client_identity, numbers — что вернёт UPDATE счётчика, taken — занятые номера. */
function script({ identity = { contract_no: null }, numbers = [1999], taken = [] } = {}) {
  const queue = numbers.slice();
  mockClient.query.mockImplementation(async (sql, params) => {
    if (/FROM client_identity WHERE salon_id=\$1 AND client_id=\$2 FOR UPDATE/.test(sql)) return { rows: identity ? [identity] : [] };
    if (/^INSERT INTO edoc_counters/.test(sql.trim())) return { rows: [] };
    if (/^UPDATE edoc_counters/.test(sql.trim())) return { rows: [{ no: queue.shift() }] };
    if (/UNION ALL SELECT 1 FROM client_identity/.test(sql)) return { rows: taken.includes(params[1]) ? [{ '?column?': 1 }] : [] };
    if (/^UPDATE client_identity SET contract_no/.test(sql.trim())) return { rows: [] };
    throw new Error(`неожиданный SQL: ${sql}`);
  });
}
const writes = () => mockClient.query.mock.calls.filter(([sql]) => /^UPDATE client_identity SET contract_no/.test(sql.trim())).map(([, p]) => p);

beforeEach(() => jest.clearAllMocks());

test('yclientsNumber: поле «Номер договора» карточки YClients', () => {
  expect(counter.yclientsNumber({ yclients_data: { custom_fields: { 'nomer-dogovra': ' 1859 ' } } })).toBe('1859');
  expect(counter.yclientsNumber({ yclients_data: { custom_fields: { 'nomer-dogovra': '' } } })).toBeNull();
  expect(counter.yclientsNumber({ yclients_data: {} })).toBeNull();
  expect(counter.yclientsNumber(null)).toBeNull();
});

test('номер уже в данных пациента — он и идёт, счётчик не трогается', async () => {
  script({ identity: { contract_no: '1739' } });
  expect(await counter.ensureContractNo({ salonId: 1, clientId: 52, client: {}, docDate: '2026-10-25' }))
    .toEqual({ contractNo: '1739', source: 'identity', assigned: false });
  expect(writes()).toEqual([]);
});

test('номер есть в YClients — переносится в данные пациента (дата договора = дата документа, если пуста)', async () => {
  script();
  const client = { yclients_data: { custom_fields: { 'nomer-dogovra': '1859' } } };
  expect(await counter.ensureContractNo({ salonId: 1, clientId: 52, client, docDate: '2026-10-25' }))
    .toEqual({ contractNo: '1859', source: 'yclients', assigned: true });
  expect(writes()).toEqual([[1, 52, '1859', '2026-10-25']]);
  expect(mockClient.query.mock.calls.some(([sql]) => /edoc_counters/.test(sql))).toBe(false);
});

test('номера нет нигде — следующий из счётчика (заводится по максимуму салона)', async () => {
  script({ numbers: [1999] });
  expect(await counter.ensureContractNo({ salonId: 1, clientId: 52, client: { yclients_data: {} }, docDate: '2026-10-25' }))
    .toEqual({ contractNo: '1999', source: 'counter', assigned: true });
  const insert = mockClient.query.mock.calls.find(([sql]) => /^INSERT INTO edoc_counters/.test(sql.trim()));
  expect(insert[0]).toMatch(/GREATEST/);
  expect(insert[0]).toMatch(/ON CONFLICT \(salon_id, kind\) DO NOTHING/);
  expect(writes()).toEqual([[1, 52, '1999', '2026-10-25']]);
});

test('занятый номер (выдан вручную в YClients) пропускается', async () => {
  script({ numbers: [1999, 2000, 2001], taken: ['1999', '2000'] });
  expect((await counter.ensureContractNo({ salonId: 1, clientId: 52, client: {}, docDate: null })).contractNo).toBe('2001');
  expect(writes()).toEqual([[1, 52, '2001', null]]);
});

test('данных пациента нет — 400: сначала сохранить данные', async () => {
  script({ identity: null });
  await expect(counter.ensureContractNo({ salonId: 1, clientId: 52, client: {}, docDate: null })).rejects.toMatchObject({ code: 'missing_fields', status: 400 });
});

test('setNext: целое от 1; peek — следующий без записи', async () => {
  await expect(counter.setNext(1, 0)).rejects.toMatchObject({ code: 'bad_counter' });
  await expect(counter.setNext(1, '1.5')).rejects.toMatchObject({ code: 'bad_counter' });
  expect(await counter.setNext(1, '2100')).toBe(2100);
  expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/ON CONFLICT \(salon_id, kind\) DO UPDATE/), [1, 'contract', 2100]);
  db.oneOrNone.mockResolvedValueOnce(null);
  db.query.mockResolvedValueOnce({ rows: [{ max_used: '1998' }] });
  expect(await counter.peek(1)).toEqual({ next: 1999, maxUsed: 1998 });
  db.oneOrNone.mockResolvedValueOnce({ next_value: '2100' });
  db.query.mockResolvedValueOnce({ rows: [{ max_used: '1998' }] });
  expect(await counter.peek(1)).toEqual({ next: 2100, maxUsed: 1998 });
});
