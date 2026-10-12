#!/usr/bin/env node
// Живая проверка: отвечает ли Мила на вопросы «как проходит / сколько сеансов /
// чем отличается» из новых разделов базы знаний (импорт
// scripts/kb-import-telegram-descriptions.js, спека
// docs/superpowers/specs/2026-09-28-kb-telegram-service-descriptions-design.md).
//
// Тот же приём, что agent-price-probe.js: СИНТЕТИЧЕСКИЕ номера, история чистится,
// write-инструменты заглушены. Проверяется, что (1) вызван search_knowledge_base,
// (2) в ответе есть ожидаемые слова из статьи, (3) нет запрещённых формулировок.
//
// ВНИМАНИЕ: ходит в платный LLM (~2–4 ₽ за ход). Usage: node scripts/agent-kb-descriptions-probe.js
const { db, pool } = require('../db');
const config = require('../config');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');

const SALON = 1;
const CHANNEL = 'whatsapp';

const CASES = [
  {
    phone: '79000000911',
    label: 'лазер: отращивать ли волосы и сколько сеансов',
    text: 'Здравствуйте! Меня зовут Анна. Хочу на лазерную эпиляцию ног. Нужно ли отращивать волосы перед процедурой и сколько сеансов обычно нужно?',
    expectAny: ['сбрит', 'брею', 'брить', 'бре'],
    expectAll: ['курс'],
    bad: ['навсегда', 'без боли'],
  },
  {
    phone: '79000000912',
    label: 'Morpheus8 vs Volnewmer',
    text: 'Добрый день, я Марина. Подскажите, чем Morpheus8 отличается от Volnewmer? Что из них для овала лица?',
    expectAny: ['микроигл'],
    expectAll: ['Volnewmer'],
    bad: [],
  },
  {
    phone: '79000000913',
    label: 'чистка лица: как проходит',
    text: 'Здравствуйте, меня зовут Ольга. Расскажите, как проходит комбинированная чистка лица и всем ли делают механическую чистку?',
    expectAny: ['ультразвук', 'механическ'],
    expectAll: [],
    bad: [],
  },
];

function wrapRegistry(calls) {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      calls.push(name);
      console.log(`    ▸ tool ${name} ${JSON.stringify(input).slice(0, 160)}`);
      if (/create_booking|book_chain|modify_booking_services|reschedule_booking|cancel_booking/.test(name)) {
        console.log('      · [stub] запись в YClients не выполняется');
        return { created: false, error: 'stub: пробник ничего не записывает' };
      }
      return fn(salonId, input, ctx);
    };
  }
  return { schemas: base.schemas, handlers };
}

async function cleanup(phone) {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]).catch(() => {});
}

async function runCase(c) {
  console.log(`\n=== ${c.label} ===\n  «${c.text}»`);
  await cleanup(c.phone);
  const ts = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts)
     VALUES ($1,$2,$3,'incoming',$4,'text',$5,$6,$7)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, `probe:${c.phone}:${ts}:incoming`, c.text, c.phone, ts]);

  const calls = [];
  const res = await orchestrator.runDialog(SALON, c.phone, {
    ctx: { phone: c.phone, channel: CHANNEL },
    deps: { registry: wrapRegistry(calls) },
  });
  const reply = (res.replies || []).join('\n');
  console.log(`  инструменты: ${calls.length ? calls.join(' → ') : '(нет)'}`);
  console.log(`  → Мила: ${reply || '(нет ответа)'}`);
  await cleanup(c.phone);

  const low = reply.toLowerCase();
  const kb = calls.includes('search_knowledge_base');
  const any = !c.expectAny.length || c.expectAny.some(w => low.includes(w.toLowerCase()));
  const all = c.expectAll.every(w => low.includes(w.toLowerCase()));
  const wrong = c.bad.filter(b => low.includes(b.toLowerCase()));
  console.log(`  search_knowledge_base: ${kb ? 'вызван ✅' : 'НЕ вызван ❌'}; ожидаемые слова: ${any && all ? 'есть ✅' : 'нет ❌'}${wrong.length ? `; запрещённое: ${wrong.join(', ')} ❌` : ''}`);
  return kb && any && all && !wrong.length;
}

async function main() {
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}, БД=${new URL(config.DATABASE_URL).pathname}`);
  const results = [];
  for (const c of CASES) results.push(await runCase(c));
  console.log(`\n=== ИТОГ: ${results.filter(Boolean).length}/${results.length} ===`);
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('PROBE FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
