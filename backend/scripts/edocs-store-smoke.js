'use strict';
// Проверка SQL «Документов» на настоящей схеме ПОСЛЕ миграции: каждая функция store.js
// выполняется в ОДНОЙ транзакции, в конце — ROLLBACK (в БД ничего не остаётся).
// Юнит-тесты подменяют db и SQL не проверяют — этот скрипт ловит опечатки в SQL, типы
// параметров и to_char дат. Только дев-БД (loyalpro_test), если не передан --allow-any-db.
// node scripts/edocs-store-smoke.js                  — после миграции (таблицы уже есть)
// node scripts/edocs-store-smoke.js --create-tables  — до миграции: таблицы «Документов» из
//   migrations.js создаются в той же транзакции БЕЗ внешних ключей (чтобы не брать блокировки
//   на clients/records/users) и исчезают вместе с ROLLBACK.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');

const REF_RE = /REFERENCES\s+\w+\(\w+\)(\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL))?/g;
/** CREATE-операторы «Документов» из migrations.js (таблицы и индексы), без REFERENCES. */
function edocsDdl() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrations.js'), 'utf8');
  return [...src.matchAll(/client\.query\(`([\s\S]*?)`\)/g)].map((m) => m[1])
    .filter((sql) => /CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS (edoc_|client_identity|idx_edoc_|idx_client_identity)/.test(sql))
    .map((sql) => sql.replace(REF_RE, ''));
}

async function run(client, { salonId = 1 } = {}) {
  const fakeDb = {
    query: (sql, p) => client.query(sql, p),
    one: async (sql, p) => (await client.query(sql, p)).rows[0] || null,
    oneOrNone: async (sql, p) => (await client.query(sql, p)).rows[0] || null,
    many: async (sql, p) => (await client.query(sql, p)).rows,
    any: async (sql, p) => (await client.query(sql, p)).rows,
  };
  let sp = 0;
  const withTransaction = async (fn) => {
    const name = `edocs_sp${++sp}`;
    await client.query(`SAVEPOINT ${name}`);
    try { const r = await fn(client); await client.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
  };
  const dbPath = require.resolve('../db');
  const real = require.cache[dbPath] ? require.cache[dbPath].exports : {};
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { ...real, db: fakeDb, withTransaction } };
  delete require.cache[require.resolve('../services/edocs/store')];
  const store = require('../services/edocs/store');
  const ok = (label, cond, extra) => { assert.ok(cond, `${label}: ${JSON.stringify(extra)}`); console.log(`ok  ${label}`); };

  const c = (await client.query('SELECT id FROM clients WHERE salon_id=$1 ORDER BY last_visit_at DESC NULLS LAST LIMIT 1', [salonId])).rows[0];
  const u = (await client.query("SELECT id FROM users WHERE salon_id=$1 AND role IN ('owner','admin') ORDER BY id LIMIT 1", [salonId])).rows[0];
  const rec = (await client.query("SELECT id, client_id FROM records WHERE salon_id=$1 AND raw_payload->>'attendance'='1' AND client_id IS NOT NULL ORDER BY visit_datetime DESC LIMIT 1", [salonId])).rows[0];
  assert.ok(c && u && rec, 'нет клиента, пользователя или состоявшейся записи в салоне');

  const secret = crypto.randomBytes(24).toString('hex');
  await store.saveSettings(salonId, { enabled: true, base_url: 'https://demo.fdoc.ru', api_key_enc: 'v1:a:b:c', app_login: 'app', requisites: { city: 'Москва' }, webhook_secret: secret });
  await store.saveSettings(salonId, { corp_id: 'C1' });
  const st = await store.getSettings(salonId);
  ok('settings upsert + частичное обновление', st.enabled === true && st.corp_id === 'C1' && st.requisites.city === 'Москва', st);
  ok('findSalonByWebhookSecret', (await store.findSalonByWebhookSecret(secret)) === salonId);
  await store.touchWebhook(salonId);

  // Чужой салон — несуществующий id: ни одна проверка ниже не вставляет строк с ним (только
  // UPDATE/SELECT и INSERT, упирающийся в конфликт), поэтому внешние ключи не мешают.
  const otherSalon = -1;
  ok('saveCredentials своего салона → true', (await store.saveCredentials(salonId, u.id, 'smoke', 'v1:x:y:z')) === true);
  ok('saveCredentials из чужого салона → false', (await store.saveCredentials(otherSalon, u.id, 'intruder', 'v1:i:i:i')) === false);
  let cr = await store.getCredentials(salonId, u.id);
  ok('строка учётки чужим салоном не тронута', cr && cr.login === 'smoke' && cr.password_enc === 'v1:x:y:z' && cr.salon_id === salonId, cr && { login: cr.login, salon_id: cr.salon_id });
  await store.markCredentialsFail(otherSalon, u.id, 'evil');
  await store.markCredentialsFail(salonId, u.id, 'bad');
  cr = await store.getCredentials(salonId, u.id);
  ok('credentials + счётчик отказов (чужой салон не считается)', cr.fail_count === 1 && cr.last_error === 'bad', { fail_count: cr.fail_count, last_error: cr.last_error });
  ok('pickCredentials', (await store.pickCredentials(salonId, u.id)).user_id === u.id);
  await store.markCredentialsOk(otherSalon, u.id);
  ok('markCredentialsOk чужого салона не сбрасывает счётчик', (await store.getCredentials(salonId, u.id)).fail_count === 1);
  await store.markCredentialsOk(salonId, u.id);
  ok('markCredentialsOk своего салона сбрасывает счётчик', (await store.getCredentials(salonId, u.id)).fail_count === 0);
  ok('listUsersWithCredentials', (await store.listUsersWithCredentials(salonId)).some((x) => x.login === 'smoke'));

  const tId = await store.insertTemplate(salonId, { kind: 'contract', title: 'Smoke договор', file_key: 'smoke/k1', file_size: 1, placeholders: ['fio'], created_by: u.id });
  const aId = await store.insertTemplate(salonId, { kind: 'act', title: 'Smoke акт', file_key: 'smoke/k2', file_size: 1, placeholders: ['services'] });
  ok('templates list/byIds', (await store.getTemplatesByIds(salonId, [tId, aId])).length === 2 && (await store.listTemplates(salonId, { activeOnly: true })).length >= 2);
  ok('updateTemplateMeta', await store.updateTemplateMeta(salonId, tId, { title: 'Smoke 2', kind: 'contract', is_active: true, sort_order: 1 }));
  ok('replaceTemplateFile → прежний ключ', (await store.replaceTemplateFile(salonId, tId, { file_key: 'smoke/k3', file_size: 2, placeholders: ['fio'] })) === 'smoke/k1');

  ok('searchClients', Array.isArray(await store.searchClients(salonId, 'а')));
  const cl = await store.getClient(salonId, c.id);
  ok('getClient: дата рождения строкой', cl && (cl.birthday_iso === null || /^\d{4}-\d{2}-\d{2}$/.test(cl.birthday_iso)), cl && cl.birthday_iso);
  await store.getLatestCertRequest(salonId, c.id);
  await store.upsertIdentity(salonId, c.id, { plain: { last_name: 'Смоук', first_name: 'Тест', middle_name: '', birth_date: '1990-01-15', gender: 'F', phone: '79000000000', email: null, contract_no: '1', contract_date: '2026-10-24' },
    secure_enc: 'v1:a:b:c', secure_fields: ['passport_series'], source: 'manual', userId: u.id });
  const idr = await store.getIdentityRow(salonId, c.id);
  ok('identity: даты строками, поля паспорта', idr.birth_date === '1990-01-15' && idr.contract_date === '2026-10-24' && idr.secure_fields[0] === 'passport_series', idr);

  const r1 = await store.getRecord(salonId, rec.id);
  ok('getRecord', r1 && r1.attendance === '1' && /^\d{4}-\d{2}-\d{2}$/.test(r1.visit_date) && Array.isArray(r1.services), r1 && r1.visit_date);

  const pkgId = crypto.randomUUID(), d1 = crypto.randomUUID();
  await store.insertPackage({ id: pkgId, salon_id: salonId, client_id: rec.client_id, record_id: rec.id, kind: 'act', title: 'Smoke акт', payload: { templateIds: [aId] }, sent_by: u.id },
    [{ id: d1, template_id: aId, title: 'Smoke акт', file_name: 'Smoke.docx', sort_order: 0 }]);
  ok('deleteTemplate занятого → busy', (await store.deleteTemplate(salonId, aId)) === 'busy');
  await store.markSendError(salonId, pkgId, 'smoke error');
  ok('markSent из черновика → true', (await store.markSent(salonId, pkgId, { employeeUrl: 'https://demo.fdoc.ru/x', userId: u.id })) === true);
  let pk = await store.getPackage(salonId, pkgId);
  ok('markSent', pk.status === 'sent' && pk.employee_url === 'https://demo.fdoc.ru/x' && pk.last_error === null, pk);
  ok('markSent уже отправленного → false', (await store.markSent(salonId, pkgId, { employeeUrl: 'https://demo.fdoc.ru/again', userId: u.id })) === false);
  ok('markSent повторный комплект не тронул', (await store.getPackage(salonId, pkgId)).employee_url === 'https://demo.fdoc.ru/x');
  ok('actStatusesForRecords', (await store.actStatusesForRecords(salonId, [rec.id])).some((x) => x.package_id === pkgId));
  ok('listClientVisits со статусом акта', (await store.listClientVisits(salonId, rec.client_id)).some((x) => x.act_package_id === pkgId));

  // Статус только вперёд. Время подписи — относительно «сейчас»: опрос без PDF ограничен 30 днями.
  const signedIso = new Date(Date.now() - 3600 * 1000).toISOString();
  const statusUpd = (status, fdocStatus, signedAt) => ({ package: { status, fdoc_status: fdocStatus, fdoc_package_guid: null, signed_at: signedAt },
    documents: [{ id: d1, fdoc_document_guid: null, fdoc_status: fdocStatus, client_signed_at: signedAt, corp_signed_at: null }] });
  ok('applyStatus sent → signed → true', (await store.applyStatus(salonId, pkgId, statusUpd('signed', 'SIGNED', signedIso))) === true);
  pk = await store.getPackage(salonId, pkgId);
  ok('applyStatus', pk.status === 'signed' && !!pk.signed_at && !!pk.last_status_check_at, pk);
  ok('applyStatus signed → sent отвергнут (false)', (await store.applyStatus(salonId, pkgId, statusUpd('sent', 'WAIT_SIGN', null))) === false);
  pk = await store.getPackage(salonId, pkgId);
  let doc = await store.getDocument(salonId, d1);
  ok('после отказа: комплект signed, документ не тронут', pk.status === 'signed' && pk.fdoc_status === 'SIGNED' && doc.fdoc_status === 'SIGNED', { pkg: pk.status, doc: doc.fdoc_status });
  ok('applyStatus чужого салона → false', (await store.applyStatus(otherSalon, pkgId, statusUpd('annulled', 'ANNULED', null))) === false);
  pk = await store.getPackage(salonId, pkgId);
  doc = await store.getDocument(salonId, d1);
  ok('applyStatus чужого салона: комплект и документ не тронуты', pk.status === 'signed' && doc.fdoc_status === 'SIGNED', { pkg: pk.status, doc: doc.fdoc_status });

  ok('listDocuments своего салона', (await store.listDocuments(salonId, pkgId)).map((x) => x.id).join() === d1);
  ok('listDocuments чужого салона пуст', (await store.listDocuments(otherSalon, pkgId)).length === 0);

  await client.query("UPDATE edoc_packages SET last_status_check_at = NOW() - INTERVAL '2 days' WHERE id=$1", [pkgId]);
  ok('listDuePackages видит подписанный без PDF', (await store.listDuePackages(500)).some((x) => x.id === pkgId));
  await client.query("UPDATE edoc_packages SET signed_at = NOW() - INTERVAL '31 days' WHERE id=$1", [pkgId]);
  ok('listDuePackages не видит подписанный 31 день назад без PDF', !(await store.listDuePackages(500)).some((x) => x.id === pkgId));
  await client.query('UPDATE edoc_packages SET signed_at = $2::timestamptz WHERE id=$1', [pkgId, signedIso]);

  const checkedOld = async () => (await client.query("SELECT last_status_check_at < NOW() - INTERVAL '1 day' AS old FROM edoc_packages WHERE id=$1", [pkgId])).rows[0].old;
  await store.touchStatusCheck(otherSalon, [pkgId]);
  ok('touchStatusCheck чужого салона не трогает', (await checkedOld()) === true);
  await store.touchStatusCheck(salonId, [pkgId]);
  ok('touchStatusCheck своего салона', (await checkedOld()) === false);

  await store.setDocumentPdf(otherSalon, d1, 'evil/x.pdf');
  ok('setDocumentPdf чужого салона не трогает', (await store.getDocument(salonId, d1)).pdf_key === null);
  await store.setDocumentPdf(salonId, d1, 'smoke/x.pdf');
  ok('getDocument', (await store.getDocument(salonId, d1)).pdf_key === 'smoke/x.pdf');
  ok('findPackageByAnyId', !!(await store.findPackageByAnyId(salonId, pkgId)));
  ok('listPackages', (await store.listPackages(salonId, { status: 'signed', from: '2020-01-01', to: '2099-12-31' })).rows.some((x) => x.id === pkgId));
  ok('listClientPackages', (await store.listClientPackages(salonId, rec.client_id)).some((x) => x.id === pkgId));
  ok('applyStatus signed → annulled → true', (await store.applyStatus(salonId, pkgId, statusUpd('annulled', 'ANNULED', null))) === true);
  pk = await store.getPackage(salonId, pkgId);
  ok('signed → annulled применён, время подписи сохранено', pk.status === 'annulled' && !!pk.signed_at && (await store.getDocument(salonId, d1)).fdoc_status === 'ANNULED', { pkg: pk.status, signed_at: pk.signed_at });
  await store.setEmployeeUrl(salonId, pkgId, 'https://demo.fdoc.ru/y');
  await store.logEvent({ salonId, packageId: pkgId, clientId: rec.client_id, kind: 'send', userId: u.id, payload: { documents: 1 } });
  ok('listEvents', (await store.listEvents(salonId, pkgId)).length === 1);
  ok('deleteTemplate завершённого комплекта → удалён', (await store.deleteTemplate(salonId, aId)).fileKey === 'smoke/k2');
  await store.deleteCredentials(salonId, u.id);
  ok('deleteCredentials', (await store.getCredentials(salonId, u.id)) === null);
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  if (!/loyalpro_test/.test(process.env.DATABASE_URL || '') && !process.argv.includes('--allow-any-db')) {
    console.error('Не дев-БД (нет loyalpro_test в DATABASE_URL) — остановка. Флаг --allow-any-db снимает защиту.');
    process.exit(2);
  }
  const { pool } = require('../db');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    if (process.argv.includes('--create-tables')) {
      const ddl = edocsDdl();
      assert.ok(ddl.length >= 14, `в migrations.js не нашлись таблицы «Документов» (${ddl.length})`);
      for (const sql of ddl) await client.query(sql);
      console.log(`таблицы созданы во временной транзакции: ${ddl.length} операторов`);
    }
    await run(client);
    console.log('SQL «Документов» в порядке (транзакция откатывается)');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(`ОШИБКА: ${e.message}`); process.exit(1); });
module.exports = { run, edocsDdl };
