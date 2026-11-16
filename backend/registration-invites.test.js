'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret'.repeat(3), REGISTRATION_MODE: 'invite' }));
const invites = require('./services/registration-invites');
const config = require('./config');

test('invitation is email-bound, only hashes reach storage', async () => {
  const conn = { query: jest.fn().mockResolvedValue({ rows: [{ token_hash: 'matched' }] }) };
  const token = await invites.issue(conn, 'Synthetic@Example.invalid');
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const issued = conn.query.mock.calls[0][1];
  expect(issued.slice(0, 2).every(x => /^[a-f0-9]{64}$/.test(x))).toBe(true);
  await invites.consume(conn, token, 'synthetic@example.invalid');
  expect(conn.query.mock.calls[1][1]).toEqual(issued.slice(0, 2));
  expect(conn.query.mock.calls[1][0]).toContain('used_at IS NULL AND expires_at>NOW()');
  expect(JSON.stringify(conn.query.mock.calls)).not.toContain(token);
});

test('invalid, consumed, expired or differently-bound invitations fail closed', async () => {
  const conn = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  await expect(invites.consume(conn, '', 'a@example.invalid')).rejects.toMatchObject({ status: 403 });
  expect(conn.query).not.toHaveBeenCalled();
  await expect(invites.consume(conn, 'a'.repeat(43), 'b@example.invalid')).rejects.toMatchObject({ status: 403 });
  config.REGISTRATION_MODE = 'typo';
  await expect(invites.consume(conn, 'a'.repeat(43), 'b@example.invalid')).rejects.toMatchObject({ status: 403 });
  config.REGISTRATION_MODE = 'invite';
});
