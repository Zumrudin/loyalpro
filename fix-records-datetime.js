// One-time fix: update visit_datetime and visit_date from raw_payload for rescheduled records
// Run once: node fix-records-datetime.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function main() {
  const client = await pool.connect();
  try {
    // Find records where raw_payload.date differs from stored visit_datetime by more than 1 minute
    const { rows: mismatched } = await client.query(`
      SELECT id,
             visit_datetime,
             (raw_payload->>'date') as yc_date,
             (raw_payload->>'date')::timestamptz as yc_dt,
             EXTRACT(EPOCH FROM (visit_datetime - (raw_payload->>'date')::timestamptz)) as diff_secs
      FROM records
      WHERE raw_payload->>'date' IS NOT NULL
        AND visit_datetime IS NOT NULL
        AND ABS(EXTRACT(EPOCH FROM (visit_datetime - (raw_payload->>'date')::timestamptz))) > 60
      ORDER BY id
    `);

    console.log(`Found ${mismatched.length} mismatched records`);
    if (mismatched.length === 0) { console.log('Nothing to fix.'); return; }

    for (const r of mismatched) {
      console.log(`  id=${r.id}: stored=${r.visit_datetime.toISOString()} yc_date=${r.yc_date} diff=${Math.round(r.diff_secs/60)}min`);
    }

    // Apply fix
    const { rowCount } = await client.query(`
      UPDATE records
      SET visit_datetime = (raw_payload->>'date')::timestamptz,
          visit_date     = (raw_payload->>'date')::date,
          updated_at     = NOW()
      WHERE raw_payload->>'date' IS NOT NULL
        AND visit_datetime IS NOT NULL
        AND ABS(EXTRACT(EPOCH FROM (visit_datetime - (raw_payload->>'date')::timestamptz))) > 60
    `);

    console.log(`\nFixed ${rowCount} records.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
