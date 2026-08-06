#!/usr/bin/env node
// Живая проверка приветствия: здоровается ли Мила в ПЕРВОМ сообщении переписки
// и не здоровается ли повторно посреди разговора.
//
// Инцидент 2026-08-06 (79165370505): первое в истории обращение пациентки
// («Доброе утро! Можете записать меня на эпиляцию "глубокое бикини+подмышки"
// 12.08 на 16.00?») — Мила ответила «Да, на 12 августа в 16:00 есть свободное
// время…», без приветствия и без представления. Приветствие держалось на одном
// промпт-правиле, и модель прочитала «приветствие уже прозвучало» как
// выполненное — здоровался-то сам пациент.
//
// Проверяет ровно то, что юнит-тестами не проверить: СОБЛЮДАЕТ ли модель
// правило. Признак первого обращения детерминированный (блок «ПЕРВОЕ
// ОБРАЩЕНИЕ» в промпте), его наличие тоже сверяем — иначе зелёный прогон
// может оказаться совпадением.
//
// Работает на СИНТЕТИЧЕСКИХ номерах, реальные диалоги не трогает и чистит за
// собой (включая посеянную карточку клиента). Инструменты записи застаблены.
//
// ВНИМАНИЕ: ходит в платный LLM (~4 ₽ за ход, 4 хода).
// Usage: node backend/scripts/agent-greeting-probe.js
const { db, pool } = require('../db');
const config = require('../config');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const providers = require('../services/agent/providers');

const SALON = 1;
const CHANNEL = 'whatsapp';

const GREETING_RE = /(здравствуйте|добрый\s+(день|вечер|утро)|доброе\s+утро|приветству)/i;

const CASES = [
  {
    // Дословное повторение инцидента, включая ветку ИЗВЕСТНОГО пациента
    // (карточка есть — она была самой слабой: там стоял только «Образец
    // ПЕРВОГО сообщения», без единого императива).
    phone: '79000000911',
    label: 'первое обращение, карточка есть, пациент поздоровался сам',
    client: 'Юлия Тестова',
    text: 'Доброе утро! Можете записать меня на эпиляцию "глубокое бикини+подмышки" 12.08 на 16.00?',
    wantGreeting: true,
    wantFirstContactBlock: true,
  },
  {
    // Пациента в базе нет и сам он не здоровается — вторая ветка идентификации.
    phone: '79000000912',
    label: 'первое обращение, карточки нет, пациент не здоровается',
    text: 'Сколько стоит чистка лица?',
    wantGreeting: true,
    wantFirstContactBlock: true,
  },
  {
    // Контроль: посреди живого разговора приветствие — регресс в другую сторону.
    phone: '79000000913',
    label: 'середина разговора — приветствия быть НЕ должно',
    seed: [
      ['incoming', 'Здравствуйте! Хочу записаться на чистку'],
      ['outgoing', 'Здравствуйте! Я Мила, виртуальный администратор PERI CLINIC. Подскажите, как могу к вам обращаться?'],
    ],
    text: 'Меня зовут Анна',
    wantGreeting: false,
    wantFirstContactBlock: false,
  },
  {
    // Автоуведомление YClients — не разговор: пациент, впервые написавший в
    // чат после отбивки о записи, ни одного НАШЕГО ответа не видел.
    phone: '79000000914',
    label: 'до этого было только автоуведомление — приветствие нужно',
    seed: [['outgoing', 'Вы записаны на прием 12.08.2026 16:00 в «PERI CLINIC».', 'system']],
    text: 'А можно перенести на 17:00?',
    wantGreeting: true,
    wantFirstContactBlock: true,
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
        return { created: false, error: 'stub: пробник приветствия ничего не записывает' };
      }
      return fn(salonId, input, ctx);
    };
  }
  return { schemas: base.schemas, handlers };
}

async function cleanup(c) {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, c.phone]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, c.phone]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, c.phone]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, c.phone]);
  if (c.client) await db.query(`DELETE FROM clients WHERE salon_id=$1 AND phone=$2`, [SALON, c.phone]);
}

async function runCase(c) {
  console.log(`\n=== ${c.label} ===\n  «${c.text}»`);
  await cleanup(c);
  if (c.client) {
    await db.query(`INSERT INTO clients (salon_id, name, phone) VALUES ($1,$2,$3)`, [SALON, c.client, c.phone]);
  }
  const ts = Math.floor(Date.now() / 1000);
  const insert = (direction, text, at, authoredBy = null) => db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts, authored_by)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `greetprobe:${c.phone}:${at}:${direction}`, text, c.phone, at, authoredBy]);
  const seed = c.seed || [];
  for (let i = 0; i < seed.length; i++) {
    await insert(seed[i][0], seed[i][1], ts - (seed.length - i) * 60, seed[i][2] || (seed[i][0] === 'outgoing' ? 'agent' : null));
  }
  await insert('incoming', c.text, ts);

  // Перехватываем системный промпт хода через провайдера: без этого
  // «поздоровалась» может оказаться везением модели, а не следствием
  // детерминированного блока. Провайдер настоящий — подменена только обёртка.
  const realProvider = providers.getProvider();
  let sentSystem = '';
  const provider = Object.assign(Object.create(realProvider), {
    createMessage: async (req) => { if (!sentSystem) sentSystem = String(req.system || ''); return realProvider.createMessage(req); },
  });

  const calls = [];
  const res = await orchestrator.runDialog(SALON, c.phone, {
    ctx: { phone: c.phone, channel: CHANNEL },
    deps: { registry: wrapRegistry(calls), provider },
  });
  const reply = (res.replies || []).join('\n');
  console.log(`  инструменты: ${calls.length ? calls.join(' → ') : '(нет)'}`);
  console.log(`  → Мила: ${reply || '(нет ответа)'}`);
  await cleanup(c);

  const greeted = GREETING_RE.test(reply);
  const hasBlock = sentSystem.includes('ПЕРВОЕ ОБРАЩЕНИЕ');
  const okGreeting = greeted === c.wantGreeting;
  const okBlock = hasBlock === c.wantFirstContactBlock;
  console.log(`  приветствие: ${greeted ? 'есть' : 'нет'} (ждали ${c.wantGreeting ? 'есть' : 'нет'}) ${okGreeting ? '✅' : '❌'}`);
  console.log(`  блок ПЕРВОЕ ОБРАЩЕНИЕ в промпте: ${hasBlock ? 'есть' : 'нет'} ${okBlock ? '✅' : '❌'}`);
  return okGreeting && okBlock;
}

async function main() {
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}`);
  // Фильтр по подстроке метки + повторы: правило модель соблюдает не
  // детерминированно, одиночный зелёный прогон ничего не доказывает.
  //   node scripts/agent-greeting-probe.js "карточка есть" 3
  const only = process.argv[2];
  const repeat = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 1;
  const cases = only ? CASES.filter(c => c.label.includes(only)) : CASES;
  const results = [];
  for (let r = 0; r < repeat; r++) for (const c of cases) results.push(await runCase(c));
  console.log(`\n=== ИТОГ: ${results.filter(Boolean).length}/${results.length} ===`);
  return results.every(Boolean);
}

main().then(async (ok) => { await pool.end(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error('PROBE FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
