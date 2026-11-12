'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db, pool } = require('../db');
const mirror = require('../services/journal/mirror');
const yc = require('../services/journal/yclients');

const usage = () => console.log('Usage: node scripts/journal-mirror-backfill.js --salon=1 [--days=120] [--write]');

(async () => {
  let salonId = null, days = 120, write = false;
  for (const a of process.argv.slice(2)) {
    let m;
    if (a === '--write') write = true;
    else if ((m = a.match(/^--salon=(\d+)$/))) salonId = Number(m[1]);
    else if ((m = a.match(/^--days=(\d+)$/))) days = Number(m[1]);
    else { usage(); process.exit(2); }
  }
  if (!salonId) { usage(); process.exit(2); }
  try {
    const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
    if (!salon) { console.log('salon not found'); process.exitCode = 1; return; }
    const today = mirror.todayMsk();
    const end = mirror.shiftDate(today, days);
    const tot = { yclients: 0, local: 0, missingLocal: 0, extraLocal: 0, upserted: 0, deleted: 0, moved: 0 };
    for (let from = mirror.shiftDate(today, -1); from <= end; from = mirror.shiftDate(from, 14)) {
      const to = mirror.shiftDate(from, 13) < end ? mirror.shiftDate(from, 13) : end;
      if (write) {
        const r = await mirror.syncWindow(salon, from, to);
        console.log(`${from}..${to} upserted=${r.upserted} deleted=${r.deleted} moved=${r.moved}`);
        for (const k of ['upserted', 'deleted', 'moved']) tot[k] += r[k];
      } else {
        const list = await yc.records(salon, from, to);
        const rows = await db.any(`SELECT yclients_record_id FROM records WHERE salon_id=$1 AND visit_date BETWEEN $2::date AND $3::date AND status<>'deleted'`, [salonId, from, to]);
        const l = new Set(rows.map(r => String(r.yclients_record_id)));
        const y = new Set(list.map(r => String(r.id)));
        const missingLocal = [...y].filter(i => !l.has(i)).length;
        const extraLocal = [...l].filter(i => !y.has(i)).length;
        console.log(`${from}..${to} yclients=${y.size} local=${l.size} missingLocal=${missingLocal} extraLocal=${extraLocal}`);
        tot.yclients += y.size; tot.local += l.size; tot.missingLocal += missingLocal; tot.extraLocal += extraLocal;
      }
    }
    console.log('TOTAL', JSON.stringify(write ? { upserted: tot.upserted, deleted: tot.deleted, moved: tot.moved } : { yclients: tot.yclients, local: tot.local, missingLocal: tot.missingLocal, extraLocal: tot.extraLocal }));
  } catch (e) {
    console.log('failed:', (e && (e.status || e.code)) || 'error');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
