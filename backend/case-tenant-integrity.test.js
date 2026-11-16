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
