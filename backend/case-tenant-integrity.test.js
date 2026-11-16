'use strict';
const { CASE_TENANT_INTEGRITY_DDL, runMigrations } = require('./migrations');

const fkNames = [
  'fk_case_courses_salon_client',
  'fk_case_visits_salon_client',
  'fk_case_photos_salon_visit',
  'fk_case_comments_salon_visit',
];

test('required case relationships use composite, non-validated additive FKs', () => {
  for (const name of fkNames) {
    expect(CASE_TENANT_INTEGRITY_DDL).toContain(`conname='${name}'`);
    expect(CASE_TENANT_INTEGRITY_DDL).toContain(`ADD CONSTRAINT ${name}`);
  }
  expect(CASE_TENANT_INTEGRITY_DDL).toContain('FOREIGN KEY (salon_id, client_id) REFERENCES clients (salon_id, id) ON DELETE CASCADE NOT VALID');
  expect(CASE_TENANT_INTEGRITY_DDL).toContain('FOREIGN KEY (salon_id, case_visit_id) REFERENCES case_visits (salon_id, id) ON DELETE CASCADE NOT VALID');
  expect(CASE_TENANT_INTEGRITY_DDL).not.toContain('VALIDATE CONSTRAINT');
});

test('optional case links use tenant/client triggers without a composite SET NULL FK', () => {
  expect(CASE_TENANT_INTEGRITY_DDL).toContain('c.client_id=NEW.client_id');
  expect(CASE_TENANT_INTEGRITY_DDL).toContain('(r.client_id IS NULL OR r.client_id=NEW.client_id)');
  expect(CASE_TENANT_INTEGRITY_DDL).toContain('u.id=NEW.specialist_user_id AND u.salon_id=NEW.salon_id');
  expect(CASE_TENANT_INTEGRITY_DDL).toContain('u.id=NEW.author_user_id AND u.salon_id=NEW.salon_id');
  expect(CASE_TENANT_INTEGRITY_DDL).toContain('BEFORE INSERT OR UPDATE OF salon_id, client_id, course_id, record_id, specialist_user_id ON case_visits');
  expect(CASE_TENANT_INTEGRITY_DDL).not.toContain('(salon_id, course_id)');
  expect(CASE_TENANT_INTEGRITY_DDL).not.toContain('(salon_id, record_id)');
  expect(CASE_TENANT_INTEGRITY_DDL).not.toContain('(salon_id, specialist_user_id)');
});

test('a failed case integrity migration is not swallowed', async () => {
  const error = new Error('synthetic-migration-failure');
  const client = { query: jest.fn(async sql => {
    if (sql === CASE_TENANT_INTEGRITY_DDL) throw error;
    return { rows: [] };
  }) };
  await expect(runMigrations(client)).rejects.toBe(error);
  expect(client.query).toHaveBeenCalledWith(CASE_TENANT_INTEGRITY_DDL);
});

const {
  AUDIT_COLUMNS,
  AUDIT_SQL,
  CONSTRAINTS,
  CURRENT_DATABASE_SQL,
  LOCK_TIMEOUT_SQL,
  STATEMENT_TIMEOUT_SQL,
  assertNoSyntheticSalonResidue,
  buildDeletionScenarios,
  buildValidateRunbook,
  buildWriteScenarios,
  constraintStateSql,
  parseArgs,
  reportMainError,
  runE2E,
  validateConstraintSql,
  validateConstraints,
} = require('./scripts/case-tenant-integrity-e2e');

const zeroAudit = () => Object.fromEntries(AUDIT_COLUMNS.map(column => [column, 0]));
const sqlCalls = query => query.mock.calls.map(([sql]) => sql);

function mockValidationClient({
  database = 'loyalpro_test',
  audit = zeroAudit(),
  failOn = null,
  missing = null,
  remainInvalid = false,
  alreadyValid = false,
} = {}) {
  const validated = new Set(alreadyValid ? CONSTRAINTS.map(({ name }) => name) : []);
  const client = { query: jest.fn(async sql => {
    if (sql === CURRENT_DATABASE_SQL) return { rows: [{ name: database }] };
    if (sql === AUDIT_SQL) return { rows: [{ ...audit }] };
    const constraint = CONSTRAINTS.find(item => constraintStateSql(item) === sql);
    if (constraint) {
      if (constraint.name === missing) return { rows: [] };
      return { rows: [{ convalidated: !remainInvalid && validated.has(constraint.name) }] };
    }
    const alter = CONSTRAINTS.find(item => validateConstraintSql(item) === sql);
    if (alter) {
      if (alter.name === failOn) throw new Error('synthetic-validate-failure');
      validated.add(alter.name);
    }
    return { rows: [] };
  }) };
  return { client, query: client.query };
}

test('aggregate audit exposes exactly the seven required counters', () => {
  expect(AUDIT_COLUMNS).toEqual([
    'bad_course_client',
    'bad_visit_client',
    'bad_visit_course',
    'bad_visit_record',
    'bad_visit_specialist',
    'bad_photo_visit',
    'bad_comment_visit',
  ]);
  expect(AUDIT_SQL.match(/count\(\*\)::int/g)).toHaveLength(7);
  for (const column of AUDIT_COLUMNS) {
    expect(AUDIT_SQL).toContain(`AS ${column}`);
  }
  expect(AUDIT_SQL).not.toContain('SELECT *');
  expect(AUDIT_SQL).not.toContain('RETURNING');
});

test('executed write matrix covers valid writes and every cross-tenant INSERT/UPDATE', () => {
  const scenarios = buildWriteScenarios({}, () => -1);
  expect(scenarios.map(({ name }) => name)).toEqual([
    'valid_tenant_a_insert_update',
    'valid_tenant_b_insert',
    'valid_nullable_record_insert',
    'course_client_insert_cross_tenant',
    'course_client_update_cross_tenant',
    'visit_client_insert_cross_tenant',
    'visit_client_update_cross_tenant',
    'visit_course_insert_cross_tenant',
    'visit_course_update_cross_tenant',
    'visit_course_insert_other_client',
    'visit_course_update_other_client',
    'visit_record_insert_cross_tenant',
    'visit_record_update_cross_tenant',
    'visit_record_insert_other_client',
    'visit_record_update_other_client',
    'visit_specialist_insert_cross_tenant',
    'visit_specialist_update_cross_tenant',
    'photo_visit_insert_cross_tenant',
    'photo_visit_update_cross_tenant',
    'comment_visit_insert_cross_tenant',
    'comment_visit_update_cross_tenant',
    'comment_author_insert_cross_tenant',
    'comment_author_update_cross_tenant',
    'course_salon_update_cross_tenant',
    'visit_salon_update_cross_tenant',
    'photo_salon_update_cross_tenant',
    'comment_salon_update_cross_tenant',
  ]);
  const rejected = scenarios.filter(({ kind }) => kind === 'rejected');
  expect(rejected).toHaveLength(24);
  for (const scenario of rejected) {
    expect(scenario.expected.sqlstate).toBe('23503');
    expect(scenario.expected.constraint || scenario.expected.message).toBeTruthy();
  }
  for (const relationship of ['client', 'course', 'record', 'specialist', 'photo', 'comment']) {
    const crossTenant = rejected.filter(item => item.relationship === relationship && item.name.includes('cross_tenant'));
    expect([...new Set(crossTenant.map(({ operation }) => operation))].sort()).toEqual(['INSERT', 'UPDATE']);
  }
  expect(scenarios.filter(({ name }) => name.includes('other_client'))).toHaveLength(4);
  expect(rejected.filter(({ relationship }) => relationship === 'salon')
    .map(({ name, expected }) => [name, expected.constraint || expected.message])).toEqual([
    ['course_salon_update_cross_tenant', 'fk_case_courses_salon_client'],
    ['visit_salon_update_cross_tenant', 'case visit course tenant/client mismatch'],
    ['photo_salon_update_cross_tenant', 'fk_case_photos_salon_visit'],
    ['comment_salon_update_cross_tenant', 'case comment author tenant mismatch'],
  ]);
  expect(scenarios.find(({ name }) => name === 'comment_author_insert_cross_tenant').expected.message)
    .toBe('case comment author tenant mismatch');
});

test('delete matrix covers SET NULL, bounded cascades, and parent preservation', () => {
  expect(buildDeletionScenarios({}).map(({ name }) => name)).toEqual([
    'course_delete_set_null',
    'record_delete_set_null',
    'specialist_delete_set_null',
    'client_delete_cascades_case_graph',
    'salon_delete_cascades_case_graph',
    'visit_delete_cascades_only_children',
  ]);
});

test('E2E rejects a non-test database before BEGIN or any write', async () => {
  const client = { query: jest.fn(async () => ({ rows: [{ name: 'unexpected_database' }] })) };
  await expect(runE2E(client)).rejects.toThrow('database guard rejected the connection');
  expect(client.query).toHaveBeenCalledTimes(1);
  expect(client.query).toHaveBeenCalledWith(CURRENT_DATABASE_SQL);
  expect(sqlCalls(client.query).join('\n')).not.toMatch(/BEGIN|INSERT|UPDATE|DELETE|ALTER/);
});

test('main error reporting never prints raw DB or provider details', () => {
  const log = jest.fn();
  const dbError = Object.assign(new Error('raw-db-message-marker'), {
    code: '42P01', detail: 'raw-db-detail-marker',
  });
  const providerError = Object.assign(new Error('raw-provider-message-marker'), {
    code: 'ECONNRESET', detail: 'raw-provider-detail-marker',
  });
  reportMainError(dbError, log);
  reportMainError(providerError, log);
  expect(log.mock.calls).toEqual([
    ['case tenant integrity failed: 42P01'],
    ['case tenant integrity failed: ECONNRESET'],
  ]);
  const output = JSON.stringify(log.mock.calls);
  expect(output).not.toContain('raw-db-message-marker');
  expect(output).not.toContain('raw-db-detail-marker');
  expect(output).not.toContain('raw-provider-message-marker');
  expect(output).not.toContain('raw-provider-detail-marker');
});

test('post-rollback residue check uses only synthetic salon IDs and requires zero', async () => {
  const sql = 'SELECT count(*)::int AS residue_count FROM public.salons WHERE id=$1 OR id=$2';
  const client = { query: jest.fn(async () => ({ rows: [{ residue_count: 0 }] })) };
  await expect(assertNoSyntheticSalonResidue(client, { salonA: -101, salonB: -102 })).resolves.toBe(0);
  expect(client.query).toHaveBeenCalledWith(sql, [-101, -102]);
  client.query.mockResolvedValue({ rows: [{ residue_count: 1 }] });
  await expect(assertNoSyntheticSalonResidue(client, { salonA: -101, salonB: -102 }))
    .rejects.toThrow('synthetic salon residue detected');
});

test('CLI accepts only fixed modes and exact database confirmation', () => {
  expect(parseArgs([])).toEqual({ mode: 'audit' });
  expect(parseArgs(['--e2e'])).toEqual({ mode: 'e2e' });
  expect(parseArgs(['--validate-constraints', '--confirm-database=loyalpro_test']))
    .toEqual({ mode: 'validate', database: 'loyalpro_test' });
  expect(() => parseArgs(['--e2e', '--salon-id=1'])).toThrow('usage:');
  expect(() => parseArgs(['--validate-constraints', '--confirm-database=other'])).toThrow('usage:');
});

test('validation executes the exact four statements in order with local timeouts', async () => {
  const { client, query } = mockValidationClient();
  const onEvent = jest.fn();
  await expect(validateConstraints(client, 'loyalpro_test', onEvent)).resolves.toEqual(CONSTRAINTS.map(({ name }) => name));
  const calls = sqlCalls(query);
  expect(calls[0]).toBe(CURRENT_DATABASE_SQL);
  expect(calls[1]).toBe(AUDIT_SQL);
  expect(calls.filter(sql => sql.startsWith('ALTER TABLE')))
    .toEqual(CONSTRAINTS.map(validateConstraintSql));
  expect(calls.filter(sql => sql === 'BEGIN')).toHaveLength(4);
  expect(calls.filter(sql => sql === 'COMMIT')).toHaveLength(4);
  expect(calls.filter(sql => sql === LOCK_TIMEOUT_SQL)).toHaveLength(4);
  expect(calls.filter(sql => sql === STATEMENT_TIMEOUT_SQL)).toHaveLength(4);
  expect(calls).not.toContain('ROLLBACK');
  expect(onEvent.mock.calls.map(([message]) => message)).toHaveLength(4);
  for (const [index, [message]] of onEvent.mock.calls.entries()) {
    expect(message).toMatch(new RegExp(`^${CONSTRAINTS[index].name}: validated, duration_ms=\\d+$`));
    expect(message).not.toMatch(/SELECT|ALTER|convalidated/);
  }
});

test('nonzero audit blocks VALIDATE before BEGIN', async () => {
  const audit = { ...zeroAudit(), bad_visit_record: 1 };
  const { client, query } = mockValidationClient({ audit });
  await expect(validateConstraints(client, 'loyalpro_test')).rejects.toThrow('audit must be all zero');
  expect(sqlCalls(query)).toEqual([CURRENT_DATABASE_SQL, AUDIT_SQL]);
});

test('validation database confirmation must exactly match the connected database', async () => {
  const { client, query } = mockValidationClient();
  await expect(validateConstraints(client, 'loyalpro')).rejects.toThrow('database guard rejected the connection');
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(CURRENT_DATABASE_SQL);
});

test('second validation failure rolls back its step and stops before later constraints', async () => {
  const { client, query } = mockValidationClient({ failOn: CONSTRAINTS[1].name });
  await expect(validateConstraints(client, 'loyalpro_test')).rejects.toThrow('synthetic-validate-failure');
  const calls = sqlCalls(query);
  expect(calls.filter(sql => sql.startsWith('ALTER TABLE')))
    .toEqual(CONSTRAINTS.slice(0, 2).map(validateConstraintSql));
  expect(calls.filter(sql => sql === 'BEGIN')).toHaveLength(2);
  expect(calls.filter(sql => sql === 'COMMIT')).toHaveLength(1);
  expect(calls.filter(sql => sql === 'ROLLBACK')).toHaveLength(1);
  expect(calls[calls.length - 1]).toBe('ROLLBACK');
  expect(calls.join('\n')).not.toContain(CONSTRAINTS[2].name);
  expect(calls.join('\n')).not.toContain(CONSTRAINTS[3].name);
});

test('missing constraint fails closed without VALIDATE', async () => {
  const { client, query } = mockValidationClient({ missing: CONSTRAINTS[0].name });
  await expect(validateConstraints(client, 'loyalpro_test')).rejects.toThrow(`missing constraint: ${CONSTRAINTS[0].name}`);
  const calls = sqlCalls(query);
  expect(calls.some(sql => sql.startsWith('ALTER TABLE'))).toBe(false);
  expect(calls[calls.length - 1]).toBe('ROLLBACK');
});

test('convalidated=false after VALIDATE rolls back and stops', async () => {
  const { client, query } = mockValidationClient({ remainInvalid: true });
  await expect(validateConstraints(client, 'loyalpro_test')).rejects.toThrow(`constraint is still NOT VALID: ${CONSTRAINTS[0].name}`);
  const calls = sqlCalls(query);
  expect(calls.filter(sql => sql.startsWith('ALTER TABLE'))).toEqual([validateConstraintSql(CONSTRAINTS[0])]);
  expect(calls[calls.length - 1]).toBe('ROLLBACK');
});

test('already validated constraints are checked and skipped without ALTER', async () => {
  const { client, query } = mockValidationClient({ alreadyValid: true });
  await expect(validateConstraints(client, 'loyalpro_test')).resolves.toEqual(CONSTRAINTS.map(({ name }) => name));
  const calls = sqlCalls(query);
  expect(calls.some(sql => sql.startsWith('ALTER TABLE'))).toBe(false);
  expect(calls.filter(sql => sql === 'COMMIT')).toHaveLength(4);
});

test('printed runbook keeps audit and four independent VALIDATE steps', () => {
  const runbook = buildValidateRunbook();
  expect(runbook.indexOf(AUDIT_SQL)).toBeLessThan(runbook.indexOf(validateConstraintSql(CONSTRAINTS[0])));
  expect(runbook.match(/BEGIN;/g)).toHaveLength(4);
  expect(runbook.match(/COMMIT;/g)).toHaveLength(4);
  expect(runbook.match(/SET LOCAL lock_timeout = '5s';/g)).toHaveLength(4);
  expect(runbook.match(/SET LOCAL statement_timeout = '30s';/g)).toHaveLength(4);
  expect(runbook.match(/ALTER TABLE public\.[a-z_]+ VALIDATE CONSTRAINT/g)).toHaveLength(4);
  let previous = -1;
  for (const constraint of CONSTRAINTS) {
    const position = runbook.indexOf(validateConstraintSql(constraint));
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
  expect(runbook).toContain('duration_ms=<integer>');
  expect(runbook).toContain('separate coordinator gate');
});
