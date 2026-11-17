'use strict';
// Explicit opt-in only, using an isolated Unix-socket PostgreSQL cluster.
// Never imports application DB/config or accepts DATABASE_URL.
const { Client } = require('pg');
const { HOME_CARE_TENANT_INTEGRITY_DDL: ddl } = require('./migrations');
const socket = process.env.HOME_CARE_AUDIT_PG_SOCKET;
const integration = socket ? describe : describe.skip;

integration('home-care tenant constraints on isolated PostgreSQL', () => {
  let db;
  beforeAll(async () => {
    if (!socket.startsWith('/tmp/loyalpro-auth-tenant-pg')) throw new Error('Isolated socket required');
    db = new Client({ host: socket, port: 55439, user: 'postgres', database: 'postgres' });
    await db.connect();
  });
  afterAll(async () => { if (db) await db.end(); });
  beforeEach(async () => {
    await db.query('BEGIN');
    await db.query('CREATE SCHEMA audit_hcp');
    await db.query('SET LOCAL search_path = audit_hcp');
    await db.query(`
      CREATE TABLE salons(id int PRIMARY KEY);
      CREATE TABLE clients(id int PRIMARY KEY, salon_id int REFERENCES salons ON DELETE CASCADE);
      CREATE TABLE records(id int PRIMARY KEY, salon_id int REFERENCES salons ON DELETE CASCADE);
      CREATE TABLE users(id int PRIMARY KEY, salon_id int REFERENCES salons ON DELETE CASCADE);
      CREATE TABLE home_care_prescriptions(id int PRIMARY KEY, salon_id int REFERENCES salons ON DELETE CASCADE,
        client_id int REFERENCES clients ON DELETE SET NULL,
        record_id int REFERENCES records ON DELETE SET NULL,
        specialist_id int REFERENCES users ON DELETE SET NULL);
      INSERT INTO salons VALUES (1),(2);
      INSERT INTO clients VALUES (11,1),(22,2);
      INSERT INTO records VALUES (11,1),(22,2);
      INSERT INTO users VALUES (11,1),(22,2);
    `);
    await db.query(ddl);
  });
  afterEach(async () => { await db.query('ROLLBACK'); });

  test('DDL is idempotent; valid and nullable links remain writable', async () => {
    await db.query(ddl);
    await db.query('INSERT INTO home_care_prescriptions VALUES (1,1,11,11,11),(2,1,NULL,NULL,NULL)');
    expect((await db.query('SELECT count(*)::int AS n FROM home_care_prescriptions')).rows[0].n).toBe(2);
  });
  test('NOT VALID preserves existing rows without weakening new writes', async () => {
    await db.query('ALTER TABLE home_care_prescriptions DROP CONSTRAINT fk_hcp_salon_client');
    await db.query('INSERT INTO home_care_prescriptions VALUES(1,1,22,NULL,NULL)');
    await db.query(ddl);
    expect((await db.query('SELECT client_id FROM home_care_prescriptions WHERE id=1')).rows[0].client_id).toBe(22);
    await expect(db.query('INSERT INTO home_care_prescriptions VALUES(2,1,22,NULL,NULL)'))
      .rejects.toMatchObject({ code: '23503' });
  });
  test('category sync changes only the requested salon for a shared external good id', async () => {
    await db.query(`CREATE TABLE goods_sales(id int PRIMARY KEY,salon_id int);
      CREATE TABLE goods_sale_items(sale_id int,yclients_goods_id int,yclients_category text);
      INSERT INTO goods_sales VALUES(1,1),(2,2);
      INSERT INTO goods_sale_items VALUES(1,777,'old-A'),(2,777,'old-B');`);
    const exported = { exports: {} };
    require('vm').runInNewContext(require('fs').readFileSync(require('path').join(__dirname,'services/home-care.js'),'utf8'), {
      module: exported, setTimeout,
      require: name => {
        if (name === '../db') return { db };
        if (name === './yclients') return {
          clearTreeCache() {},
          ycGet: async (_salon,url) => url.includes('good_categories') ? [] : [{ good_id:777,category:'new-A' }],
        };
        throw new Error('Unexpected dependency');
      },
    });
    await exported.exports.syncGoodsCategories({ id:1,yclients_company_id:1,yclients_user_token:'synthetic' });
    expect((await db.query('SELECT yclients_category FROM goods_sale_items ORDER BY sale_id')).rows)
      .toEqual([{ yclients_category:'new-A' },{ yclients_category:'old-B' }]);
  });
  test.each(['client_id','record_id','specialist_id'])('rejects foreign %s on insert and update', async column => {
    await db.query('SAVEPOINT invalid_insert');
    await expect(db.query(`INSERT INTO home_care_prescriptions(id,salon_id,${column}) VALUES(1,1,22)`))
      .rejects.toMatchObject({ code: '23503' });
    await db.query('ROLLBACK TO SAVEPOINT invalid_insert');
    await db.query('INSERT INTO home_care_prescriptions VALUES(1,1,11,11,11)');
    await expect(db.query(`UPDATE home_care_prescriptions SET ${column}=22 WHERE id=1`))
      .rejects.toMatchObject({ code: '23503' });
  });
  test.each([['clients','client_id'],['records','record_id'],['users','specialist_id']])(
    'preserves SET NULL when deleting %s', async (table,column) => {
      await db.query('INSERT INTO home_care_prescriptions VALUES(1,1,11,11,11)');
      await db.query(`DELETE FROM ${table} WHERE id=11`);
      const row = (await db.query('SELECT * FROM home_care_prescriptions')).rows[0];
      expect(row[column]).toBeNull(); expect(row.salon_id).toBe(1);
    });
  test('salon cascade remains possible', async () => {
    await db.query('INSERT INTO home_care_prescriptions VALUES(1,1,11,11,11)');
    await db.query('DELETE FROM salons WHERE id=1');
    expect((await db.query('SELECT * FROM home_care_prescriptions')).rows).toEqual([]);
  });
  test.each(['clients','records','users'])('prevents moving linked %s to a different salon', async table => {
    await db.query('INSERT INTO home_care_prescriptions VALUES(1,1,11,11,11)');
    await expect(db.query(`UPDATE ${table} SET salon_id=2 WHERE id=11`)).rejects.toMatchObject({ code:'23503' });
  });
});
