'use strict';

// Разовый переэмбеддинг всех опубликованных статей во все kb_chunks.
// Запуск: node scripts/backfill-kb-chunks.js [salonId]
// salonId опционален — без него проходит по всем салонам.

const { db, pool } = require('../db');
const agentRag = require('../services/agent-rag');

async function main() {
  const salonArg = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  const rows = await db.any(
    salonArg
      ? `SELECT id, salon_id FROM kb_articles WHERE is_published = true AND salon_id = $1 ORDER BY id`
      : `SELECT id, salon_id FROM kb_articles WHERE is_published = true ORDER BY id`,
    salonArg ? [salonArg] : []);

  console.log(`Статей к обработке: ${rows.length}`);
  let done = 0, failed = 0;
  for (const r of rows) {
    try {
      await agentRag.reembedArticle(r.salon_id, r.id);
      done++;
      if (done % 10 === 0) console.log(`  ...${done}/${rows.length}`);
    } catch (e) {
      failed++;
      console.error(`  статья ${r.id}: ${e.message}`);
    }
  }
  console.log(`Готово. Успешно: ${done}, ошибок: ${failed}`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
