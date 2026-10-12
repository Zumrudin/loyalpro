'use strict';

// Идемпотентно добавляет проверенные FAQ из разбора пациентских вопросов в уже
// существующие статьи КБ. Dry-run по умолчанию. Запись разрешена только в
// loyalpro_test; перенос в production делается отдельно после проверки.

require('dotenv').config();

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DB_NAME = opt('--db', null);
const COMMIT = flag('--commit');
const ALLOW_PRODUCTION = flag('--allow-production');
const SALON_ID = Number.parseInt(opt('--salon', '1'), 10);
const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',').map(s => s.trim()).filter(Boolean)) : null;

if (!Number.isInteger(SALON_ID) || SALON_ID < 1) throw new Error('bad --salon');
if (DB_NAME) {
  if (!/^[a-z0-9_]+$/i.test(DB_NAME)) throw new Error('bad --db');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${DB_NAME}`;
  process.env.DATABASE_URL = url.toString();
}

const dbLabel = DB_NAME || new URL(process.env.DATABASE_URL).pathname.slice(1);
if (COMMIT && dbLabel !== 'loyalpro_test' && !(dbLabel === 'loyalpro' && ALLOW_PRODUCTION)) {
  throw new Error('production требует явных флагов --db loyalpro --commit --allow-production');
}

const { db } = require('../db');
const rag = require('../services/agent-rag');
const { normalizeTags } = require('../services/knowledge-base');
const data = require('./kb-content/patient-questions-by-service-2026-10');

function containsMoney(text) {
  return /(?:\d[\d ]{1,}\s*(?:₽|руб\.?))|(?:от|до)\s+\d[\d ]{2,}/iu.test(String(text || ''));
}

function buildUpdatedBody(body, section) {
  const source = String(body || '').trimEnd();
  if (source.includes(data.SECTION_HEADING)) return null;
  return `${source}\n\n${section.trim()}\n`;
}

async function planChanges() {
  const plan = [];
  for (const item of data.appends) {
    if (ONLY && !ONLY.has(item.key)) continue;
    if (containsMoney(item.section)) {
      plan.push({ key: item.key, status: 'error', note: 'в FAQ найдена денежная сумма' });
      continue;
    }
    const rows = await db.any(
      `SELECT id, title, body, tags, is_published, internal_only
         FROM kb_articles
        WHERE salon_id=$1 AND title ~* $2
        ORDER BY id`,
      [SALON_ID, item.match.source]);
    if (rows.length !== 1) {
      plan.push({ key: item.key, status: 'error', note: `по /${item.match.source}/ найдено статей: ${rows.length}` });
      continue;
    }
    const article = rows[0];
    if (!article.is_published || article.internal_only) {
      plan.push({ key: item.key, id: article.id, title: article.title, status: 'error', note: 'статья недоступна Миле' });
      continue;
    }
    const newBody = buildUpdatedBody(article.body, item.section);
    if (newBody === null) {
      plan.push({ key: item.key, id: article.id, title: article.title, status: 'skip', note: 'раздел уже есть' });
      continue;
    }
    plan.push({
      key: item.key,
      id: article.id,
      title: article.title,
      status: 'append',
      newBody,
      tags: normalizeTags([...(article.tags || []), ...(item.addTags || [])]),
    });
  }
  return plan;
}

async function verifyArticle(id) {
  const article = await db.oneOrNone(
    `SELECT id, title, body FROM kb_articles WHERE id=$1 AND salon_id=$2`,
    [id, SALON_ID]);
  if (!article) return ['статья не найдена'];
  const expected = rag.chunkArticle(article);
  const actual = await db.any(
    `SELECT chunk_index, content, embedding IS NOT NULL AS embedded
       FROM kb_chunks WHERE article_id=$1 AND salon_id=$2 ORDER BY chunk_index`,
    [id, SALON_ID]);
  const errors = [];
  if (actual.length !== expected.length) errors.push(`чанков ${actual.length}, ожидалось ${expected.length}`);
  expected.forEach((chunk, index) => {
    if (!actual[index]) return;
    if (actual[index].content !== chunk.content) errors.push(`чанк ${index}: содержимое отличается`);
    if (!actual[index].embedded) errors.push(`чанк ${index}: нет эмбеддинга`);
  });
  return errors;
}

async function main() {
  console.log(`БД: ${dbLabel}, salon_id=${SALON_ID}, режим: ${COMMIT ? 'COMMIT' : 'dry-run'}`);
  const plan = await planChanges();
  for (const item of plan) {
    console.log(`  [${item.status}] ${item.key}${item.id ? ` #${item.id}` : ''} ${item.title || ''}${item.note ? ` — ${item.note}` : ''}`);
  }
  const errors = plan.filter(item => item.status === 'error');
  if (errors.length) throw new Error(`ошибок планирования: ${errors.length}; ничего не записано`);
  const changes = plan.filter(item => item.status === 'append');
  console.log(`К записи: ${changes.length}; пропущено: ${plan.length - changes.length}.`);
  if (!COMMIT) return;

  for (const item of changes) {
    await db.query(
      `UPDATE kb_articles
          SET body=$1, tags=$2, tags_text=$3, updated_at=now()
        WHERE id=$4 AND salon_id=$5`,
      [item.newBody, item.tags, item.tags.join(' '), item.id, SALON_ID]);
    await rag.reembedArticle(SALON_ID, item.id);
    const problems = await verifyArticle(item.id);
    if (problems.length) throw new Error(`#${item.id}: ${problems.join('; ')}`);
    console.log(`  [ok] #${item.id} ${item.title}: обновлено и переиндексировано`);
  }
}

if (require.main === module) {
  main()
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(), 100));
}

module.exports = { buildUpdatedBody, containsMoney };
