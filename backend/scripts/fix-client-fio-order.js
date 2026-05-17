#!/usr/bin/env node
// Backfill clients.name from "Имя Фамилия Отчество" → "Фамилия Имя Отчество".
//
// Bug: until 2026-05-17 the YClients sync joined name parts as
//   [name, surname, patronymic]  →  "Иван Петров Сидорович"
// while correct ФИО order is
//   [surname, name, patronymic]  →  "Петров Иван Сидорович".
//
// Safety guard: only rows where clients.name == the broken concat get rewritten.
// Anything an admin manually edited is left alone.
//
// Usage:
//   node backend/scripts/fix-client-fio-order.js             # dry-run, prints diff + counts
//   node backend/scripts/fix-client-fio-order.js --apply     # actually update
//   node backend/scripts/fix-client-fio-order.js --limit 20  # cap dry-run output
//
// Reads DATABASE_URL from backend/config (same as the app), so pointing the
// script at prod is just `DATABASE_URL=... node backend/scripts/...`.

const { pool, db } = require('../db');
const { buildClientFio, isLegacyBrokenOrder } = require('../utils/client-name');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArg = args.find(a => a.startsWith('--limit='));
const previewLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) || 20 : 20;

async function main() {
  const rows = await db.any(
    `SELECT id, salon_id, name, yclients_client_id, yclients_data
       FROM clients
      WHERE yclients_data IS NOT NULL
        AND COALESCE(yclients_data->>'surname','') <> ''
      ORDER BY id`
  );

  let toUpdate = 0;
  let skippedManual = 0;
  let alreadyCorrect = 0;
  const previewSample = [];

  for (const r of rows) {
    const yc = r.yclients_data;
    const proposed = buildClientFio(yc);
    const current = (r.name || '').trim();
    if (proposed === current) { alreadyCorrect++; continue; }
    if (!isLegacyBrokenOrder(yc, current)) { skippedManual++; continue; }
    toUpdate++;
    if (previewSample.length < previewLimit) {
      previewSample.push({ id: r.id, salon_id: r.salon_id, before: current, after: proposed });
    }
  }

  console.log(`\n=== fix-client-fio-order (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`Database:                ${process.env.DATABASE_URL ? '(from DATABASE_URL env)' : '(from config)'}`);
  console.log(`Candidates (surname set): ${rows.length}`);
  console.log(`Already correct:          ${alreadyCorrect}`);
  console.log(`Skipped (manual edits):   ${skippedManual}`);
  console.log(`To update:                ${toUpdate}`);
  console.log(`\nSample (first ${previewSample.length}):`);
  for (const s of previewSample) {
    console.log(`  #${s.id} salon=${s.salon_id}`);
    console.log(`     before: ${s.before}`);
    console.log(`     after:  ${s.after}`);
  }

  if (!APPLY) {
    console.log(`\nDry-run only. Re-run with --apply to write changes.`);
    return;
  }

  if (toUpdate === 0) {
    console.log(`\nNothing to update.`);
    return;
  }

  console.log(`\nApplying ${toUpdate} updates...`);
  let done = 0;
  for (const r of rows) {
    const yc = r.yclients_data;
    const proposed = buildClientFio(yc);
    const current = (r.name || '').trim();
    if (proposed === current) continue;
    if (!isLegacyBrokenOrder(yc, current)) continue;

    // Defensive: re-check current name in DB hasn't changed since we read it.
    const res = await pool.query(
      `UPDATE clients SET name=$1, updated_at=NOW()
        WHERE id=$2 AND name=$3`,
      [proposed, r.id, r.name]
    );
    done += res.rowCount;
  }
  console.log(`Updated rows: ${done}`);
}

main()
  .then(() => pool.end())
  .catch(e => {
    console.error('ERROR:', e.message);
    pool.end();
    process.exit(1);
  });
