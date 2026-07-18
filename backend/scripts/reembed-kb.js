'use strict';

// Разовый переэмбеддинг ВСЕЙ базы знаний новой моделью (смена провайдера).
// content_hash не меняется при смене модели → reembedArticle пропустил бы чанки,
// поэтому идём напрямую по kb_chunks и пересчитываем безусловно.
//
// Запуск (после деплоя кода и установки env):
//   KB_PROVIDER=aitunnel AITUNNEL_API_KEY=sk-aitunnel-... node scripts/reembed-kb.js

const { db } = require('../db');
const kbAssistant = require('../services/kb-assistant');
const { vectorNorm } = require('../services/agent-rag');
const config = require('../config');

async function main() {
  if (config.KB_PROVIDER !== 'aitunnel') {
    console.warn(`ВНИМАНИЕ: KB_PROVIDER=${config.KB_PROVIDER} (не aitunnel). Переэмбеддинг пойдёт текущим провайдером.`);
  }
  const rows = await db.any(`SELECT id, content FROM kb_chunks ORDER BY id`);
  console.log(`Переэмбеддинг ${rows.length} чанков моделью ${config.AITUNNEL_EMBED_MODEL} (dim ${config.AITUNNEL_EMBED_DIM})...`);

  let done = 0, failed = 0;
  for (const r of rows) {
    try {
      const emb = await kbAssistant.embedText(r.content);
      const norm = vectorNorm(emb);
      await db.query(
        `UPDATE kb_chunks SET embedding=$1, embed_norm=$2, updated_at=now() WHERE id=$3`,
        [emb, norm, r.id]);
      done++;
      if (done % 25 === 0) console.log(`  прогресс: ${done}/${rows.length}`);
    } catch (e) {
      failed++;
      console.error(`  чанк ${r.id} провалился: ${e.message}`);
    }
  }
  console.log(`Готово: ${done} успешно, ${failed} с ошибкой из ${rows.length}.`);
  await db.$pool?.end?.();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
