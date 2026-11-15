'use strict';
const { PassThrough } = require('stream');
const ExcelJS = require('exceljs');
jest.mock('./db', () => ({ pool: { connect: jest.fn() }, db: {} }));
jest.mock('./services/stock/operations', () => ({ listOperations: jest.fn() }), { virtual: true });
const { pool } = require('./db');
const { listOperations } = require('./services/stock/operations');
const { exportOperations, excelRow } = require('./services/stock/operations-export');

function response() {
  const stream = new PassThrough();
  stream.setHeader = jest.fn();
  const chunks = [];
  stream.on('data', b => chunks.push(b));
  return { stream, buffer: () => Buffer.concat(chunks) };
}
let client;
beforeEach(() => {
  jest.clearAllMocks();
  client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
  pool.connect.mockResolvedValue(client);
});

test('XLSX exports every matching page in one snapshot, with typed numbers and literal text', async () => {
  const row = { id: 1, occurred_at: '2026-11-14T22:30:00Z', document_number: '90001',
    good_title: '=HYPERLINK("x")', comment: '+SUM(1)', qty_pack: '-0.0001', qty_base: '-0.01',
    cost_basis: '3.20', balance_after: '0', kind: 'consumable', payment_status: 'not_applicable' };
  listOperations.mockResolvedValueOnce({ operations: Array.from({ length: 100 }, () => row), total: 101 })
    .mockResolvedValueOnce({ operations: [{ ...row, document_number: '90002' }], total: 101 });
  const res = response();
  await exportOperations(7, { search: 'filter', page: 9, limit: 25 }, res.stream);
  expect(client.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(listOperations.mock.calls.map(c => [c[0], c[1]])).toEqual([
    [7, { search: 'filter', page: 1, limit: 100 }], [7, { search: 'filter', page: 2, limit: 100 }],
  ]);
  expect(listOperations.mock.calls[1][2].query).toBe(listOperations.mock.calls[0][2].query);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(res.buffer());
  const sheet = book.worksheets[0];
  expect(sheet.rowCount).toBe(102);
  expect(sheet.getCell('A2').value).toContain('15.11.2026');
  expect(sheet.getCell('G2').value).toBe("'=HYPERLINK(\"x\")");
  expect(sheet.getCell('I2').value).toBe(-0.0001);
  expect(sheet.getCell('M2').value).toBe(3.2);
  expect(sheet.getCell('N2').value).toBe(0);
  expect(sheet.getCell('B102').value).toBe('90002');
  expect(client.query).toHaveBeenCalledWith('COMMIT');
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('missing costs stay empty and zero cost stays numeric zero', () => {
  expect(excelRow({ cost_basis: null })[12]).toBeNull();
  expect(excelRow({ cost_basis: 0 })[12]).toBe(0);
});

test('rejects excessive XLSX rows before sending headers and releases transaction', async () => {
  listOperations.mockResolvedValue({ total: 1048576, operations: [] });
  const res = response();
  await expect(exportOperations(7, {}, res.stream)).rejects.toMatchObject({ code: 'export_too_large' });
  expect(res.stream.setHeader).not.toHaveBeenCalled();
  expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('database failure releases connection and rolls back', async () => {
  listOperations.mockRejectedValue(new Error('synthetic failure'));
  await expect(exportOperations(7, {}, response().stream)).rejects.toThrow('synthetic failure');
  expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  expect(client.release).toHaveBeenCalledTimes(1);
});
