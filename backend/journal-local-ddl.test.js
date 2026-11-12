'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'x' }));
test('local-first DDL is additive and tenant-scoped', () => {
  const { JOURNAL_LOCAL_DDL } = require('./migrations');
  for (const t of ['journal_staff_schedule', 'journal_reference_cache', 'journal_mirror_state', 'journal_outbox'])
    expect(JOURNAL_LOCAL_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
  expect(JOURNAL_LOCAL_DDL).toContain('UNIQUE(salon_id,session_id)');
  expect(JOURNAL_LOCAL_DDL).toMatch(/status IN \('queued','running','done','failed','cancelled'\)/);
  expect(JOURNAL_LOCAL_DDL).not.toMatch(/DROP|TRUNCATE|DELETE FROM/);
});
test('flags default on and switch off only by the string false', () => {
  jest.resetModules(); jest.unmock('./config');
  const prev = { a: process.env.JOURNAL_LOCAL_FIRST, b: process.env.JOURNAL_OUTBOX };
  process.env.JOURNAL_LOCAL_FIRST = 'false'; delete process.env.JOURNAL_OUTBOX;
  const c = require('./config');
  expect(c.JOURNAL_LOCAL_FIRST).toBe(false); expect(c.JOURNAL_OUTBOX).toBe(true);
  if (prev.a === undefined) delete process.env.JOURNAL_LOCAL_FIRST; else process.env.JOURNAL_LOCAL_FIRST = prev.a;
  if (prev.b === undefined) delete process.env.JOURNAL_OUTBOX; else process.env.JOURNAL_OUTBOX = prev.b;
});
