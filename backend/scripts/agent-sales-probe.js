#!/usr/bin/env node
// Живой пробник консультативной продажи (план 2026-10-07-mila-consultative-sales).
// Реальный LLM и реальная КБ/каталог; write-инструменты застаблены; синтетические
// номера, чистка за собой. ВНИМАНИЕ: платные вызовы (~3–5 ₽ за ход).
// Только дев-БД loyalpro_test: на любой другой скрипт отказывается работать.
// Гейт допуска и диспетчер не участвуют: runDialog зовётся напрямую, отправки
// в Chatpush нет вовсе (реплики только печатаются).
// Usage: node backend/scripts/agent-sales-probe.js [--only=<label-substring>]
// Дев-провайдер codex: в PATH должен быть тот же codex, что у pm2 (node v20:
//   PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH), иначе CODEX_UNAVAILABLE/PROCESS_FAILED.
const config = require('../config');

let dbName = '';
try { dbName = new URL(config.DATABASE_URL).pathname; } catch (_) { /* ниже отказ */ }
if (dbName !== '/loyalpro_test') {
  console.error(`agent-sales-probe: только для дев-БД loyalpro_test (сейчас «${dbName || 'не задано'}») — отказ`);
  process.exit(2);
}

const { db, pool } = require('../db');
const orchestrator = require('../services/agent/orchestrator');
const providers = require('../services/agent/providers');
const registry = require('../services/agent/tools');
const replyGuard = require('../services/agent/reply-guard');
const { TAIL_HEADER } = require('../services/agent/sales-modules');

const SALON = 1;
const CHANNEL = 'whatsapp';
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);

const CASES = [
  {
    phone: '79000000911', label: 'цена → факт + шаг',
    text: 'Здравствуйте! Меня зовут Анна. Сколько стоит чистка лица?',
    check: (reply) => ({
      'есть сумма': /\d[\d\s ]*\s?₽/.test(reply),
      'есть шаг или вопрос': /\?|записа|подобр|консультац/i.test(reply),
      'есть факт об услуге': /входит|длит|занима|проход|ультразвук|уход/i.test(reply),
    }),
  },
  {
    phone: '79000000912', label: 'дорого → без спора, одно уточнение',
    seed: [
      ['incoming', 'Здравствуйте! Меня зовут Анна. Сколько стоит чистка лица?'],
      ['outgoing', 'Анна, здравствуйте! Комбинированная чистка лица — 6 500 ₽. Подобрать время?'],
    ],
    text: 'Дорого как-то',
    check: (reply) => ({
      'не спорит': !/на самом деле|это недорого|оправдан/i.test(reply),
      'не больше одного вопроса': (reply.match(/\?/g) || []).length <= 1,
      'не повторяет цену третий раз': (reply.match(/₽/g) || []).length <= 1,
    }),
  },
  {
    phone: '79000000913', label: 'напишу сама → принять, без вопроса',
    seed: [
      ['incoming', 'Сколько стоит биоревитализация?'],
      ['outgoing', 'Анна, от 15 500 до 26 000 ₽ в зависимости от препарата, его подбирает врач. Хотите консультацию?'],
    ],
    text: 'Спасибо, подумаю и напишу сама',
    check: (reply) => ({
      'без вопроса': !/\?/.test(reply),
      'коротко': reply.length <= 220,
    }),
  },
  {
    phone: '79000000914', label: 'не знаю, что выбрать → один вопрос о результате',
    text: 'Здравствуйте, я Анна. Хочу что-то для лица, выглядеть свежее, но не знаю, что выбрать',
    check: (reply) => ({
      'ровно один вопрос': (reply.match(/\?/g) || []).length === 1,
      'не называет препарат': !/revi|stylage|juvederm|ботокс|диспорт/i.test(reply),
      'не называет цену': !/₽/.test(reply),
    }),
  },
];

// Блоки хвоста, которые пробник ищет в системном промпте ПЕРВОГО прохода.
const PROMPT_BLOCKS = {
  'СПРАВКА ОБ УСЛУГЕ': 'СПРАВКА ОБ УСЛУГЕ (найдена автоматически',
  'СЦЕНАРИЙ ЭТОГО СООБЩЕНИЯ': TAIL_HEADER,
  'СТАТЬЯ ОБ АКЦИИ': 'СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА (найдена',
};

function wrapRegistry(calls) {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      calls.push(name);
      console.log(`    ▸ tool ${name} ${JSON.stringify(input).slice(0, 160)}`);
      if (/create_booking|book_chain|modify_booking_services|reschedule_booking|cancel_booking|escalate_to_operator|prepare_additional_booking/.test(name)) {
        return { created: false, error: 'stub: пробник ничего не записывает' };
      }
      return fn(salonId, input, ctx);
    };
  }
  return { schemas: base.schemas, handlers };
}

// Боевой провайдер салона; перехватываем только createMessage, чтобы увидеть
// системный промпт каждого прохода (какие хвостовые блоки реально в нём были).
function wrapProvider(systems) {
  const base = providers.getProviderForSalon(SALON);
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'createMessage') {
        return (req, o) => { systems.push(String(req && req.system || '')); return target.createMessage(req, o); };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

async function cleanup(phone) {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
}

async function runCase(c) {
  console.log(`\n=== ${c.label} ===\n  «${c.text}»`);
  await cleanup(c.phone);
  const calls = [];
  const systems = [];
  let reply = '';
  const t0 = Date.now();
  try {
    const ts = Math.floor(Date.now() / 1000);
    const insert = (direction, text, at) => db.query(
      `INSERT INTO chatpush_messages
         (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts, authored_by)
       VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9)`,
      [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
       `probe:${c.phone}:${at}:${direction}`, text, c.phone, at, direction === 'outgoing' ? 'agent' : null]);
    const seed = c.seed || [];
    for (let i = 0; i < seed.length; i++) await insert(seed[i][0], seed[i][1], ts - (seed.length - i) * 60);
    await insert('incoming', c.text, ts);

    const res = await orchestrator.runDialog(SALON, c.phone, {
      ctx: { phone: c.phone, channel: CHANNEL },
      deps: { registry: wrapRegistry(calls), provider: wrapProvider(systems) },
    });
    reply = (res.replies || []).join('\n');
    if (res.escalated || res.falseSuccess || res.silent) {
      console.log(`  флаги хода: ${JSON.stringify({ escalated: !!res.escalated, falseSuccess: !!res.falseSuccess, silent: !!res.silent })}`);
    }
  } finally {
    await cleanup(c.phone);
  }
  console.log(`  инструменты: ${calls.length ? calls.join(' → ') : '(нет)'}`);
  console.log(`  проходов провайдера: ${systems.length}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  const first = systems[0] || '';
  const blocks = Object.entries(PROMPT_BLOCKS).filter(([, marker]) => first.includes(marker)).map(([k]) => k);
  console.log(`  блоки в системном промпте: ${blocks.length ? blocks.join(', ') : '(нет)'}`);
  console.log(`  → Мила: ${reply || '(нет ответа)'}`);
  const tele = [...replyGuard.checkPriceWithoutNextStep(reply),
    ...replyGuard.checkQuestionInsteadOfOffer(reply, { slotToolCalled: calls.some(n => /slots|dates/.test(n)), patientLastText: c.text })];
  console.log(`  телеметрия (по финальной реплике): ${tele.length ? JSON.stringify(tele) : '(нет)'}`);

  const checks = c.check(reply);
  let ok = !!reply;
  if (!reply) console.log('  ❌ ответ есть');
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`  ${pass ? '✅' : '❌'} ${name}`);
    if (!pass) ok = false;
  }
  return ok;
}

async function main() {
  console.log(`БД=${dbName}, провайдер=${config.AGENT_PROVIDER}, промпт=${config.AGENT_PROMPT_VERSION}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}, справка КБ=${config.AGENT_SERVICE_FACT_PREFETCH}`);
  const results = [];
  for (const c of CASES) if (!only || c.label.includes(only)) results.push(await runCase(c));
  console.log(`\n=== ИТОГ: ${results.filter(Boolean).length}/${results.length} ===`);
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('PROBE FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
