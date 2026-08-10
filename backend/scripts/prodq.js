// Ad-hoc read-only query against the PROD database (loyalpro) via the same
// SSH tunnel the dev box uses for loyalpro_test. Usage:
//   cd backend && node scripts/prodq.js "select 1"
require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const sql = process.argv[2];
  if (!sql) { console.error('usage: node scripts/prodq.js "<sql>"'); process.exit(2); }
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/loyalpro';
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const r = await c.query(sql);
    console.log(JSON.stringify(r.rows, null, 2));
  } finally {
    await c.end();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
