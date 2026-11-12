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

test('journal_operations accepts the delete action (v3 constraint, v2 block guarded)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'migrations.js'), 'utf8');
  expect(src).toContain("journal_operations_action_v3_check CHECK (action IN ('create','move','cancel','confirm','edit','delete'))");
  // The v2 block must not run again after v3 dropped the v2 constraint
  // (it would DROP a constraint that no longer exists and fail every start).
  expect(src).toMatch(/conname='journal_operations_action_v2_check'\)\s*AND NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conrelid='journal_operations'::regclass AND conname='journal_operations_action_v3_check'\)/);
});

test('journal_record_prefs DDL is additive and tenant-scoped', () => {
  const { JOURNAL_PREFS_DDL } = require('./migrations');
  expect(JOURNAL_PREFS_DDL).toContain('CREATE TABLE IF NOT EXISTS journal_record_prefs');
  expect(JOURNAL_PREFS_DDL).toContain('PRIMARY KEY (salon_id, yclients_record_id)');
  expect(JOURNAL_PREFS_DDL).toContain('notify_client BOOLEAN NOT NULL DEFAULT TRUE');
  expect(JOURNAL_PREFS_DDL).not.toMatch(/DROP|TRUNCATE|DELETE FROM|CREATE INDEX/);
});
