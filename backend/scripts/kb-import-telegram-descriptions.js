'use strict';

// Импорт дополнений базы знаний по материалам Telegram-канала (данные —
// scripts/kb-content/telegram-service-descriptions-2026-09.js, спека —
// docs/superpowers/specs/2026-09-28-kb-telegram-service-descriptions-design.md).
//
// Что делает: к существующим статьям салона ДОПИСЫВАЕТ раздел (маркер идемпотентности —
// его заголовок SECTION_HEADING: статья с ним пропускается), недостающие статьи СОЗДАЁТ,
// затем переэмбеддит каждую изменённую статью (`agent-rag.reembedArticle`) и ПРОВЕРЯЕТ,
// что чанки в БД равны `chunkArticle(body)` и у всех есть эмбеддинг — роут КБ глотает сбой
// переэмбеддинга, и статья остаётся невидимой для Милы (память kb_reembed_silent_stale).
//
// Запуск из backend/:
//   node scripts/kb-import-telegram-descriptions.js                 # dry-run, БД из .env
//   node scripts/kb-import-telegram-descriptions.js --db loyalpro   # dry-run по проду (туннель)
//   node scripts/kb-import-telegram-descriptions.js --db loyalpro --commit
//   node scripts/kb-import-telegram-descriptions.js --db loyalpro --probe   # только прогон поиска
// Флаги: --salon <id> (дефолт 1), --only key1,key2 (подмножество записей), --probe.
//
// --db подменяет ТОЛЬКО имя базы в DATABASE_URL (dev и prod живут на одном сервере Beget,
// см. память dev_db_access_tunnel). Подмена сделана ДО require('../db'): dotenv уже
// заданный env не перезаписывает, а config читает process.env при require.

require('dotenv').config();

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const DB_NAME = opt('--db', null);
if (DB_NAME) {
  if (!/^[a-z0-9_]+$/i.test(DB_NAME)) { console.error('bad --db'); process.exit(2); }
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/' + DB_NAME;
  process.env.DATABASE_URL = u.toString();
}
const SALON_ID = parseInt(opt('--salon', '1'), 10);
const COMMIT = flag('--commit');
const PROBE = flag('--probe');
const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',').map(s => s.trim())) : null;

const { db } = require('../db');
const rag = require('../services/agent-rag');
const { normalizeTags } = require('../services/knowledge-base');
const data = require('./kb-content/telegram-service-descriptions-2026-09');

const dbLabel = DB_NAME || new URL(process.env.DATABASE_URL).pathname.slice(1);

function paragraphStats(body) {
  const paras = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const longest = paras.reduce((m, p) => Math.max(m, p.length), 0);
  return { paras: paras.length, longest };
}

async function verifyArticle(id) {
  const art = await db.oneOrNone(`SELECT id, title, body FROM kb_articles WHERE id=$1`, [id]);
  if (!art) return ['статья не найдена'];
  const want = rag.chunkArticle({ title: art.title, body: art.body });
  const have = await db.any(
    `SELECT chunk_index, content, embedding IS NOT NULL AS emb, array_length(embedding,1) AS dim
       FROM kb_chunks WHERE article_id=$1 ORDER BY chunk_index`, [id]);
  const bad = [];
  if (have.length !== want.length) bad.push(`чанков ${have.length}, ожидалось ${want.length}`);
  want.forEach((w, i) => {
    const h = have[i];
    if (!h) return;
    if (h.content !== w.content) bad.push(`чанк ${i}: содержимое отличается`);
    if (!h.emb) bad.push(`чанк ${i}: нет эмбеддинга`);
  });
  return bad;
}

async function planAppends() {
  const out = [];
  for (const a of data.appends) {
    if (ONLY && !ONLY.has(a.key)) continue;
    const rows = await db.any(
      `SELECT id, title, body, tags FROM kb_articles WHERE salon_id=$1 AND title ~* $2 ORDER BY id`,
      [SALON_ID, a.match.source]);
    if (rows.length !== 1) {
      out.push({ key: a.key, status: 'error', note: `по /${a.match.source}/ найдено статей: ${rows.length}` });
      continue;
    }
    const art = rows[0];
    if (art.body.includes(data.SECTION_HEADING)) {
      out.push({ key: a.key, id: art.id, title: art.title, status: 'skip', note: 'раздел уже есть' });
      continue;
    }
    const newBody = art.body.trimEnd() + '\n\n' + a.section.trim() + '\n';
    const tags = normalizeTags([...(art.tags || []), ...(a.addTags || [])]);
    out.push({ key: a.key, id: art.id, title: art.title, status: 'append', newBody, tags,
      added: a.section.trim().length, stats: paragraphStats(newBody) });
  }
  return out;
}

async function planCreates() {
  const out = [];
  for (const c of data.creates) {
    if (ONLY && !ONLY.has(c.key)) continue;
    const cat = await db.oneOrNone(
      `SELECT id FROM kb_categories WHERE salon_id=$1 AND title=$2`, [SALON_ID, c.category]);
    if (!cat) { out.push({ key: c.key, status: 'error', note: `нет папки «${c.category}»` }); continue; }
    const dup = await db.oneOrNone(
      `SELECT id FROM kb_articles WHERE salon_id=$1 AND title=$2`, [SALON_ID, c.title]);
    if (dup) { out.push({ key: c.key, id: dup.id, title: c.title, status: 'skip', note: 'уже существует' }); continue; }
    out.push({ key: c.key, title: c.title, status: 'create', categoryId: cat.id,
      body: c.body.trim() + '\n', tags: normalizeTags(c.tags), internalOnly: c.internal_only === true,
      stats: paragraphStats(c.body) });
  }
  return out;
}

const PROBE_QUERIES = [
  'сколько процедур лазерной эпиляции нужно',
  'нужно ли отращивать волосы перед лазерной эпиляцией',
  'чем Morpheus8 отличается от Volnewmer',
  'как проходит чистка лица',
  'липолитики какие зоны',
  'когда виден эффект ботокса',
  'Lumecca это лазер',
  'плазмотерапия и Pladuo одно и то же',
  'можно ли записаться только на маску',
  'удаление папиллом',
];

async function probe() {
  console.log(`\n== Прогон поиска (retrieveChunks, salon ${SALON_ID}, БД ${dbLabel}) ==`);
  for (const q of PROBE_QUERIES) {
    const chunks = await rag.retrieveChunks(SALON_ID, q, { limit: 4 });
    const ids = [...new Set(chunks.map(c => c.article_id))];
    const titles = ids.length
      ? (await db.any(`SELECT id, title FROM kb_articles WHERE id = ANY($1::int[])`, [ids]))
      : [];
    const byId = new Map(titles.map(t => [t.id, t.title]));
    const newSection = chunks.some(c => c.content.includes(data.SECTION_HEADING.replace(/^## /, '')) ||
      /Комбинированная чистка|Липолитики —|Чем отличаются процедуры/.test(c.content.split('\n')[0]));
    console.log(`\n«${q}» → ${newSection ? 'НОВЫЙ контент в выдаче' : 'новый контент НЕ в выдаче'}`);
    for (const c of chunks) console.log(`   #${c.article_id} ${byId.get(c.article_id)} :: ${c.content.replace(/\s+/g, ' ').slice(0, 110)}…`);
  }
}

async function main() {
  console.log(`БД: ${dbLabel}, salon_id=${SALON_ID}, режим: ${COMMIT ? 'COMMIT' : 'dry-run'}`);
  if (PROBE && !COMMIT) { await probe(); return; }

  const appends = await planAppends();
  const creates = await planCreates();
  const plan = [...appends, ...creates];
  for (const p of plan) {
    const extra = p.stats ? ` (абзацев ${p.stats.paras}, самый длинный ${p.stats.longest} симв.)` : '';
    console.log(`  [${p.status}] ${p.key}${p.id ? ' #' + p.id : ''} ${p.title || ''}${p.note ? ' — ' + p.note : ''}${p.added ? ' +' + p.added + ' симв.' : ''}${extra}`);
    if (p.stats && p.stats.longest > rag.DEFAULT_MAX_CHARS) {
      console.log(`     ВНИМАНИЕ: абзац длиннее ${rag.DEFAULT_MAX_CHARS} — будет разрезан hardSplit посреди текста`);
    }
  }
  const errors = plan.filter(p => p.status === 'error');
  if (errors.length) { console.error(`\nОшибок планирования: ${errors.length} — ничего не пишем.`); process.exitCode = 1; return; }
  const todo = plan.filter(p => p.status === 'append' || p.status === 'create');
  console.log(`\nК записи: ${todo.length} (дописать ${appends.filter(p => p.status === 'append').length}, создать ${creates.filter(p => p.status === 'create').length}), пропущено ${plan.length - todo.length}.`);
  if (!COMMIT) { console.log('Dry-run: добавьте --commit для записи.'); return; }

  const changedIds = [];
  for (const p of todo) {
    if (p.status === 'append') {
      await db.query(
        `UPDATE kb_articles SET body=$1, tags=$2, tags_text=$3, updated_at=now() WHERE id=$4 AND salon_id=$5`,
        [p.newBody, p.tags, p.tags.join(' '), p.id, SALON_ID]);
      changedIds.push(p.id);
      console.log(`  дописано #${p.id} ${p.title}`);
    } else {
      const next = await db.one(
        `SELECT COALESCE(MAX(display_order),0)+1 AS next FROM kb_articles WHERE salon_id=$1 AND category_id=$2`,
        [SALON_ID, p.categoryId]);
      const row = await db.one(
        `INSERT INTO kb_articles (salon_id, category_id, title, body, tags, tags_text, is_published, internal_only, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8) RETURNING id`,
        [SALON_ID, p.categoryId, p.title, p.body, p.tags, p.tags.join(' '), p.internalOnly, next.next]);
      changedIds.push(row.id);
      console.log(`  создано #${row.id} ${p.title}${p.internalOnly ? ' (internal_only)' : ''}`);
    }
  }

  console.log('\nПереэмбеддинг…');
  let failed = 0;
  for (const id of changedIds) {
    try {
      await rag.reembedArticle(SALON_ID, id);
    } catch (e) {
      failed++;
      console.error(`  #${id}: reembed упал: ${e.message}`);
    }
    const bad = await verifyArticle(id);
    if (bad.length) { failed++; console.error(`  #${id}: ПРОВЕРКА НЕ ПРОШЛА — ${bad.join('; ')}`); }
    else console.log(`  #${id}: чанки ок`);
  }
  if (failed) {
    console.error(`\nПроблемных статей: ${failed}. Повторите запуск (идемпотентно) или reembedArticle(${SALON_ID}, id) вручную.`);
    process.exitCode = 1;
  } else {
    console.log('\nГотово: все изменённые статьи переэмбеддены и проверены.');
  }
  if (PROBE) await probe();
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => { try { await db.$pool?.end?.(); } catch (_) {} setTimeout(() => process.exit(), 200); });
