'use strict';

const assert = require('assert/strict');
const { randomInt, randomUUID } = require('crypto');
const { safeErrorCode } = require('../utils/safe-error');

const CURRENT_DATABASE_SQL = 'SELECT current_database() AS name';
const TEST_DATABASE = 'loyalpro_test';
const VALIDATION_DATABASES = Object.freeze([TEST_DATABASE, 'loyalpro']);
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'";
const STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '30s'";

const AUDIT_COLUMNS = Object.freeze([
  'bad_course_client',
  'bad_visit_client',
  'bad_visit_course',
  'bad_visit_record',
  'bad_visit_specialist',
  'bad_photo_visit',
  'bad_comment_visit',
]);

const AUDIT_SQL = `SELECT
  (SELECT count(*)::int FROM public.case_courses c
    LEFT JOIN public.clients cl ON cl.id=c.client_id AND cl.salon_id=c.salon_id
    WHERE cl.id IS NULL) AS bad_course_client,
  (SELECT count(*)::int FROM public.case_visits v
    LEFT JOIN public.clients cl ON cl.id=v.client_id AND cl.salon_id=v.salon_id
    WHERE cl.id IS NULL) AS bad_visit_client,
  (SELECT count(*)::int FROM public.case_visits v
    LEFT JOIN public.case_courses c ON c.id=v.course_id AND c.salon_id=v.salon_id AND c.client_id=v.client_id
    WHERE v.course_id IS NOT NULL AND c.id IS NULL) AS bad_visit_course,
  (SELECT count(*)::int FROM public.case_visits v
    LEFT JOIN public.records r ON r.id=v.record_id AND r.salon_id=v.salon_id
      AND (r.client_id IS NULL OR r.client_id=v.client_id)
    WHERE v.record_id IS NOT NULL AND r.id IS NULL) AS bad_visit_record,
  (SELECT count(*)::int FROM public.case_visits v
    LEFT JOIN public.users u ON u.id=v.specialist_user_id AND u.salon_id=v.salon_id
    WHERE v.specialist_user_id IS NOT NULL AND u.id IS NULL) AS bad_visit_specialist,
  (SELECT count(*)::int FROM public.case_photos p
    LEFT JOIN public.case_visits v ON v.id=p.case_visit_id AND v.salon_id=p.salon_id
    WHERE v.id IS NULL) AS bad_photo_visit,
  (SELECT count(*)::int FROM public.case_comments cm
    LEFT JOIN public.case_visits v ON v.id=cm.case_visit_id AND v.salon_id=cm.salon_id
    WHERE v.id IS NULL) AS bad_comment_visit`;

const CONSTRAINTS = Object.freeze([
  Object.freeze({ table: 'case_courses', name: 'fk_case_courses_salon_client' }),
  Object.freeze({ table: 'case_visits', name: 'fk_case_visits_salon_client' }),
  Object.freeze({ table: 'case_photos', name: 'fk_case_photos_salon_visit' }),
  Object.freeze({ table: 'case_comments', name: 'fk_case_comments_salon_visit' }),
]);

const EXPECTED_TRIGGERS = Object.freeze([
  Object.freeze({ table: 'case_visits', name: 'case_visit_tenant_check' }),
  Object.freeze({ table: 'case_comments', name: 'case_comment_tenant_check' }),
]);

const FK_PREFLIGHT_SQL = `SELECT rel.relname AS table_name, c.conname
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class rel ON rel.oid=c.conrelid
  WHERE c.contype='f' AND (
    (c.conrelid='public.case_courses'::regclass AND c.conname='fk_case_courses_salon_client') OR
    (c.conrelid='public.case_visits'::regclass AND c.conname='fk_case_visits_salon_client') OR
    (c.conrelid='public.case_photos'::regclass AND c.conname='fk_case_photos_salon_visit') OR
    (c.conrelid='public.case_comments'::regclass AND c.conname='fk_case_comments_salon_visit')
  )`;

const TRIGGER_PREFLIGHT_SQL = `SELECT c.relname AS table_name, t.tgname AS trigger_name
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT t.tgisinternal AND (
    (c.relname='case_visits' AND t.tgname='case_visit_tenant_check') OR
    (c.relname='case_comments' AND t.tgname='case_comment_tenant_check')
  )`;

const ERRORS = Object.freeze({
  courseClient: Object.freeze({ sqlstate: '23503', constraint: 'fk_case_courses_salon_client' }),
  visitClient: Object.freeze({ sqlstate: '23503', constraint: 'fk_case_visits_salon_client' }),
  photoVisit: Object.freeze({ sqlstate: '23503', constraint: 'fk_case_photos_salon_visit' }),
  commentVisit: Object.freeze({ sqlstate: '23503', constraint: 'fk_case_comments_salon_visit' }),
  course: Object.freeze({ sqlstate: '23503', message: 'case visit course tenant/client mismatch' }),
  record: Object.freeze({ sqlstate: '23503', message: 'case visit record tenant/client mismatch' }),
  specialist: Object.freeze({ sqlstate: '23503', message: 'case visit specialist tenant mismatch' }),
  author: Object.freeze({ sqlstate: '23503', message: 'case comment author tenant mismatch' }),
});

function constraintStateSql({ table, name }) {
  return `SELECT convalidated FROM pg_catalog.pg_constraint WHERE conrelid='public.${table}'::regclass AND conname='${name}' AND contype='f'`;
}

function validateConstraintSql({ table, name }) {
  return `ALTER TABLE public.${table} VALIDATE CONSTRAINT ${name}`;
}

async function confirmDatabase(client, expected, allowed = [TEST_DATABASE]) {
  assert(allowed.includes(expected), 'database confirmation is not allowed');
  const result = await client.query(CURRENT_DATABASE_SQL);
  const actual = result.rows[0] && result.rows[0].name;
  assert.equal(actual, expected, 'database guard rejected the connection');
  return actual;
}

async function runAudit(client) {
  const result = await client.query(AUDIT_SQL);
  assert.equal(result.rows.length, 1, 'audit must return one aggregate row');
  const row = result.rows[0];
  assert.deepEqual(Object.keys(row).sort(), [...AUDIT_COLUMNS].sort(), 'audit columns changed');
  const counts = {};
  for (const column of AUDIT_COLUMNS) {
    assert(Number.isInteger(row[column]) && row[column] >= 0, `invalid aggregate: ${column}`);
    counts[column] = row[column];
  }
  return counts;
}

function assertAuditClean(counts) {
  const nonzero = AUDIT_COLUMNS.filter(column => counts[column] !== 0);
  assert.deepEqual(nonzero, [], `audit must be all zero before VALIDATE: ${nonzero.join(',')}`);
}

async function preflight(client) {
  const fkRows = (await client.query(FK_PREFLIGHT_SQL)).rows
    .map(row => `${row.table_name}.${row.conname}`).sort();
  const expectedFks = CONSTRAINTS.map(({ table, name }) => `${table}.${name}`).sort();
  assert.deepEqual(fkRows, expectedFks, 'required composite FK preflight failed');

  const triggerRows = (await client.query(TRIGGER_PREFLIGHT_SQL)).rows
    .map(row => `${row.table_name}.${row.trigger_name}`).sort();
  const expectedTriggers = EXPECTED_TRIGGERS.map(({ table, name }) => `${table}.${name}`).sort();
  assert.deepEqual(triggerRows, expectedTriggers, 'required tenant trigger preflight failed');
}

function createIdGenerator() {
  const used = new Set();
  return function nextId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = -randomInt(100000, 2147483000);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error('could not allocate a synthetic id');
  };
}

async function insertCourse(client, { id, salonId, clientId, userId }) {
  await client.query(
    `INSERT INTO public.case_courses (id,salon_id,client_id,title,description,created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, salonId, clientId, 'synthetic tenant course', 'synthetic only', userId]);
}

async function insertRecord(client, { id, salonId, clientId, yclientsRecordId }) {
  await client.query(
    `INSERT INTO public.records (id,salon_id,yclients_record_id,client_id,visit_date,status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, salonId, yclientsRecordId, clientId, '2000-01-01', 'confirmed']);
}

async function insertVisit(client, {
  id, salonId, clientId, courseId = null, recordId = null, specialistUserId = null,
}) {
  await client.query(
    `INSERT INTO public.case_visits
       (id,salon_id,client_id,course_id,record_id,specialist_user_id,visit_date,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, salonId, clientId, courseId, recordId, specialistUserId, '2000-01-01', 'synthetic only']);
}

async function insertPhoto(client, { id, salonId, visitId, userId }) {
  const key = `synthetic/case-tenant/${randomUUID()}`;
  await client.query(
    `INSERT INTO public.case_photos
       (id,salon_id,case_visit_id,stage,s3_key_original,s3_key_medium,s3_key_thumb,
        mime_type,size_bytes,width,height,uploaded_by)
     VALUES ($1,$2,$3,'before',$4,$5,$6,'image/jpeg',1,1,1,$7)`,
    [id, salonId, visitId, `${key}/original`, `${key}/medium`, `${key}/thumb`, userId]);
}

async function insertComment(client, { id, salonId, visitId, userId }) {
  await client.query(
    `INSERT INTO public.case_comments (id,salon_id,case_visit_id,author_user_id,text)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, salonId, visitId, userId, 'synthetic tenant integrity comment']);
}

function createIds(nextId) {
  return {
    salonA: nextId(), salonB: nextId(),
    userA: nextId(), userB: nextId(),
    clientA1: nextId(), clientA2: nextId(), clientB: nextId(),
    courseA1: nextId(), courseA2: nextId(), courseB: nextId(),
    recordA1: nextId(), recordA2: nextId(), recordNull: nextId(), recordB: nextId(),
    ycRecordA1: nextId(), ycRecordA2: nextId(), ycRecordNull: nextId(), ycRecordB: nextId(),
    visitA: nextId(), visitAClient: nextId(), visitB: nextId(),
    photoA: nextId(), photoB: nextId(),
    commentA: nextId(), commentB: nextId(),
  };
}

async function insertFixtures(client, ids) {
  await client.query(
    'INSERT INTO public.salons (id,name) VALUES ($1,$2),($3,$4)',
    [ids.salonA, 'synthetic tenant A', ids.salonB, 'synthetic tenant B']);
  await client.query(
    `INSERT INTO public.users (id,salon_id,email,password_hash,name,role) VALUES
       ($1,$2,$3,'unused','synthetic specialist A','specialist'),
       ($4,$5,$6,'unused','synthetic specialist B','specialist')`,
    [ids.userA, ids.salonA, `${randomUUID()}@example.invalid`,
      ids.userB, ids.salonB, `${randomUUID()}@example.invalid`]);
  await client.query(
    'INSERT INTO public.clients (id,salon_id,name) VALUES ($1,$2,$3),($4,$2,$5),($6,$7,$8)',
    [ids.clientA1, ids.salonA, 'synthetic client A1', ids.clientA2, 'synthetic client A2',
      ids.clientB, ids.salonB, 'synthetic client B']);
  await insertCourse(client, { id: ids.courseA1, salonId: ids.salonA, clientId: ids.clientA1, userId: ids.userA });
  await insertCourse(client, { id: ids.courseA2, salonId: ids.salonA, clientId: ids.clientA2, userId: ids.userA });
  await insertCourse(client, { id: ids.courseB, salonId: ids.salonB, clientId: ids.clientB, userId: ids.userB });
  await insertRecord(client, { id: ids.recordA1, salonId: ids.salonA, clientId: ids.clientA1, yclientsRecordId: ids.ycRecordA1 });
  await insertRecord(client, { id: ids.recordA2, salonId: ids.salonA, clientId: ids.clientA2, yclientsRecordId: ids.ycRecordA2 });
  await insertRecord(client, { id: ids.recordNull, salonId: ids.salonA, clientId: null, yclientsRecordId: ids.ycRecordNull });
  await insertRecord(client, { id: ids.recordB, salonId: ids.salonB, clientId: ids.clientB, yclientsRecordId: ids.ycRecordB });
  await insertVisit(client, {
    id: ids.visitA, salonId: ids.salonA, clientId: ids.clientA1,
    courseId: ids.courseA1, recordId: ids.recordA1, specialistUserId: ids.userA,
  });
  await insertVisit(client, { id: ids.visitAClient, salonId: ids.salonA, clientId: ids.clientA1 });
  await insertVisit(client, {
    id: ids.visitB, salonId: ids.salonB, clientId: ids.clientB,
    courseId: ids.courseB, recordId: ids.recordB, specialistUserId: ids.userB,
  });
  await insertPhoto(client, { id: ids.photoA, salonId: ids.salonA, visitId: ids.visitA, userId: ids.userA });
  await insertPhoto(client, { id: ids.photoB, salonId: ids.salonB, visitId: ids.visitB, userId: ids.userB });
  await insertComment(client, { id: ids.commentA, salonId: ids.salonA, visitId: ids.visitA, userId: ids.userA });
  await insertComment(client, { id: ids.commentB, salonId: ids.salonB, visitId: ids.visitB, userId: ids.userB });
}

function buildWriteScenarios(ids, nextId) {
  const validA = async client => {
    const courseId = nextId();
    const otherCourseId = nextId();
    const movableCourseId = nextId();
    const recordId = nextId();
    const otherRecordId = nextId();
    const visitId = nextId();
    const otherVisitId = nextId();
    const photoId = nextId();
    const commentId = nextId();
    await insertCourse(client, { id: courseId, salonId: ids.salonA, clientId: ids.clientA1, userId: ids.userA });
    await insertCourse(client, { id: otherCourseId, salonId: ids.salonA, clientId: ids.clientA1, userId: ids.userA });
    await insertCourse(client, { id: movableCourseId, salonId: ids.salonA, clientId: ids.clientA1, userId: ids.userA });
    await insertRecord(client, { id: recordId, salonId: ids.salonA, clientId: ids.clientA1, yclientsRecordId: nextId() });
    await insertRecord(client, { id: otherRecordId, salonId: ids.salonA, clientId: ids.clientA1, yclientsRecordId: nextId() });
    await insertVisit(client, {
      id: visitId, salonId: ids.salonA, clientId: ids.clientA1,
      courseId, recordId, specialistUserId: ids.userA,
    });
    await insertVisit(client, { id: otherVisitId, salonId: ids.salonA, clientId: ids.clientA1 });
    await insertPhoto(client, { id: photoId, salonId: ids.salonA, visitId, userId: ids.userA });
    await insertComment(client, { id: commentId, salonId: ids.salonA, visitId, userId: ids.userA });
    await client.query('UPDATE public.case_courses SET client_id=$2 WHERE id=$1 AND salon_id=$3', [movableCourseId, ids.clientA2, ids.salonA]);
    await client.query(
      `UPDATE public.case_visits SET course_id=$2,record_id=$3,specialist_user_id=$4
       WHERE id=$1 AND salon_id=$5`,
      [visitId, otherCourseId, otherRecordId, ids.userA, ids.salonA]);
    await client.query('UPDATE public.case_photos SET case_visit_id=$2 WHERE id=$1 AND salon_id=$3', [photoId, otherVisitId, ids.salonA]);
    await client.query('UPDATE public.case_comments SET case_visit_id=$2,author_user_id=$4 WHERE id=$1 AND salon_id=$3', [commentId, otherVisitId, ids.salonA, ids.userA]);
    const result = await client.query(
      `SELECT
         (SELECT count(*)::int FROM public.case_courses WHERE id=$1 AND salon_id=$2 AND client_id=$3) AS course_ok,
         (SELECT count(*)::int FROM public.case_visits WHERE id=$4 AND salon_id=$2 AND course_id=$5 AND record_id=$6 AND specialist_user_id=$7) AS visit_ok,
         (SELECT count(*)::int FROM public.case_photos WHERE id=$8 AND salon_id=$2 AND case_visit_id=$9) AS photo_ok,
         (SELECT count(*)::int FROM public.case_comments WHERE id=$10 AND salon_id=$2 AND case_visit_id=$9 AND author_user_id=$7) AS comment_ok`,
      [movableCourseId, ids.salonA, ids.clientA2, visitId, otherCourseId, otherRecordId,
        ids.userA, photoId, otherVisitId, commentId]);
    assert.deepEqual(result.rows[0], { course_ok: 1, visit_ok: 1, photo_ok: 1, comment_ok: 1 });
  };

  const validB = async client => {
    const visitId = nextId();
    await insertVisit(client, {
      id: visitId, salonId: ids.salonB, clientId: ids.clientB, specialistUserId: ids.userB,
    });
    await insertPhoto(client, { id: nextId(), salonId: ids.salonB, visitId, userId: ids.userB });
    await insertComment(client, { id: nextId(), salonId: ids.salonB, visitId, userId: ids.userB });
  };

  const validNullableRecord = async client => {
    const visitId = nextId();
    await insertVisit(client, {
      id: visitId, salonId: ids.salonA, clientId: ids.clientA1, recordId: ids.recordNull,
    });
    const result = await client.query(
      'SELECT count(*)::int AS n FROM public.case_visits WHERE id=$1 AND salon_id=$2 AND record_id=$3',
      [visitId, ids.salonA, ids.recordNull]);
    assert.equal(result.rows[0].n, 1);
  };

  return [
    { name: 'valid_tenant_a_insert_update', kind: 'valid', relationship: 'all', operation: 'INSERT_UPDATE', run: validA },
    { name: 'valid_tenant_b_insert', kind: 'valid', relationship: 'all', operation: 'INSERT', run: validB },
    { name: 'valid_nullable_record_insert', kind: 'valid', relationship: 'record', operation: 'INSERT', run: validNullableRecord },
    { name: 'course_client_insert_cross_tenant', kind: 'rejected', relationship: 'client', operation: 'INSERT', expected: ERRORS.courseClient,
      run: client => insertCourse(client, { id: nextId(), salonId: ids.salonA, clientId: ids.clientB, userId: ids.userA }) },
    { name: 'course_client_update_cross_tenant', kind: 'rejected', relationship: 'client', operation: 'UPDATE', expected: ERRORS.courseClient,
      run: client => client.query('UPDATE public.case_courses SET client_id=$2 WHERE id=$1 AND salon_id=$3', [ids.courseA2, ids.clientB, ids.salonA]) },
    { name: 'visit_client_insert_cross_tenant', kind: 'rejected', relationship: 'client', operation: 'INSERT', expected: ERRORS.visitClient,
      run: client => insertVisit(client, { id: nextId(), salonId: ids.salonA, clientId: ids.clientB }) },
    { name: 'visit_client_update_cross_tenant', kind: 'rejected', relationship: 'client', operation: 'UPDATE', expected: ERRORS.visitClient,
      run: client => client.query('UPDATE public.case_visits SET client_id=$2 WHERE id=$1 AND salon_id=$3', [ids.visitAClient, ids.clientB, ids.salonA]) },
    { name: 'visit_course_insert_cross_tenant', kind: 'rejected', relationship: 'course', operation: 'INSERT', expected: ERRORS.course,
      run: client => insertVisit(client, { id: nextId(), salonId: ids.salonA, clientId: ids.clientA1, courseId: ids.courseB }) },
    { name: 'visit_course_update_cross_tenant', kind: 'rejected', relationship: 'course', operation: 'UPDATE', expected: ERRORS.course,
      run: client => client.query('UPDATE public.case_visits SET course_id=$2 WHERE id=$1 AND salon_id=$3', [ids.visitA, ids.courseB, ids.salonA]) },
    { name: 'visit_course_insert_other_client', kind: 'rejected', relationship: 'course', operation: 'INSERT', expected: ERRORS.course,
      run: client => insertVisit(client, { id: nextId(), salonId: ids.salonA, clientId: ids.clientA1, courseId: ids.courseA2 }) },
    { name: 'visit_course_update_other_client', kind: 'rejected', relationship: 'course', operation: 'UPDATE', expected: ERRORS.course,
      run: client => client.query('UPDATE public.case_visits SET course_id=$2 WHERE id=$1 AND salon_id=$3', [ids.visitA, ids.courseA2, ids.salonA]) },
    { name: 'visit_record_insert_cross_tenant', kind: 'rejected', relationship: 'record', operation: 'INSERT', expected: ERRORS.record,
      run: client => insertVisit(client, { id: nextId(), salonId: ids.salonA, clientId: ids.clientA1, recordId: ids.recordB }) },
    { name: 'visit_record_update_cross_tenant', kind: 'rejected', relationship: 'record', operation: 'UPDATE', expected: ERRORS.record,
      run: client => client.query('UPDATE public.case_visits SET record_id=$2 WHERE id=$1 AND salon_id=$3', [ids.visitA, ids.recordB, ids.salonA]) },
    { name: 'visit_record_insert_other_client', kind: 'rejected', relationship: 'record', operation: 'INSERT', expected: ERRORS.record,
      run: client => insertVisit(client, { id: nextId(), salonId: ids.salonA, clientId: ids.clientA1, recordId: ids.recordA2 }) },
    { name: 'visit_record_update_other_client', kind: 'rejected', relationship: 'record', operation: 'UPDATE', expected: ERRORS.record,
      run: client => client.query('UPDATE public.case_visits SET record_id=$2 WHERE id=$1 AND salon_id=$3', [ids.visitA, ids.recordA2, ids.salonA]) },
    { name: 'visit_specialist_insert_cross_tenant', kind: 'rejected', relationship: 'specialist', operation: 'INSERT', expected: ERRORS.specialist,
      run: client => insertVisit(client, { id: nextId(), salonId: ids.salonA, clientId: ids.clientA1, specialistUserId: ids.userB }) },
    { name: 'visit_specialist_update_cross_tenant', kind: 'rejected', relationship: 'specialist', operation: 'UPDATE', expected: ERRORS.specialist,
      run: client => client.query('UPDATE public.case_visits SET specialist_user_id=$2 WHERE id=$1 AND salon_id=$3', [ids.visitA, ids.userB, ids.salonA]) },
    { name: 'photo_visit_insert_cross_tenant', kind: 'rejected', relationship: 'photo', operation: 'INSERT', expected: ERRORS.photoVisit,
      run: client => insertPhoto(client, { id: nextId(), salonId: ids.salonA, visitId: ids.visitB, userId: ids.userA }) },
    { name: 'photo_visit_update_cross_tenant', kind: 'rejected', relationship: 'photo', operation: 'UPDATE', expected: ERRORS.photoVisit,
      run: client => client.query('UPDATE public.case_photos SET case_visit_id=$2 WHERE id=$1 AND salon_id=$3', [ids.photoA, ids.visitB, ids.salonA]) },
    { name: 'comment_visit_insert_cross_tenant', kind: 'rejected', relationship: 'comment', operation: 'INSERT', expected: ERRORS.commentVisit,
      run: client => insertComment(client, { id: nextId(), salonId: ids.salonA, visitId: ids.visitB, userId: ids.userA }) },
    { name: 'comment_visit_update_cross_tenant', kind: 'rejected', relationship: 'comment', operation: 'UPDATE', expected: ERRORS.commentVisit,
      run: client => client.query('UPDATE public.case_comments SET case_visit_id=$2 WHERE id=$1 AND salon_id=$3', [ids.commentA, ids.visitB, ids.salonA]) },
    { name: 'comment_author_insert_cross_tenant', kind: 'rejected', relationship: 'author', operation: 'INSERT', expected: ERRORS.author,
      run: client => insertComment(client, { id: nextId(), salonId: ids.salonA, visitId: ids.visitA, userId: ids.userB }) },
    { name: 'comment_author_update_cross_tenant', kind: 'rejected', relationship: 'author', operation: 'UPDATE', expected: ERRORS.author,
      run: client => client.query('UPDATE public.case_comments SET author_user_id=$2 WHERE id=$1 AND salon_id=$3', [ids.commentA, ids.userB, ids.salonA]) },
    { name: 'course_salon_update_cross_tenant', kind: 'rejected', relationship: 'salon', operation: 'UPDATE', expected: ERRORS.courseClient,
      run: client => client.query('UPDATE public.case_courses SET salon_id=$2 WHERE id=$1 AND salon_id=$3', [ids.courseA2, ids.salonB, ids.salonA]) },
    { name: 'visit_salon_update_cross_tenant', kind: 'rejected', relationship: 'salon', operation: 'UPDATE', expected: ERRORS.course,
      run: client => client.query('UPDATE public.case_visits SET salon_id=$2 WHERE id=$1 AND salon_id=$3', [ids.visitA, ids.salonB, ids.salonA]) },
    { name: 'photo_salon_update_cross_tenant', kind: 'rejected', relationship: 'salon', operation: 'UPDATE', expected: ERRORS.photoVisit,
      run: client => client.query('UPDATE public.case_photos SET salon_id=$2 WHERE id=$1 AND salon_id=$3', [ids.photoA, ids.salonB, ids.salonA]) },
    { name: 'comment_salon_update_cross_tenant', kind: 'rejected', relationship: 'salon', operation: 'UPDATE', expected: ERRORS.author,
      run: client => client.query('UPDATE public.case_comments SET salon_id=$2 WHERE id=$1 AND salon_id=$3', [ids.commentA, ids.salonB, ids.salonA]) },
  ];
}

async function assertRow(client, sql, values, expected) {
  const result = await client.query(sql, values);
  assert.deepEqual(result.rows[0], expected);
}

function buildDeletionScenarios(ids) {
  return [
    { name: 'course_delete_set_null', run: async client => {
      await client.query('DELETE FROM public.case_courses WHERE id=$1 AND salon_id=$2', [ids.courseA1, ids.salonA]);
      await assertRow(client, `SELECT
        (SELECT count(*)::int FROM public.case_visits WHERE id=$1 AND salon_id=$2 AND course_id IS NULL) AS visit_ok,
        (SELECT count(*)::int FROM public.case_photos WHERE id=$3 AND salon_id=$2 AND case_visit_id=$1) AS photo_ok,
        (SELECT count(*)::int FROM public.case_comments WHERE id=$4 AND salon_id=$2 AND case_visit_id=$1) AS comment_ok`,
      [ids.visitA, ids.salonA, ids.photoA, ids.commentA], { visit_ok: 1, photo_ok: 1, comment_ok: 1 });
    } },
    { name: 'record_delete_set_null', run: async client => {
      await client.query('DELETE FROM public.records WHERE id=$1 AND salon_id=$2', [ids.recordA1, ids.salonA]);
      await assertRow(client, `SELECT
        (SELECT count(*)::int FROM public.case_visits WHERE id=$1 AND salon_id=$2 AND record_id IS NULL) AS visit_ok,
        (SELECT count(*)::int FROM public.case_photos WHERE id=$3 AND salon_id=$2 AND case_visit_id=$1) AS photo_ok,
        (SELECT count(*)::int FROM public.case_comments WHERE id=$4 AND salon_id=$2 AND case_visit_id=$1) AS comment_ok`,
      [ids.visitA, ids.salonA, ids.photoA, ids.commentA], { visit_ok: 1, photo_ok: 1, comment_ok: 1 });
    } },
    { name: 'specialist_delete_set_null', run: async client => {
      await client.query('DELETE FROM public.users WHERE id=$1 AND salon_id=$2', [ids.userA, ids.salonA]);
      await assertRow(client, `SELECT
        (SELECT count(*)::int FROM public.case_visits WHERE id=$1 AND salon_id=$2 AND specialist_user_id IS NULL) AS visit_ok,
        (SELECT count(*)::int FROM public.case_photos WHERE id=$3 AND salon_id=$2 AND case_visit_id=$1 AND uploaded_by IS NULL) AS photo_ok,
        (SELECT count(*)::int FROM public.case_comments WHERE id=$4 AND salon_id=$2 AND case_visit_id=$1 AND author_user_id IS NULL) AS comment_ok`,
      [ids.visitA, ids.salonA, ids.photoA, ids.commentA], { visit_ok: 1, photo_ok: 1, comment_ok: 1 });
    } },
    { name: 'client_delete_cascades_case_graph', run: async client => {
      await client.query('DELETE FROM public.clients WHERE id=$1 AND salon_id=$2', [ids.clientA1, ids.salonA]);
      await assertRow(client, `SELECT
        (SELECT count(*)::int FROM public.case_courses WHERE id=$1 AND salon_id=$2) AS course_left,
        (SELECT count(*)::int FROM public.case_visits WHERE id=$3 AND salon_id=$2) AS visit_left,
        (SELECT count(*)::int FROM public.case_photos WHERE id=$4 AND salon_id=$2) AS photo_left,
        (SELECT count(*)::int FROM public.case_comments WHERE id=$5 AND salon_id=$2) AS comment_left`,
      [ids.courseA1, ids.salonA, ids.visitA, ids.photoA, ids.commentA],
      { course_left: 0, visit_left: 0, photo_left: 0, comment_left: 0 });
    } },
    { name: 'salon_delete_cascades_case_graph', run: async client => {
      await client.query('DELETE FROM public.salons WHERE id=$1', [ids.salonA]);
      await assertRow(client, `SELECT
        (SELECT count(*)::int FROM public.users WHERE salon_id=$1) AS users_left,
        (SELECT count(*)::int FROM public.clients WHERE salon_id=$1) AS clients_left,
        (SELECT count(*)::int FROM public.records WHERE salon_id=$1) AS records_left,
        (SELECT count(*)::int FROM public.case_courses WHERE salon_id=$1) AS courses_left,
        (SELECT count(*)::int FROM public.case_visits WHERE salon_id=$1) AS visits_left,
        (SELECT count(*)::int FROM public.case_photos WHERE salon_id=$1) AS photos_left,
        (SELECT count(*)::int FROM public.case_comments WHERE salon_id=$1) AS comments_left`,
      [ids.salonA], { users_left: 0, clients_left: 0, records_left: 0, courses_left: 0,
        visits_left: 0, photos_left: 0, comments_left: 0 });
    } },
    { name: 'visit_delete_cascades_only_children', run: async client => {
      await client.query('DELETE FROM public.case_visits WHERE id=$1 AND salon_id=$2', [ids.visitA, ids.salonA]);
      await assertRow(client, `SELECT
        (SELECT count(*)::int FROM public.case_photos WHERE id=$1 AND salon_id=$2) AS photo_left,
        (SELECT count(*)::int FROM public.case_comments WHERE id=$3 AND salon_id=$2) AS comment_left,
        (SELECT count(*)::int FROM public.clients WHERE id=$4 AND salon_id=$2) AS client_ok,
        (SELECT count(*)::int FROM public.case_courses WHERE id=$5 AND salon_id=$2) AS course_ok,
        (SELECT count(*)::int FROM public.records WHERE id=$6 AND salon_id=$2) AS record_ok,
        (SELECT count(*)::int FROM public.users WHERE id=$7 AND salon_id=$2) AS user_ok`,
      [ids.photoA, ids.salonA, ids.commentA, ids.clientA1, ids.courseA1, ids.recordA1, ids.userA],
      { photo_left: 0, comment_left: 0, client_ok: 1, course_ok: 1, record_ok: 1, user_ok: 1 });
    } },
  ];
}

async function withRollbackGroup(client, name, fn) {
  assert(/^case_[a-z_]+$/.test(name), 'invalid internal savepoint name');
  await client.query(`SAVEPOINT ${name}`);
  let failure;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
  await client.query(`RELEASE SAVEPOINT ${name}`);
  if (failure) throw failure;
}

async function expectRejected(client, scenario, index) {
  const savepoint = `case_rejection_${index}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let error;
  try {
    await scenario.run(client);
  } catch (caught) {
    error = caught;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert(error, `${scenario.name}: write unexpectedly succeeded`);
  assert.equal(error.code, scenario.expected.sqlstate, `${scenario.name}: SQLSTATE`);
  if (scenario.expected.constraint) {
    assert.equal(error.constraint, scenario.expected.constraint, `${scenario.name}: constraint`);
  }
  if (scenario.expected.message) {
    assert.equal(error.message, scenario.expected.message, `${scenario.name}: message`);
  }
}

async function assertControlB(client, ids) {
  await assertRow(client, `SELECT
    (SELECT count(*)::int FROM public.clients WHERE id=$1 AND salon_id=$2) AS client_ok,
    (SELECT count(*)::int FROM public.case_courses WHERE id=$3 AND salon_id=$2 AND client_id=$1) AS course_ok,
    (SELECT count(*)::int FROM public.records WHERE id=$4 AND salon_id=$2 AND client_id=$1) AS record_ok,
    (SELECT count(*)::int FROM public.users WHERE id=$5 AND salon_id=$2) AS user_ok,
    (SELECT count(*)::int FROM public.case_visits WHERE id=$6 AND salon_id=$2 AND client_id=$1
      AND course_id=$3 AND record_id=$4 AND specialist_user_id=$5) AS visit_ok,
    (SELECT count(*)::int FROM public.case_photos WHERE id=$7 AND salon_id=$2 AND case_visit_id=$6 AND uploaded_by=$5) AS photo_ok,
    (SELECT count(*)::int FROM public.case_comments WHERE id=$8 AND salon_id=$2 AND case_visit_id=$6 AND author_user_id=$5) AS comment_ok`,
  [ids.clientB, ids.salonB, ids.courseB, ids.recordB, ids.userB, ids.visitB, ids.photoB, ids.commentB],
  { client_ok: 1, course_ok: 1, record_ok: 1, user_ok: 1, visit_ok: 1, photo_ok: 1, comment_ok: 1 });
}

async function assertNoSyntheticSalonResidue(client, ids) {
  const result = await client.query(
    'SELECT count(*)::int AS residue_count FROM public.salons WHERE id=$1 OR id=$2',
    [ids.salonA, ids.salonB]);
  const residueCount = result.rows[0] && result.rows[0].residue_count;
  assert.equal(residueCount, 0, 'synthetic salon residue detected');
  return residueCount;
}

async function runE2E(client) {
  await confirmDatabase(client, TEST_DATABASE);
  const audit = await runAudit(client);
  await preflight(client);
  const nextId = createIdGenerator();
  const ids = createIds(nextId);
  const writeScenarios = buildWriteScenarios(ids, nextId);
  const deletionScenarios = buildDeletionScenarios(ids);

  await client.query('BEGIN');
  try {
    await client.query(LOCK_TIMEOUT_SQL);
    await client.query(STATEMENT_TIMEOUT_SQL);
    await insertFixtures(client, ids);
    await assertControlB(client, ids);

    await withRollbackGroup(client, 'case_valid_writes', async () => {
      for (const scenario of writeScenarios.filter(item => item.kind === 'valid')) {
        await scenario.run(client);
      }
    });
    await assertControlB(client, ids);

    await withRollbackGroup(client, 'case_cross_tenant_rejections', async () => {
      const rejected = writeScenarios.filter(item => item.kind === 'rejected');
      for (let index = 0; index < rejected.length; index += 1) {
        await expectRejected(client, rejected[index], index);
      }
    });
    await assertControlB(client, ids);

    for (const scenario of deletionScenarios) {
      await withRollbackGroup(client, `case_${scenario.name}`, () => scenario.run(client));
      await assertControlB(client, ids);
    }
  } finally {
    await client.query('ROLLBACK');
  }
  const residueCount = await assertNoSyntheticSalonResidue(client, ids);

  return {
    audit,
    writeScenarios: writeScenarios.map(scenario => scenario.name),
    deletionScenarios: deletionScenarios.map(scenario => scenario.name),
    rolledBack: true,
    residueCount,
  };
}

async function validateConstraints(client, confirmedDatabase, onEvent = () => {}) {
  assert(VALIDATION_DATABASES.includes(confirmedDatabase), 'exact database confirmation is required');
  await confirmDatabase(client, confirmedDatabase, VALIDATION_DATABASES);
  const audit = await runAudit(client);
  assertAuditClean(audit);
  const completed = [];

  for (const constraint of CONSTRAINTS) {
    const stepStartedAt = process.hrtime.bigint();
    await client.query('BEGIN');
    try {
      await client.query(LOCK_TIMEOUT_SQL);
      await client.query(STATEMENT_TIMEOUT_SQL);
      const stateSql = constraintStateSql(constraint);
      let result = await client.query(stateSql);
      assert.equal(result.rows.length, 1, `missing constraint: ${constraint.name}`);
      let event;
      if (result.rows[0].convalidated === true) {
        event = 'already valid';
      } else {
        await client.query(validateConstraintSql(constraint));
        result = await client.query(stateSql);
        assert.equal(result.rows.length, 1, `constraint disappeared: ${constraint.name}`);
        assert.equal(result.rows[0].convalidated, true, `constraint is still NOT VALID: ${constraint.name}`);
        event = 'validated';
      }
      await client.query('COMMIT');
      completed.push(constraint.name);
      const durationMs = Number((process.hrtime.bigint() - stepStartedAt) / 1000000n);
      onEvent(`${constraint.name}: ${event}, duration_ms=${durationMs}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  return completed;
}

function buildValidateRunbook() {
  const lines = [
    'CASE TENANT INTEGRITY VALIDATE — coordinator-approved live operation only',
    'Do not combine with DDL re-run, backfill, deploy, or restart. Stop on the first error.',
    'First execute the aggregate audit below on the confirmed database. Every count MUST be 0.',
    'If any count is nonzero: stop, keep constraints NOT VALID, and do not backfill automatically.',
    '',
    `${AUDIT_SQL};`,
    '',
    `${CURRENT_DATABASE_SQL};`,
    'Confirm the result returns the explicitly approved database before any BEGIN.',
    'Then execute the four steps below in order, one transaction per constraint.',
    'Skip ALTER when the pre-check already returns convalidated=true; COMMIT that read-only step.',
    'After ALTER, convalidated must be true before COMMIT. Otherwise ROLLBACK and stop.',
    'A timeout or any other error requires ROLLBACK of the current step; do not run later steps.',
    'Preferred executor (exact confirmation is mandatory):',
    'node backend/scripts/case-tenant-integrity-e2e.js --validate-constraints --confirm-database=<approved-database>',
    'Each committed runner event includes duration_ms=<integer> as technical locks/duration evidence.',
    'The migration/idempotency re-run is a separate coordinator gate and is intentionally excluded.',
  ];
  for (const constraint of CONSTRAINTS) {
    lines.push(
      '',
      `-- STEP: ${constraint.name}`,
      'BEGIN;',
      `${LOCK_TIMEOUT_SQL};`,
      `${STATEMENT_TIMEOUT_SQL};`,
      `${constraintStateSql(constraint)};`,
      `${validateConstraintSql(constraint)};`,
      `${constraintStateSql(constraint)};`,
      'COMMIT;',
      '-- On any error: ROLLBACK; stop before every later step.');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--audit')) return { mode: 'audit' };
  if (argv.length === 1 && argv[0] === '--e2e') return { mode: 'e2e' };
  if (argv.length === 1 && argv[0] === '--print-validate-runbook') return { mode: 'runbook' };
  if (argv.length === 2 && argv[0] === '--validate-constraints') {
    const match = /^--confirm-database=(loyalpro_test|loyalpro)$/.exec(argv[1]);
    if (match) return { mode: 'validate', database: match[1] };
  }
  throw new Error('usage: --audit | --e2e | --print-validate-runbook | --validate-constraints --confirm-database=loyalpro_test|loyalpro');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === 'runbook') {
    console.log(buildValidateRunbook());
    return;
  }

  require('dotenv').config({ quiet: true });
  const { pool } = require('../db');
  let client;
  try {
    client = await pool.connect();
    if (options.mode === 'audit') {
      console.log(JSON.stringify(await runAudit(client)));
    } else if (options.mode === 'e2e') {
      const result = await runE2E(client);
      console.log(JSON.stringify({ status: 'ok', ...result }));
    } else {
      const completed = await validateConstraints(client, options.database, message => console.log(message));
      console.log(JSON.stringify({ status: 'ok', completed }));
    }
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

function reportMainError(error, log = console.error) {
  log(`case tenant integrity failed: ${safeErrorCode(error)}`);
}

if (require.main === module) {
  main().catch(error => {
    reportMainError(error);
    process.exitCode = 1;
  });
}

module.exports = {
  AUDIT_COLUMNS,
  AUDIT_SQL,
  CONSTRAINTS,
  CURRENT_DATABASE_SQL,
  LOCK_TIMEOUT_SQL,
  STATEMENT_TIMEOUT_SQL,
  FK_PREFLIGHT_SQL,
  TRIGGER_PREFLIGHT_SQL,
  assertNoSyntheticSalonResidue,
  buildDeletionScenarios,
  buildValidateRunbook,
  buildWriteScenarios,
  confirmDatabase,
  constraintStateSql,
  parseArgs,
  reportMainError,
  runAudit,
  runE2E,
  validateConstraintSql,
  validateConstraints,
};
