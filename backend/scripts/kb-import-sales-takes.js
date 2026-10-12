'use strict';

// Approved 2026-10-11 content-only import for PERI CLINIC. Default: dry-run.
// Production: --db loyalpro --commit --allow-production
// No schema, publication flags, service links, prices or agent settings change.
// Embeddings are prepared before the transaction; failures leave production intact.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const data = require('../../docs/content/mila-service-sales-draft-2026-10-10.json');
const SALON = 1;
const HEADING = '## Короткие тезисы для ответа об услуге';

function sectionFor(takes) {
  return HEADING + '\n\n' + takes.map(t =>
    `### ${t.service} — ${t.topic}\n${t.text}`
  ).join('\n\n') + '\n\n### Как использовать в ответе\n' +
    'Сначала ответить на вопрос пациента, затем при уместности добавить одну относящуюся к его запросу выгоду. ' +
    'Не повторять тезис в каждом сообщении; подбор метода, препарата и сочетаний оставить врачу. ' +
    'Описание препарата не подтверждает его наличие: доступность и цену проверять по актуальному каталогу; ' +
    'не переносить свойства на другой вариант препарата или на все препараты категории.\n';
}

function appendSection(body, section) {
  const original = String(body || '');
  if (original.includes(HEADING)) {
    if (!original.endsWith(section)) throw new Error('Existing sales section differs; manual review required');
    return original;
  }
  // Preserve every original byte, including trailing whitespace.
  return original + '\n\n' + section;
}

function assertUnchanged(current, original) {
  if (!current || current.salon_id !== SALON || current.body !== original.body ||
      current.title !== original.title || current.is_published !== original.is_published ||
      current.internal_only !== original.internal_only) {
    throw new Error(`Article changed concurrently: #${original.id}`);
  }
}

async function main() {
  require('dotenv').config({ quiet: true });
  const args = process.argv.slice(2);
  const dbName = args[args.indexOf('--db') + 1];
  if (!args.includes('--db') || !['loyalpro', 'loyalpro_test'].includes(dbName)) throw new Error('Explicit --db required');
  const commit = args.includes('--commit');
  if (commit && dbName === 'loyalpro' && !args.includes('--allow-production')) throw new Error('Production approval flag required');
  if (data.salon_id !== SALON || data.takes.length !== 48) throw new Error('Unexpected approved dataset');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + dbName;
  process.env.DATABASE_URL = url.toString();
  const { db, pool, withTransaction } = require('../db');
  const rag = require('../services/agent-rag');
  const assistant = require('../services/kb-assistant');
  const groups = new Map();
  for (const take of data.takes) {
    if (!groups.has(take.article_id)) groups.set(take.article_id, []);
    groups.get(take.article_id).push(take);
  }
  const ids = [...groups.keys()].sort((a, b) => a - b);
  try {
    const originals = await db.any(`SELECT id,salon_id,title,body,is_published,internal_only
      FROM kb_articles WHERE salon_id=$1 AND id=ANY($2::int[]) ORDER BY id`, [SALON, ids]);
    if (originals.length !== 29) throw new Error('Expected 29 source articles');
    const oldChunks = await db.any(`SELECT article_id,chunk_index,content,content_hash,embedding,embed_norm
      FROM kb_chunks WHERE salon_id=$1 AND article_id=ANY($2::int[]) ORDER BY article_id,chunk_index`, [SALON, ids]);
    const plan = originals.map(a => {
      if (!a.is_published || a.internal_only) throw new Error(`Article unavailable: #${a.id}`);
      const body = appendSection(a.body, sectionFor(groups.get(a.id)));
      const chunks = rag.chunkArticle({ title: a.title, body });
      const old = oldChunks.filter(c => c.article_id === a.id);
      if (old.length > chunks.length) throw new Error(`Unexpected excess chunks: #${a.id}`);
      const updates = chunks.filter(c => {
        const previous = old.find(o => o.chunk_index === c.chunk_index);
        return !previous || previous.content !== c.content || previous.content_hash !== rag.hashChunk(c.content) || !previous.embedding?.length;
      });
      return { original: a, body, chunks, updates };
    });
    const report = { database: dbName, salon_id: SALON, takes: 48, articles: 29,
      article_updates: plan.filter(p => p.body !== p.original.body).length,
      chunk_updates: plan.reduce((n,p) => n + p.updates.length, 0) };
    console.log(JSON.stringify(report));
    if (!commit) return;

    if (report.chunk_updates) {
      const sentinel = oldChunks.find(c => c.embedding?.length && c.embed_norm > 0);
      if (!sentinel) throw new Error('No reference embedding');
      const reference = await assistant.embedText(sentinel.content);
      if (reference.length !== sentinel.embedding.length || rag.cosineSim(reference, sentinel.embedding,
        rag.vectorNorm(reference), sentinel.embed_norm) < 0.99) throw new Error('Embedding model differs from live index');
      for (const p of plan) {
        for (const ch of p.updates) {
          ch.embedding = await assistant.embedText(ch.content);
          if (ch.embedding.length !== reference.length || !ch.embedding.every(Number.isFinite) || !rag.vectorNorm(ch.embedding)) {
            throw new Error('Invalid embedding');
          }
        }
        if (p.updates.length) console.log(`prepared #${p.original.id}: ${p.updates.length} chunks`);
      }
    }
    if (report.article_updates || report.chunk_updates) {
      const backupDir = path.join('/root/.local/state/loyalpro', 'kb-sales-backups');
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const backupPath = path.join(backupDir, `${dbName}-${Date.now()}.json`);
      fs.writeFileSync(backupPath, JSON.stringify({ salon_id: SALON, articles: originals, chunks: oldChunks }), { mode: 0o600, flag: 'wx' });
      report.backup_path = backupPath;
      await withTransaction(async client => {
        await client.query("SET LOCAL lock_timeout='5s'");
        const locked = await client.query(`SELECT id,salon_id,title,body,is_published,internal_only
          FROM kb_articles WHERE salon_id=$1 AND id=ANY($2::int[]) ORDER BY id FOR UPDATE`, [SALON, ids]);
        for (const p of plan) assertUnchanged(locked.rows.find(a => a.id === p.original.id), p.original);
        for (const p of plan) {
          if (p.body !== p.original.body) await client.query(`UPDATE kb_articles SET body=$1,updated_at=now()
            WHERE salon_id=$2 AND id=$3`, [p.body, SALON, p.original.id]);
          for (const ch of p.updates) {
            const result = await client.query(`INSERT INTO kb_chunks
              (salon_id,article_id,chunk_index,content,content_hash,embedding,embed_norm,updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,now())
              ON CONFLICT (article_id,chunk_index) DO UPDATE SET
                content=EXCLUDED.content,content_hash=EXCLUDED.content_hash,
                embedding=EXCLUDED.embedding,embed_norm=EXCLUDED.embed_norm,updated_at=now()
              WHERE kb_chunks.salon_id=EXCLUDED.salon_id`,
            [SALON,p.original.id,ch.chunk_index,ch.content,rag.hashChunk(ch.content),ch.embedding,rag.vectorNorm(ch.embedding)]);
            if (result.rowCount !== 1) throw new Error('Tenant mismatch in index');
          }
        }
      });
      console.log('Committed articles and index atomically');
    }
    for (const p of plan) {
      const article = await db.one('SELECT title,body FROM kb_articles WHERE salon_id=$1 AND id=$2', [SALON,p.original.id]);
      if (article.body !== p.body) throw new Error(`Body verification failed #${p.original.id}`);
      const chunks = await db.any(`SELECT chunk_index,content,content_hash,embedding IS NOT NULL AS embedded
        FROM kb_chunks WHERE salon_id=$1 AND article_id=$2 ORDER BY chunk_index`, [SALON,p.original.id]);
      if (chunks.length !== p.chunks.length || chunks.some((c,i) => c.chunk_index !== i ||
          c.content !== p.chunks[i].content || !c.embedded || c.content_hash !== rag.hashChunk(c.content))) {
        throw new Error(`Index verification failed #${p.original.id}`);
      }
    }
    report.verified = true;
    report.completed_at = new Date().toISOString();
    report.content_sha256 = crypto.createHash('sha256').update(JSON.stringify(data.takes)).digest('hex');
    const reportPath = path.resolve(__dirname, '../../docs/content/mila-service-sales-import-2026-10-11.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(e => {
  // Do not print provider payloads, credentials, SQL parameters or database URLs.
  console.error('Import failed:', /^(Unexpected|Expected|Article |Existing |Embedding |Invalid |No reference|Body verification|Index verification|Tenant mismatch|Explicit|Production)/.test(e.message) ? e.message : (e.code || e.name));
  process.exitCode = 1;
});
module.exports = { sectionFor, appendSection, assertUnchanged, HEADING };
