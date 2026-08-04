#!/usr/bin/env node
// Живой двухходовой E2E памяти Милы: переживают ли результаты инструментов границу хода.
// Ход 1 — вопрос про свободное время на услугу (ждём get_available_slots и времена в ответе).
// Ход 2 — «напомните, какие времена вы называли?» (ждём ответ ИЗ ЖУРНАЛА: без
//         повторного вызова слот-инструментов, времена — подмножество показанных в ходе 1).
// Реальный LLM и реальные инструменты; ответы клиенту НЕ отправляются (send застаблен),
// исходящие пишем в БД сами. ВНИМАНИЕ: платный LLM (~10-40 ₽) и чистка истории тестового номера.
// В отличие от sequential-e2e процесс тут не обязан быть одним: память в БД —
// но и ронять/поднимать процесс незачем, journal читается заново каждый ход.
//
// ГОТЧА проверки: транскрипт второго хода СОДЕРЖИТ реплику Милы из первого, поэтому
// одни только совпавшие времена доказательством работы журнала не являются. Реальное
// доказательство — блок «ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ» в системном промпте второго хода:
// скрипт перехватывает промпт у провайдера и печатает его строки.
//
// Перед запуском: агент салона должен быть ВКЛЮЧЁН и тестовый номер должен проходить
// гейт (agent_settings.enabled + режим/списки), иначе диспетчер молча ничего не сделает.
//
// Usage: node backend/scripts/agent-tool-memory-e2e.js
const { db, pool } = require('../db');
const config = require('../config');
const agentSettings = require('../services/agent-settings');
const dispatcher = require('../services/agent/dispatcher');
const orchestrator = require('../services/agent/orchestrator');
const providers = require('../services/agent/providers');
const registry = require('../services/agent/tools');
const toolEvents = require('../services/agent/tool-events');
const toolMemory = require('../services/agent/tool-memory');

const SALON = 1;
const PHONE = '79200255591';
const CHANNEL = 'whatsapp';
const SLOT_TOOLS = ['get_available_slots', 'get_available_dates', 'get_sequential_slots', 'get_parallel_slots'];
const MEMORY_HEADER = 'ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ';

const calls = [];      // [{ turn, name, input, result }]
const prompts = [];    // [{ turn, system }] — системный промпт каждого вызова провайдера
let turn = 0;

function wrapRegistry() {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      console.log(`    ▸ tool ${name} ${JSON.stringify(input).slice(0, 200)}`);
      const result = await fn(salonId, input, ctx);
      calls.push({ turn, name, input, result });
      return result;
    };
  }
  return { schemas: base.schemas, handlers };
}

// Провайдер настоящий; перехватываем только системный промпт — по нему видно,
// доехал ли до модели блок памяти (главная улика при красном вердикте).
function wrapProvider() {
  const base = providers.getProvider();
  return {
    ...base,
    createMessage: async (req, opts) => {
      prompts.push({ turn, system: req.system });
      return base.createMessage(req, opts);
    },
  };
}

async function insertMsg(direction, text) {
  const ts = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8)
     ON CONFLICT (salon_id, external_message_id) DO NOTHING`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `e2e:${direction}:${ts}:${Math.floor(Math.random() * 1e6)}`, text, PHONE, ts]);
}

// То же чтение, что делает оркестратор перед сборкой промпта — печатаем, чтобы
// отличить «журнал пуст» от «журнал есть, но модель его проигнорировала».
async function showJournal(label) {
  const rows = await toolEvents.loadRecent(SALON, PHONE);
  const { lines, dropped } = toolMemory.renderMemory(rows, { nowMs: Date.now() });
  console.log(`  ${label}: строк в журнале БД ${rows.length}, в выжимке ${lines.length}${dropped ? ` (срезано ${dropped})` : ''}`);
  for (const l of lines) console.log(`    - ${l}`);
}

async function runTurn(n, incoming) {
  turn = n;
  console.log(`\n=== ХОД ${n}: «${incoming}» ===`);
  await showJournal('память ДО хода');
  await insertMsg('incoming', incoming);
  const replies = [];
  await dispatcher.process(SALON, PHONE, { phone: PHONE, channel: CHANNEL }, {
    send: async (meta, text) => { replies.push(text); },
    orchestrator: {
      runDialog: (sid, key, o) => orchestrator.runDialog(sid, key, {
        ...o, deps: { ...(o.deps || {}), registry: wrapRegistry(), provider: wrapProvider() },
      }),
    },
  });
  const names = calls.filter(c => c.turn === n).map(c => c.name);
  console.log(`  инструменты хода: ${names.length ? names.join(' → ') : '(нет)'}`);
  for (const t of replies) {
    console.log(`  → Мила: ${t}`);
    await insertMsg('outgoing', t);   // эхо, которое в проде приносит Chatpush
  }
  if (!replies.length) console.log('  → (реплик нет)');

  // Блок памяти в системном промпте этого хода (первый вызов провайдера).
  const p = prompts.find(x => x.turn === n);
  const block = p && p.system.includes(MEMORY_HEADER)
    ? p.system.slice(p.system.indexOf(MEMORY_HEADER)) : null;
  console.log(`  блок «${MEMORY_HEADER}» в промпте хода: ${block ? 'ЕСТЬ' : 'НЕТ'}`);
  if (block) for (const l of block.split('\n').filter(s => s.startsWith('- '))) console.log(`    ${l}`);
  return { names, replies, hasMemoryBlock: !!block };
}

async function main() {
  const gate = await agentSettings.isAllowed(SALON, PHONE);
  if (!gate.allow) {
    console.error(`ГЕЙТ НЕ ПРОПУСКАЕТ тестовый номер (reason=${gate.reason}) — включи агента салона ${SALON}, иначе прогон впустую`);
    return;
  }
  const del = await db.query(
    `DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  console.log(`история очищена (${del.rowCount} сообщений), провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}`);

  await runTurn(1, 'Здравствуйте! Какие свободные окошки завтра на комбинированную чистку лица у Юлии?');
  // markDelivered — fire-and-forget: даём вердикту долететь до БД до второго хода.
  await new Promise(r => setTimeout(r, 1500));
  const t2 = await runTurn(2, 'Напомните, пожалуйста, какие времена вы называли?');

  console.log('\n=== ИТОГ ===');
  const t1Times = new Set(calls.filter(c => c.turn === 1 && c.name === 'get_available_slots')
    .flatMap(c => (c.result && c.result.slots) || []).map(s => s.time).filter(Boolean));
  const t2SlotCalls = calls.filter(c => c.turn === 2 && SLOT_TOOLS.includes(c.name)).length;
  const t2Text = t2.replies.join(' ');
  const recalled = [...t1Times].filter(t => t2Text.includes(t));
  const ev = await db.any(
    `SELECT tool, is_error, delivered, to_char(created_at,'HH24:MI:SS') AS at
       FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2 ORDER BY id`, [SALON, PHONE]);
  console.log('журнал в БД после прогона:');
  for (const r of ev) console.log(`  ${r.at} ${r.tool} is_error=${r.is_error} delivered=${r.delivered}`);
  console.log(`времена хода 1: ${[...t1Times].join(', ') || '(нет)'}`);
  console.log(`блок памяти в промпте хода 2: ${t2.hasMemoryBlock ? 'ЕСТЬ' : 'НЕТ'}`);
  console.log(`слот-инструментов на ходе 2: ${t2SlotCalls}  (ожидание: 0 — ответ из журнала)`);
  console.log(`времена хода 1 в ответе хода 2: ${recalled.join(', ') || '(нет)'}`);
  const ok = t2.hasMemoryBlock && t2SlotCalls === 0 && recalled.length > 0;
  console.log(ok ? 'ВЕРДИКТ: память пережила границу хода ✅'
    : 'ВЕРДИКТ: журнал не сработал (или модель legitimately перепроверила — смотри лог) ❌');
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
