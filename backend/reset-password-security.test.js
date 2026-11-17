'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('bcryptjs', () => ({ hash: jest.fn(async () => 'synthetic-hash') }));

const { main, readPrivateFile } = require('./reset-password');

let directory;
let emailFile;
let passwordFile;

beforeEach(() => {
  jest.restoreAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalpro-reset-test-'));
  emailFile = path.join(directory, 'email');
  passwordFile = path.join(directory, 'password');
  fs.writeFileSync(emailFile, 'operator@example.test\n', { mode: 0o600 });
  fs.writeFileSync(passwordFile, 'private-new-password\n', { mode: 0o600 });
});

afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

function database(name = 'loyalpro_test') {
  const client = {
    query: jest.fn(async sql => {
      if (sql === 'SELECT current_database() AS name') return { rows: [{ name }] };
      if (sql.startsWith('SELECT id')) return { rows: [{ id: 17 }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client), end: jest.fn(async () => {}) };
  return { client, pool };
}

test('module import is safe and does not load dotenv or the database', () => {
  jest.isolateModules(() => {
    jest.doMock('dotenv', () => { throw new Error('dotenv loaded during import'); });
    jest.doMock('./db', () => { throw new Error('database loaded during import'); });
    expect(require('./reset-password')).toEqual(expect.objectContaining({
      main: expect.any(Function), resetPassword: expect.any(Function),
    }));
  });
});

test('rejects legacy secret argv and insecure input permissions before database access', async () => {
  const db = database();
  await expect(main([
    'operator@example.test', 'private-new-password', '--confirm-database=loyalpro_test',
  ], { pool: db.pool })).rejects.toThrow();
  expect(db.pool.connect).not.toHaveBeenCalled();

  fs.chmodSync(passwordFile, 0o644);
  expect(() => readPrivateFile(passwordFile, 'password')).toThrow(/group or other users/);
  await expect(main([
    emailFile, passwordFile, '--confirm-database=loyalpro_test',
  ], { pool: db.pool })).rejects.toThrow(/group or other users/);
  expect(db.pool.connect).not.toHaveBeenCalled();
});

test('database mismatch performs no mutation and still releases resources', async () => {
  const db = database('different_database');
  await expect(main([
    emailFile, passwordFile, '--confirm-database=loyalpro_test',
  ], { pool: db.pool })).rejects.toThrow('database mismatch');
  expect(db.client.query).toHaveBeenCalledTimes(1);
  expect(db.client.release).toHaveBeenCalledTimes(1);
  expect(db.pool.end).toHaveBeenCalledTimes(1);
});

test('successful main redacts credentials and releases resources', async () => {
  const db = database();
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  await main([emailFile, passwordFile, '--confirm-database=loyalpro_test'], { pool: db.pool });
  const output = log.mock.calls.flat().join(' ');
  expect(output).not.toContain('operator@example.test');
  expect(output).not.toContain('private-new-password');
  expect(db.client.query).toHaveBeenCalledWith('DELETE FROM sessions WHERE user_id=$1', [17]);
  expect(db.client.release).toHaveBeenCalledTimes(1);
  expect(db.pool.end).toHaveBeenCalledTimes(1);
});

test('main releases resources when the reset transaction fails', async () => {
  const db = database();
  db.client.query.mockImplementation(async sql => {
    if (sql === 'SELECT current_database() AS name') return { rows: [{ name: 'loyalpro_test' }] };
    if (sql.startsWith('SELECT id')) return { rows: [{ id: 17 }] };
    if (sql.startsWith('DELETE FROM sessions')) throw new Error('synthetic failure');
    return { rows: [] };
  });
  await expect(main([
    emailFile, passwordFile, '--confirm-database=loyalpro_test',
  ], { pool: db.pool })).rejects.toThrow('synthetic failure');
  expect(db.client.query.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  expect(db.client.release).toHaveBeenCalledTimes(1);
  expect(db.pool.end).toHaveBeenCalledTimes(1);
});

test('main closes the pool when acquiring a client fails', async () => {
  const db = database();
  db.pool.connect.mockRejectedValue(new Error('synthetic connection failure'));
  await expect(main([
    emailFile, passwordFile, '--confirm-database=loyalpro_test',
  ], { pool: db.pool })).rejects.toThrow('synthetic connection failure');
  expect(db.client.release).not.toHaveBeenCalled();
  expect(db.pool.end).toHaveBeenCalledTimes(1);
});
