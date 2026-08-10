// Read-only: печатает транскрипт, который увидела бы Мила, по ПРОД-базе.
//   cd backend && node scripts/prod-transcript.js <dialogKey> [salonId]
require('dotenv').config();
const u = new URL(process.env.DATABASE_URL);
u.pathname = '/loyalpro';
process.env.DATABASE_URL = u.toString();

const history = require('../services/agent/history');
const { db } = require('../db');

(async () => {
  const key = process.argv[2];
  const salonId = Number(process.argv[3] || 1);
  const t = await history.loadTranscript(salonId, key, { withTime: true });
  console.log('newSession:', JSON.stringify(t.session));
  console.log('hasEverAnswered:', await history.hasEverAnswered(salonId, key));
  console.log('--- messages ---');
  for (const m of t.messages) console.log(`[${m.role}] ${m.content}`);
  await db.query('SELECT 1');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
