'use strict';
// Проверка SQL дашборда «Документов» на настоящей схеме: новые операторы миграции (EDOCS_BOARD_DDL —
// без REFERENCES, чтобы не брать блокировки на clients/records/users) и все новые запросы board-store,
// counter, forms-store, automation-store, store (insertPackage с видом документа, бумага, быстрая
// полоса опроса) — в ОДНОЙ транзакции, в конце ROLLBACK: в БД ничего не остаётся. Юнит-тесты
// подменяют db и SQL не видят (типы параметров, to_char, DISTINCT ON). Только дев-БД (loyalpro_test).
//   node scripts/edocs-board-smoke.js            — проверки
//   node scripts/edocs-board-smoke.js --explain  — плюс EXPLAIN ANALYZE запросов дашборда и автоматики
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');

const REF_RE = /REFERENCES\s+\w+\(\w+\)(\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL))?/g;
const MODULES = ['store', 'board-store', 'counter', 'forms-store', 'automation-store'];

function bindDb(client) {
  // Один клиент на всю транзакцию, а ручки читают через Promise.all: запросы идут по очереди
  // (pg 8 предупреждает о query() на занятом клиенте, pg 9 это запретит). В бою у db — пул.
  let chain = Promise.resolve();
  const q = (sql, p) => { const r = chain.then(() => client.query(sql, p)); chain = r.catch(() => {}); return r; };
  const fakeDb = {
    query: q,
    one: async (sql, p) => (await q(sql, p)).rows[0] || null,
    oneOrNone: async (sql, p) => (await q(sql, p)).rows[0] || null,
    many: async (sql, p) => (await q(sql, p)).rows,
    any: async (sql, p) => (await q(sql, p)).rows,
  };
  let sp = 0;
  const withTransaction = async (fn) => {
    const name = `edocs_board_sp${++sp}`;
    await client.query(`SAVEPOINT ${name}`);
    try { const r = await fn(client); await client.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
  };
  const dbPath = require.resolve('../db');
  const real = require.cache[dbPath] ? require.cache[dbPath].exports : {};
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { ...real, db: fakeDb, withTransaction } };
  const mods = {};
  for (const m of MODULES) {
    const p = require.resolve(`../services/edocs/${m}`);
    delete require.cache[p];
  }
  for (const m of MODULES) mods[m] = require(`../services/edocs/${m}`);
  return mods;
}

async function run(client, { salonId = 1, explain = false } = {}) {
  const { store, 'board-store': bs, counter, 'forms-store': fs, 'automation-store': auto } = bindDb(client);
  const ok = (label, cond, extra) => { assert.ok(cond, `${label}: ${JSON.stringify(extra)}`); console.log(`ok  ${label}`); };
  const today = (await client.query(`SELECT to_char((NOW() AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
  const shift = async (d, n) => (await client.query(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [d, n])).rows[0].d;

  const rec = (await client.query(
    `SELECT r.id, r.client_id FROM records r JOIN clients c ON c.id=r.client_id WHERE r.salon_id=$1 AND r.status='arrived'
       AND (r.raw_payload->>'paid_full')='1' AND c.phone IS NOT NULL ORDER BY r.visit_datetime DESC LIMIT 1`, [salonId])).rows[0];
  const u = (await client.query("SELECT id FROM users WHERE salon_id=$1 AND role IN ('owner','admin') AND is_active ORDER BY id LIMIT 1", [salonId])).rows[0];
  assert.ok(rec && u, 'нет оплаченной состоявшейся записи или пользователя в салоне');
  const cid = rec.client_id;

  // ── настройки ──
  await bs.ensureSettingsRow(salonId);
  await store.saveSettings(salonId, { enabled: true, corp_id: 'SMOKE', auto_previsit: true, auto_act: true, auto_remind: true, auto_sender_user_id: u.id,
    acts_required_from: await shift(today, -10), contract_autonumber: true });
  const s = await bs.getBoardSettings(salonId);
  ok('getBoardSettings: acts_from строкой, флаги автоматики, имя сотрудника', /^\d{4}-\d{2}-\d{2}$/.test(s.acts_from) && s.auto_act === true && 'auto_sender_name' in s, s.acts_from);
  ok('listAutomationSalons видит салон', (await auto.listAutomationSalons()).some((x) => x.salon_id === salonId));

  // ── шаблоны и бумажный комплект ──
  const tid = {};
  for (const kind of ['contract', 'consent_pd', 'act']) {
    tid[kind] = await store.insertTemplate(salonId, { kind, title: `smoke ${kind}`, file_key: `smoke/${kind}`, file_size: 1, placeholders: ['fio'], created_by: u.id });
  }
  const paperId = crypto.randomUUID();
  await store.insertPackage({ id: paperId, salon_id: salonId, client_id: cid, record_id: null, kind: 'onboarding', title: 'smoke paper', sent_by: u.id,
    status: 'paper', source: 'paper', signed_at: `${today}T12:00:00+03:00`, payload: { paper: { signedDate: today } } },
  [{ id: crypto.randomUUID(), template_id: tid.contract, kind: 'contract', title: 'Договор', file_name: 'Договор.docx', sort_order: 0 }]);
  const actId = crypto.randomUUID();
  await store.insertPackage({ id: actId, salon_id: salonId, client_id: cid, record_id: rec.id, kind: 'act', title: 'smoke act', sent_by: u.id, source: 'auto' },
    [{ id: crypto.randomUUID(), template_id: tid.act, kind: 'act', title: 'Акт', file_name: 'Акт.docx', sort_order: 0 }]);
  await client.query(`UPDATE edoc_packages SET status='sent', sent_at=NOW() - INTERVAL '30 minutes', last_status_check_at=NOW() - INTERVAL '2 minutes' WHERE id=$1`, [actId]);
  const docs = await bs.listDocsForClients(salonId, [cid]);
  const pdoc = docs.find((d) => d.package_id === paperId);
  ok('listDocsForClients: вид документа, статус paper, источник', pdoc && pdoc.kind === 'contract' && pdoc.package_status === 'paper' && pdoc.source === 'paper', pdoc);
  ok('listDocsForClients: акт с record_id', docs.some((d) => d.package_id === actId && d.kind === 'act' && d.record_id === rec.id));
  ok('listDocsForClients чужого салона пуст', (await bs.listDocsForClients(-1, [cid])).length === 0);
  const due = await store.listDuePackages(500);
  ok('DUE_SQL: быстрая полоса — отправлен 30 мин назад, проверка 2 мин назад → в опросе', due.some((x) => x.id === actId));
  await client.query(`UPDATE edoc_packages SET last_status_check_at=NOW() - INTERVAL '10 seconds' WHERE id=$1`, [actId]);
  ok('DUE_SQL: проверка 10 с назад → не в опросе', !(await store.listDuePackages(500)).some((x) => x.id === actId));
  ok('revokePaperPackage: бумажный → true', (await store.revokePaperPackage(salonId, paperId)) === true);
  ok('revokePaperPackage: повторно → false; электронный → false', (await store.revokePaperPackage(salonId, paperId)) === false && (await store.revokePaperPackage(salonId, actId)) === false);

  // ── доска ──
  const win = { from: await shift(today, -10), to: await shift(today, 6) };
  const recs = await bs.listBoardRecords(salonId, win.from, win.to);
  ok('listBoardRecords: окно, visit_date строкой, has_prior_visit булев, нет удалённых', recs.length > 0 && recs.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.visit_date)
    && typeof r.has_prior_visit === 'boolean' && r.status !== 'deleted' && r.status !== 'no_show'), recs.length);
  const ids = [...new Set(recs.map((r) => r.client_id))];
  ok('listIdentitiesForClients без secure_enc', (await bs.listIdentitiesForClients(salonId, ids)).every((x) => !('secure_enc' in x)));
  for (const f of Object.keys(bs.BASE_FILTERS)) {
    const rows = await bs.listBaseClients(salonId, { filter: f, actsFrom: win.from, limit: 5, offset: 0 });
    ok(`listBaseClients filter=${f}`, rows.every((r) => typeof r.contract_signed === 'boolean' && Number.isInteger(r.open_acts)) && (rows.length === 0 || Number(rows[0].total) >= rows.length));
  }
  ok('listBaseClients: поиск по цифрам и по имени', Array.isArray(await bs.listBaseClients(salonId, { search: '9200', actsFrom: win.from }))
    && Array.isArray(await bs.listBaseClients(salonId, { search: 'Ива', actsFrom: win.from })));
  const crecs = await bs.listClientRecords(salonId, cid, await shift(today, -90), await shift(today, 30));
  ok('listClientRecords: записи пациента', crecs.some((r) => r.id === rec.id));
  await store.logEvent({ salonId, clientId: cid, kind: 'paper', userId: u.id, payload: { smoke: true } });
  ok('listClientEvents: событие пациента с именем пользователя', (await bs.listClientEvents(salonId, cid)).some((e) => e.kind === 'paper' && 'user_name' in e));

  // ── номера договоров ──
  await store.upsertIdentity(salonId, cid, { plain: { last_name: 'Смоук', first_name: 'Тест', phone: '79200255591', contract_no: null }, secure_enc: null, secure_fields: [], source: 'manual', userId: u.id });
  const used = await counter.maxUsed(salonId);
  ok('maxUsed — число', Number.isInteger(used) && used >= 0, used);
  const peek = await counter.peek(salonId);
  ok('peek без строки счётчика — максимум + 1', peek.next === used + 1, peek);
  const crow = (await client.query('SELECT id, name, phone, yclients_data FROM clients WHERE id=$1', [cid])).rows[0];
  const r1 = await counter.ensureContractNo({ salonId, clientId: cid, client: { ...crow, yclients_data: {} }, docDate: today });
  ok('ensureContractNo из счётчика: номер записан пациенту', r1.source === 'counter' && r1.assigned
    && (await store.getIdentityRow(salonId, cid)).contract_no === r1.contractNo && (await store.getIdentityRow(salonId, cid)).contract_date === today, r1);
  ok('ensureContractNo повторно — тот же номер из данных', (await counter.ensureContractNo({ salonId, clientId: cid, client: crow, docDate: today })).contractNo === r1.contractNo);
  await counter.setNext(salonId, Number(r1.contractNo) + 100);
  ok('setNext / peek', (await counter.peek(salonId)).next === Number(r1.contractNo) + 100);

  // ── анкеты ──
  const formRow = (over = {}) => ({ id: crypto.randomUUID(), salon_id: salonId, client_id: cid, record_id: rec.id, token_hash: crypto.randomBytes(32).toString('hex'),
    token_enc: 'v1:a:b:c', fields: [{ key: 'last_name', required: true }], kinds: ['contract'], send_docs: true, sender_user_id: u.id, source: 'manual',
    created_by: u.id, expires_at: new Date(Date.now() + 86400000).toISOString(), ...over });
  const f1 = formRow();
  ok('insertForm: первая — ничего не отозвано', (await fs.insertForm(f1)).length === 0);
  const f2 = formRow();
  ok('insertForm: вторая отзывает первую', JSON.stringify(await fs.insertForm(f2)) === JSON.stringify([f1.id]));
  ok('getFormByHash / getForm', (await fs.getFormByHash(f2.token_hash)).id === f2.id && (await fs.getForm(salonId, f2.id)).status === 'active' && (await fs.getForm(-1, f2.id)) === null);
  ok('markOpened: первый раз true, второй false', (await fs.markOpened(f2.id)) === true && (await fs.markOpened(f2.id)) === false);
  ok('incAttempts', (await fs.incAttempts(f2.id)) === 1);
  ok('takeRecognize до лимита', (await fs.takeRecognize(f2.id, 1)) === true && (await fs.takeRecognize(f2.id, 1)) === false);
  await fs.setDelivered(f2.id, 'whatsapp');
  ok('listLatestForms: последняя анкета пациента', (await bs.listLatestForms(salonId, [cid]))[0].id === f2.id);
  ok('remindForms: доставлена только что — ещё не пора', !(await auto.remindForms(salonId, 2)).some((x) => x.id === f2.id));
  await client.query(`UPDATE edoc_patient_forms SET delivered_at = NOW() - INTERVAL '3 hours' WHERE id=$1`, [f2.id]);
  ok('remindForms: доставлена 3 ч назад — пора', (await auto.remindForms(salonId, 2)).some((x) => x.id === f2.id));
  ok('markSubmitted: один раз', (await fs.markSubmitted(f2.id, { accepted: true })) === true && (await fs.markSubmitted(f2.id, {})) === false);
  await fs.reopen(f2.id);
  ok('reopen → снова active', (await fs.getForm(salonId, f2.id)).status === 'active');
  await fs.setResult(f2.id, { packageId: actId });
  await fs.setResult(f2.id, { error: 'x' });
  ok('setResult: package_id не затирается ошибкой', (await fs.getForm(salonId, f2.id)).package_id === actId);
  ok('revoke: active → revoked; повторно — null', !!(await fs.revoke(salonId, f2.id)) && (await fs.revoke(salonId, f2.id)) === null);
  // NOW() в транзакции — время её НАЧАЛА: «просрочено секунду назад» по часам скрипта для SQL ещё в будущем.
  const f3 = formRow({ expires_at: '2020-01-01T00:00:00Z' });
  await fs.insertForm(f3);
  ok('markSubmitted просроченной — false', (await fs.markSubmitted(f3.id, {})) === false);
  ok('expireDue: просроченная → expired', (await fs.expireDue()).some((x) => x.id === f3.id) && (await fs.getForm(salonId, f3.id)).status === 'expired');
  ok('nextVisit / recordVisit / salonName', (await fs.recordVisit(salonId, rec.id)).id === rec.id && typeof (await fs.salonName(salonId)) === 'string'
    && ((await fs.nextVisit(salonId, cid)) === null || !!(await fs.nextVisit(salonId, cid)).visit_datetime));

  // ── автоматика ──
  const jobId = await auto.claim(salonId, 'act', rec.id, { clientId: cid, recordId: rec.id });
  ok('claim: первый раз — id, второй — null', !!jobId && (await auto.claim(salonId, 'act', rec.id, {})) === null);
  await auto.finish(jobId, 'failed', 'smoke: причина', { packageId: actId });
  const notes = await bs.listAutoNotes(salonId, [cid]);
  ok('listAutoNotes: последняя строка «вид × запись»', notes.some((n) => n.kind === 'act' && n.record_id === rec.id && n.status === 'failed' && n.reason === 'smoke: причина'));
  const nowIso = new Date().toISOString();
  ok('previsitCandidates (первичные и все)', Array.isArray(await auto.previsitCandidates(salonId, nowIso, new Date(Date.now() + 7 * 86400000).toISOString(), true))
    && Array.isArray(await auto.previsitCandidates(salonId, nowIso, new Date(Date.now() + 7 * 86400000).toISOString(), false)));
  ok('actCandidates: запись с актом и застолбленная — не кандидат', !(await auto.actCandidates(salonId, win.from, 0)).some((x) => x.id === rec.id));
  ok('remindPackages: отправлен 30 мин назад — при пороге 1 ч не пора', !(await auto.remindPackages(salonId, 1)).some((x) => x.id === actId));
  await client.query(`UPDATE edoc_packages SET sent_at = NOW() - INTERVAL '2 hours' WHERE id=$1`, [actId]);
  ok('remindPackages: 2 ч назад — пора', (await auto.remindPackages(salonId, 1)).some((x) => x.id === actId));

  // ── ручки дашборда и страницы пациента на настоящих данных (тот же db транзакции) ──
  const jwt = require('jsonwebtoken');
  const config = require('../config');
  for (const m of ['../routes/edocs-board', '../services/edocs/board']) delete require.cache[require.resolve(m)];
  const router = require('../routes/edocs-board');
  const token = jwt.sign({ role: 'owner', salonId, userId: u.id }, config.JWT_SECRET);
  const call = (url) => new Promise((resolve) => {
    const [pathPart, qs] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    router.handle({ method: 'GET', url, path: pathPart, query, headers: { authorization: `Bearer ${token}`, host: 'dev' }, protocol: 'https', get: () => 'dev' }, res,
      () => resolve({ status: 404, body: null }));
  });
  const week = await call('/board?range=week');
  ok('GET /board?range=week на настоящих записях: карточки, сводка, счётчики периодов', week.status === 200 && Array.isArray(week.body.cards)
    && week.body.summary.total === week.body.cards.length && typeof week.body.rangeCounts.open === 'number', week.status === 200 ? week.body.rangeCounts : week.body);
  ok('карточки: цвет, подпись, плитки трёх видов', week.body.cards.every((c) => ['red', 'amber', 'blue', 'green', 'grey'].includes(c.color) && c.label
    && c.tiles.contract && c.tiles.consent_pd && c.tiles.act));
  console.log(`    неделя: ${JSON.stringify(week.body.summary)}; периоды: ${JSON.stringify(week.body.rangeCounts)}`);
  const open = await call('/board?range=open');
  ok('GET /board?range=open: только не зелёные', open.status === 200 && open.body.cards.every((c) => c.color !== 'green' && c.color !== 'grey'));
  const pg = await call(`/clients/${cid}/page?record=${rec.id}`);
  ok('GET /clients/:id/page: шапка, шаги, данные, визиты, фокус на визите из адреса, без шифротекста', pg.status === 200 && pg.body.header && pg.body.header.steps.length === 4
    && Array.isArray(pg.body.visits) && pg.body.focusRecordId === rec.id && !JSON.stringify(pg.body).includes('secure_enc'), pg.status === 200 ? pg.body.header : pg.body);
  const base = await call('/board/clients?filter=no_contract&page=1');
  ok('GET /board/clients', base.status === 200 && Array.isArray(base.body.rows) && base.body.total >= base.body.rows.length);

  if (explain) {
    const show = async (label, sql, params) => {
      const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
      const lines = r.rows.map((x) => x['QUERY PLAN']);
      console.log(`\n── EXPLAIN ${label}\n${lines.join('\n')}`);
    };
    await show('доска (окно −30…+6 дней)', bs.BOARD_RECORDS_SQL, [salonId, await shift(today, -30), await shift(today, 6)]);
    await show('кандидаты «перед визитом»', auto.PREVISIT_SQL, [salonId, nowIso, new Date(Date.now() + 86400000).toISOString(), true]);
    await show('кандидаты «акт»', auto.ACT_SQL, [salonId, await shift(today, -3), 15]);
  }
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  if (!/loyalpro_test/.test(process.env.DATABASE_URL || '') && !process.argv.includes('--allow-any-db')) {
    console.error('Не дев-БД (нет loyalpro_test в DATABASE_URL) — остановка. Флаг --allow-any-db снимает защиту.');
    process.exit(2);
  }
  const { EDOCS_BOARD_DDL } = require('../migrations');
  const { pool } = require('../db');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const sql of EDOCS_BOARD_DDL) await client.query(sql.replace(REF_RE, ''));
    console.log(`миграция применена во временной транзакции: ${EDOCS_BOARD_DDL.length} операторов`);
    await run(client, { explain: process.argv.includes('--explain') });
    console.log('SQL дашборда «Документов» в порядке (транзакция откатывается)');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(`ОШИБКА: ${e.message}`); process.exit(1); });
module.exports = { run };
