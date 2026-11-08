#!/usr/bin/env node
/**
 * Восстановление базы знаний Милы (+ подкатегории «Услуг агента» и фото прайсов)
 * из снимка прода на 31.10.2026 — после потери прод-БД на Beget (02.11.2026).
 *
 * Источник — артефакты правки цен 31.10 (`peri-clinnic.ru/artifacts/kb-price-20261031`):
 *   articles-before.json  — все статьи салона 1 ДО правки (42 шт.)
 *   chunks-before.json    — их чанки с эмбеддингами
 *   plan.json             — новые тексты 24 статей (две из них — новые), которые
 *                           apply.cjs в тот же вечер записал в прод
 *   agent_service_subcategories-before.json, photos-verified.json, cards-manifest.json,
 *   cards/                — подкатегории и итоговые фото прайсов после attach-cards.cjs
 * Категории базы знаний в снимке нет: 1–9 берутся из дев-бэкапа 19.07 (те же id —
 * контент 16.07 переносился с дева), 10 и 19 названы по содержимому.
 *
 * Итог = состояние прода после правки 31.10. Чанки режутся ТЕМ ЖЕ chunkArticle, что у
 * бэкенда; эмбеддинг берётся из снимка по хэшу текста, отсутствующие считаются заново.
 *
 *   node scripts/kb-restore-from-snapshot.js --snapshot <dir> --categories <dev-backup.json> [--commit]
 * Без --commit — только отчёт. Требует пустую базу знаний салона (повтор не задвоит).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { pool } = require('../db');
const rag = require('../services/agent-rag');
const kb = require('../services/kb-assistant');

const SALON = 1;
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const COMMIT = process.argv.includes('--commit');
const SNAP = arg('--snapshot');
const CATS = arg('--categories');
const UPLOADS = arg('--uploads') || path.join(__dirname, '../../frontend/uploads');
if (!SNAP || !CATS) { console.error('нужны --snapshot <dir> и --categories <json>'); process.exit(2); }
const read = f => JSON.parse(fs.readFileSync(path.join(SNAP, f), 'utf8'));

// Названия по содержимому статей: в архивах категории 10 и 19 не сохранились.
const INFERRED_CATEGORIES = [
  { id: 10, title: 'Касса и оборудование', icon: '🧾' },
  { id: 19, title: 'Специалисты клиники', icon: '👩‍⚕️' },
];
// Новым статьям плана прод выдал id по порядку после максимума (apply.cjs, 31.10).
const NEW_ARTICLE_FIRST_ID = 51;

(async () => {
  const articlesBefore = read('articles-before.json');
  const chunksBefore = read('chunks-before.json');
  const plan = read('plan.json');
  const subcats = read('agent_service_subcategories-before.json');
  const photos = read('photos-verified.json');
  const manifest = read('cards-manifest.json');
  const devCats = JSON.parse(fs.readFileSync(CATS, 'utf8')).kb_categories;

  // ── статьи: снимок + правка 31.10 ────────────────────────────────────────
  const byId = new Map(articlesBefore.map(a => [a.id, { ...a }]));
  let nextId = NEW_ARTICLE_FIRST_ID;
  let mismatched = 0;
  for (const p of plan) {
    if (p.id) {
      const a = byId.get(p.id);
      assert(a, `статьи ${p.id} нет в снимке`);
      if (a.body !== p.before) { mismatched++; console.warn(`WARN статья ${p.id}: тело в снимке ≠ plan.before`); }
      a.body = p.body;
    } else {
      assert(!byId.has(nextId));
      byId.set(nextId, {
        id: nextId, salon_id: SALON, category_id: 1, title: p.title, body: p.body,
        tags: ['прайс', 'стоимость', '2026-10-31'], tags_text: 'прайс стоимость 2026-10-31',
        is_published: true, internal_only: false, display_order: null,
        created_at: '2026-10-31T20:10:00Z', updated_at: '2026-10-31T20:10:00Z',
      });
      nextId++;
    }
  }
  const articles = [...byId.values()].sort((a, b) => a.id - b.id);
  const maxOrder = Math.max(...articles.filter(a => a.category_id === 1).map(a => a.display_order || 0));
  let o = maxOrder;
  for (const a of articles) if (a.display_order == null) a.display_order = ++o;

  const catIds = new Set(articles.map(a => a.category_id));
  const categories = [
    ...devCats.map(c => ({ id: c.id, title: c.title, icon: c.icon, display_order: c.display_order })),
    ...INFERRED_CATEGORIES.map((c, i) => ({ ...c, display_order: 100 + i })),
  ];
  for (const id of catIds) assert(categories.some(c => c.id === id), `нет категории ${id}`);

  // ── чанки: тот же chunkArticle, эмбеддинг по хэшу из снимка ─────────────
  const reuse = new Map(chunksBefore.filter(c => c.embedding && c.embedding.length).map(c => [c.content_hash, c.embedding]));
  const chunks = [];
  let reused = 0, toCompute = 0;
  for (const a of articles) {
    for (const c of rag.chunkArticle(a)) {
      const hash = rag.hashChunk(c.content);
      const emb = reuse.get(hash) || null;
      emb ? reused++ : toCompute++;
      chunks.push({ article_id: a.id, chunk_index: c.chunk_index, content: c.content, hash, embedding: emb });
    }
  }

  // ── фото прайсов: итог attach-cards (photos-verified) + порядок из манифеста ─
  const orderByName = new Map();
  for (const node of new Set(manifest.map(c => c.node))) {
    manifest.filter(c => c.node === node).forEach((c, i) => orderByName.set(c.name, i + 1));
  }
  const missingFiles = photos.filter(p => !fs.existsSync(path.join(SNAP, 'cards', p.file_name)));

  console.log(`категорий ${categories.length}, статей ${articles.length} (правка 31.10: ${plan.length}, расхождений plan.before ${mismatched})`);
  console.log(`чанков ${chunks.length}: эмбеддинг из снимка ${reused}, посчитать заново ${toCompute}`);
  console.log(`подкатегорий услуг агента ${subcats.length}, фото прайсов ${photos.length} (нет файла: ${missingFiles.length})`);
  if (!COMMIT) { console.log('сухой прогон — для записи добавьте --commit'); process.exit(0); }
  assert.equal(missingFiles.length, 0, 'не хватает файлов фото');

  for (const c of chunks) if (!c.embedding) { c.embedding = await kb.embedText(c.content); assert(c.embedding.length > 0); }

  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const busy = await conn.query(
      `SELECT (SELECT count(*) FROM kb_articles WHERE salon_id=$1) a,
              (SELECT count(*) FROM agent_price_photos WHERE salon_id=$1) p,
              (SELECT count(*) FROM agent_service_subcategories WHERE salon_id=$1) s`, [SALON]);
    assert.deepEqual(Object.values(busy.rows[0]).map(Number), [0, 0, 0], 'база знаний/фото/подкатегории салона уже не пустые');

    for (const c of categories) {
      await conn.query(`INSERT INTO kb_categories (id,salon_id,title,icon,display_order) VALUES ($1,$2,$3,$4,$5)
                        ON CONFLICT (id) DO NOTHING`, [c.id, SALON, c.title, c.icon || null, c.display_order || 0]);
    }
    for (const a of articles) {
      await conn.query(
        `INSERT INTO kb_articles (id,salon_id,category_id,title,body,tags,tags_text,is_published,display_order,internal_only,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [a.id, SALON, a.category_id, a.title, a.body, a.tags || [], a.tags_text || '', a.is_published !== false,
         a.display_order, !!a.internal_only, a.created_at, a.updated_at]);
    }
    for (const c of chunks) {
      await conn.query(
        `INSERT INTO kb_chunks (salon_id,article_id,chunk_index,content,content_hash,embedding,embed_norm)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [SALON, c.article_id, c.chunk_index, c.content, c.hash, c.embedding, rag.vectorNorm(c.embedding)]);
    }
    for (const s of [...subcats].sort((x, y) => x.id - y.id)) {
      await conn.query(
        `INSERT INTO agent_service_subcategories (id,salon_id,yc_category_id,parent_id,title,display_order,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [s.id, SALON, s.yc_category_id, s.parent_id, s.title, s.display_order, s.created_at, s.updated_at]);
    }
    fs.mkdirSync(UPLOADS, { recursive: true });
    for (const p of photos) {
      fs.copyFileSync(path.join(SNAP, 'cards', p.file_name), path.join(UPLOADS, p.file_name));
      await conn.query(
        `INSERT INTO agent_price_photos (id,salon_id,yc_category_id,subcategory_id,file_url,file_name,mime_type,byte_size,display_order)
         VALUES ($1,$2,$3,$4,$5,$6,'image/png',$7,$8)`,
        [p.id, SALON, p.yc_category_id, p.subcategory_id, p.file_url, p.file_name, p.byte_size, orderByName.get(p.file_name) || 1]);
    }
    for (const t of ['kb_categories', 'kb_articles', 'kb_chunks', 'agent_service_subcategories', 'agent_price_photos']) {
      await conn.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), (SELECT COALESCE(max(id),1) FROM ${t}))`);
    }
    await conn.query('COMMIT');
  } catch (e) { await conn.query('ROLLBACK'); throw e; } finally { conn.release(); }

  const v = await pool.query(
    `SELECT (SELECT count(*) FROM kb_articles WHERE salon_id=$1) a, (SELECT count(*) FROM kb_chunks WHERE salon_id=$1) c,
            (SELECT count(*) FROM kb_chunks WHERE salon_id=$1 AND (embedding IS NULL OR array_length(embedding,1) IS NULL)) noemb,
            (SELECT count(*) FROM agent_price_photos WHERE salon_id=$1) p`, [SALON]);
  console.log('ЗАПИСАНО', v.rows[0]);
  process.exit(0);
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
