#!/usr/bin/env node
// Живой многоходовый диалог с Милой + ПОЛНЫЙ протокол для визуальной оценки
// качества модели: что ушло в LLM, какие инструменты вызваны с какими аргументами,
// что модель ответила, сколько стоил каждый ход.
//
// Синтетический номер, инструменты ЗАПИСИ подменены заглушками (никаких реальных
// записей в YClients), чистка за собой. Чтение слотов/цен/истории — настоящее.
//
// ВНИМАНИЕ: ходит в платный LLM.
// Usage: node backend/scripts/agent-dialog-transcript.js
const { db, pool } = require('../db');
const config = require('../config');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const { createLogger } = require('../logger');

const SALON = 1;
const CHANNEL = 'whatsapp';
const PHONE = '79000000801';

// Реалистичный сценарий записи: бытовое название → уточнение → выбор слота →
// согласие. Проверяет ровно то, на чём Мила ломалась в инцидентах.
const TURNS = [
  'Здравствуйте! Хочу записаться на биоревитализацию, подскажите сколько стоит?',
  'а можно на этой неделе куда-нибудь? мне бы после обеда',
  'давайте, записывайте',
];

// Перехват лога провайдера: цена/токены каждого вызова LLM.
const costs = [];
(() => {
  const orig = createLogger('AgentPolza').info;
  const logger = require('../logger');
  const realCreate = logger.createLogger;
  logger.createLogger = (tag) => {
    const l = realCreate(tag);
    if (tag !== 'AgentPolza') return l;
    return { ...l, info: (msg) => { costs.push(msg); return l.info(msg); } };
  };
  void orig;
})();

function wrapRegistry(log) {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      const safe = { ...input };
      for (const k of ['client_phone', 'client_name', 'comment']) delete safe[k];
      if (/create_booking|book_chain|modify_booking_services|reschedule_booking|cancel_booking/.test(name)) {
        log.push({ tool: name, input: safe, result: '[ЗАГЛУШКА] запись не выполняется' });
        return { created: true, record_id: 999999, stub: true };
      }
      const res = await fn(salonId, input, ctx);
      const brief = JSON.stringify(res);
      log.push({ tool: name, input: safe, result: brief.length > 700 ? brief.slice(0, 700) + '…(обрезано)' : brief });
      return res;
    };
  }
  return { schemas: base.schemas, handlers };
}

async function cleanup() {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
}

const insert = (direction, text, at) => db.query(
  `INSERT INTO chatpush_messages
     (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts)
   VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8)`,
  [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
   `tr:${PHONE}:${at}:${direction}:${Math.random().toString(36).slice(2, 8)}`, text, PHONE, at]);

async function main() {
  console.log(`# Протокол диалога — модель ${config.POLZA_CHAT_MODEL}\n`);
  await cleanup();
  let ts = Math.floor(Date.now() / 1000) - 600;

  for (let i = 0; i < TURNS.length; i++) {
    const text = TURNS[i];
    ts += 60;
    await insert('incoming', text, ts);

    console.log(`\n## Ход ${i + 1}\n`);
    console.log(`**Пациент:** ${text}\n`);

    const before = costs.length;
    const log = [];
    const res = await orchestrator.runDialog(SALON, PHONE, {
      ctx: { phone: PHONE, channel: CHANNEL },
      deps: { registry: wrapRegistry(log) },
    });

    if (log.length) {
      console.log('**Инструменты, которые вызвала модель:**\n');
      for (const c of log) {
        console.log(`- \`${c.tool}(${JSON.stringify(c.input)})\``);
        console.log(`  → ${c.result}`);
      }
      console.log('');
    } else {
      console.log('**Инструменты:** не вызывались (ответ из каталога в промпте)\n');
    }

    const reply = (res.replies || []).join('\n');
    console.log(`**Мила:** ${reply || '(нет ответа)'}\n`);
    for (const m of costs.slice(before)) console.log(`    · ${m}`);

    // Ответ Милы — в историю, иначе следующий ход не увидит контекст.
    ts += 5;
    if (reply) await insert('outgoing', reply, ts);
  }

  console.log('\n## Стоимость всех вызовов LLM за диалог\n');
  let total = 0;
  for (const m of costs) {
    const r = /([0-9.]+) ₽/.exec(m);
    if (r) total += parseFloat(r[1]);
    console.log(`- ${m}`);
  }
  console.log(`\n**Итого за диалог из ${TURNS.length} ходов: ${total.toFixed(2)} ₽ (${(total / TURNS.length).toFixed(2)} ₽ за ход)**`);
  await cleanup();
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('FAILED:', e); try { await cleanup(); await pool.end(); } catch (_) {} process.exit(1); });
