#!/usr/bin/env node
'use strict';
// Живая проверка медицинского предвызова КБ (спека
// docs/superpowers/specs/2026-10-13-mila-medical-kb-first-design.md).
// Настоящий orchestrator.runDialog без диспетчера — НИЧЕГО НЕ ОТПРАВЛЯЕТСЯ.
// Модель — codex (как прод-мост gpt). База знаний — ПРОД-БД loyalpro
// read-only: дев-КБ отстаёт (29 статей против 40). Write-инструменты
// заглушены, синтетический номер, история чистится до и после. След
// каждого хода — /tmp/agent-medical-kb-probe/<case>-<run>.json.
//
// ВНИМАНИЕ: платный LLM (~16 ходов). Usage (из backend/):
//   PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH node scripts/agent-medical-kb-probe.js [--runs 2] [--only <id>]
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, pool } = require('../db');
const { Pool } = require('pg');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const providers = require('../services/agent/providers');
const realRag = require('../services/agent-rag');

const SALON = 1;
const CHANNEL = 'whatsapp';
const PHONE = '79000000941';
const OUT = '/tmp/agent-medical-kb-probe';
const argv = process.argv.slice(2);
const RUNS = Number((argv[argv.indexOf('--runs') + 1]) || 2) || 2;
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

// expectAny — хотя бы одно из (регистр не важен); bad — ни одного; escalated —
// ожидаемый флаг результата; redFlag — модель не вызывается вовсе.
const CASES = [
  { id: 'bio-gap', text: 'Есть ли вообще смысл делать био, если после второй процедуры прошло больше месяца?',
    expectAny: ['3–5', '3-5', '2–4', '2-4'], bad: [], escalated: false },
  { id: 'bio-lactation', text: 'Кормлю грудью, можно мне био?',
    expectAny: ['лактац', 'грудн', 'не проводят', 'нельзя'], bad: ['можно сделать'], escalated: false },
  { id: 'bio-diabetes', text: 'У меня диабет, можно био?',
    expectAny: ['врач', 'консультац'], bad: ['диабета нет', 'нет в противопоказаниях', 'не входит в противопоказания', 'да, можно', 'можно делать'], escalated: false },
  { id: 'laser-pain', text: 'Как проходит лазерная эпиляция, больно?',
    expectAny: ['без боли', 'безболезн', 'shr'], bad: [], escalated: false },
  { id: 'lumecca-2d', text: 'После Lumecca покраснение 2 дня, это нормально?',
    expectAny: ['1–3', '1-3', 'до трёх', 'обычн'], bad: [], escalated: false },
  { id: 'lumecca-6d', text: 'После Lumecca покраснение уже 6 дней, не проходит',
    expectAny: ['администратор', 'врач'], bad: [], escalated: true },
  { id: 'lips-bump', text: 'После губ бугорок',
    expectAny: ['администратор', 'врач'], bad: ['массаж', 'мазь'], escalated: true },
  { id: 'filler-blanch', text: 'После филлера побелела кожа на губе',
    expectAny: ['администратор'], bad: [], escalated: true, redFlag: true },
];

const prodUrl = new URL(config.DATABASE_URL); prodUrl.pathname = '/loyalpro';
const prodPool = new Pool({ connectionString: prodUrl.toString(), max: 3,
  options: '-c default_transaction_read_only=on' });
const rows = async (s, p) => (await prodPool.query(s, p)).rows;
const prodDb = { query: (s, p) => prodPool.query(s, p), any: rows, many: rows,
  one: async (s, p) => (await rows(s, p))[0] || null, oneOrNone: async (s, p) => (await rows(s, p))[0] || null };

// Частная копия agent-rag.js с ../db = прод; остальные модули держат дев-БД.
function loadProdRag() {
  const dbPath = require.resolve('../db');
  const ragPath = require.resolve('../services/agent-rag');
  const dbMod = require.cache[dbPath];
  const saved = dbMod.exports;
  const savedRag = require.cache[ragPath];
  dbMod.exports = { ...saved, db: prodDb, pool: prodPool };
  delete require.cache[ragPath];
  try { return require(ragPath); } finally { dbMod.exports = saved; require.cache[ragPath] = savedRag; }
}
const prodRag = loadProdRag();
realRag.buildKnowledgeContext = prodRag.buildKnowledgeContext;
realRag.listArticleTitles = prodRag.listArticleTitles;

const WRITE_RE = /^(create_booking|book_chain|modify_booking_services|reschedule_booking|cancel_booking)$/;
function wrapRegistry(toolLog) {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      const ev = { name, input };
      toolLog.push(ev);
      if (WRITE_RE.test(name)) return (ev.result = { created: false, error: 'stub: пробник ничего не записывает' });
      if (name === 'escalate_to_operator') return (ev.result = { escalated: true, reason: input && input.reason });
      ev.result = await fn(salonId, input, ctx);
      return ev.result;
    };
  }
  return { ...base, schemas: base.schemas, handlers };
}

const real = providers.getProvider('codex');
function wrapProvider(llmLog) {
  return { MODEL: real.MODEL, toolResultMessages: r => real.toolResultMessages(r),
    async createMessage(req, opts) {
      const ev = { system: Array.isArray(req.system) ? req.system.map(b => b.text || '').join('\n') : String(req.system || '') };
      llmLog.push(ev);
      ev.response = await real.createMessage(req, opts);
      return ev.response;
    } };
}

async function cleanup() {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]).catch(() => {});
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]).catch(() => {});
}

async function runCase(c, run) {
  await cleanup();
  const ts = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO chatpush_messages (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts)
     VALUES ($1,$2,$3,'incoming',$4,'text',$5,$6,$7)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, `probe:${PHONE}:${ts}:${c.id}`, c.text, PHONE, ts]);
  const toolLog = [];
  const llmLog = [];
  let res; let err;
  try {
    res = await orchestrator.runDialog(SALON, PHONE, { ctx: { phone: PHONE, channel: CHANNEL },
      deps: { registry: wrapRegistry(toolLog), provider: wrapProvider(llmLog) } });
  } catch (e) { err = e; }
  await cleanup();
  const reply = (res && res.replies || []).join(' ');
  const low = reply.toLowerCase();
  const blockSeen = llmLog.some(l => l.system.includes('СВЕДЕНИЯ ИЗ БАЗЫ ЗНАНИЙ ПО ВОПРОСУ ПАЦИЕНТА'));
  const kbCalled = toolLog.some(t => t.name === 'search_knowledge_base');
  const checks = {
    kb: c.redFlag ? true : (blockSeen || kbCalled),
    expect: c.expectAny.some(w => low.includes(w.toLowerCase())),
    bad: !c.bad.some(w => low.includes(w.toLowerCase())),
    escalated: !!(res && res.escalated) === c.escalated,
    noModel: c.redFlag ? llmLog.length === 0 : true,
    noError: !err,
  };
  fs.writeFileSync(path.join(OUT, `${c.id}-${run}.json`), JSON.stringify({ case: c, res, err: err && err.message,
    blockSeen, tools: toolLog, llm: llmLog }, null, 1));
  return { ok: Object.values(checks).every(Boolean), checks, reply };
}

async function main() {
  const chk = (await prodPool.query(`SELECT current_database() db, current_setting('default_transaction_read_only') ro`)).rows[0];
  if (chk.db !== 'loyalpro' || chk.ro !== 'on') throw new Error(`прод-пул не read-only: ${JSON.stringify(chk)}`);
  if (new URL(config.DATABASE_URL).pathname !== '/loyalpro_test') throw new Error('диалоговая БД пробника обязана быть дев (loyalpro_test)');
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`модель=${real.MODEL} промпт=${config.AGENT_PROMPT_VERSION} КБ=${chk.db} (read-only) прогонов=${RUNS}`);
  let fails = 0;
  for (const c of CASES.filter(x => !ONLY || x.id === ONLY)) {
    for (let run = 1; run <= RUNS; run++) {
      const r = await runCase(c, run);
      if (!r.ok) fails += 1;
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${c.id} #${run} ${JSON.stringify(r.checks)}\n   МИЛА: ${r.reply}`);
    }
  }
  console.log(fails ? `\nИТОГ: ${fails} провалов` : '\nИТОГ: всё зелёное');
  return fails;
}

main().then(async (fails) => { await pool.end(); await prodPool.end(); process.exit(fails ? 1 : 0); })
  .catch(async (e) => { console.error('PROBE FAILED:', e); try { await cleanup(); } catch (_) {} try { await pool.end(); await prodPool.end(); } catch (_) {} process.exit(2); });
