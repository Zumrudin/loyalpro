#!/usr/bin/env node
// Живая проверка молчания на завершающей вежливости.
//
// Инцидент 2026-08-06 (79165370505): после записи Мила попрощалась, дальше пошёл
// круг «Спасибо!» → «Пожалуйста! Рада была помочь. 🤍» → «Благодарю! И Вам» →
// «Всегда пожалуйста! ✨». Ветки «промолчать» у неё не было вообще: ход без
// реплик диспетчер трактовал как отказ (эскалация + страховочная фраза).
//
// Гоняет ПОЛНУЮ цепочку dispatcher.process → orchestrator.runDialog на реальном
// транскрипте из БД — юнит-тесты проверяют модуль, а здесь важно, что ветка
// res.silent стоит в диспетчере ВЫШЕ «ход без реплик» и не превращается в
// «передаю администратору». Отправка и эскалация застаблены: реального
// сообщения никто не получает, диалог на оператора не уходит.
//
// Синтетические номера, чистка за собой. Кейс «круг благодарностей» бесплатный
// (молчание решается ДО провайдера), контрольные кейсы — платные (~1 ход LLM
// каждый): они доказывают, что гейт не срабатывает там, где отвечать НУЖНО.
//
// Usage: node backend/scripts/agent-closing-probe.js [подстрока-метки]
const { db, pool } = require('../db');
const config = require('../config');
const dispatcher = require('../services/agent/dispatcher');
const orchestratorReal = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const providers = require('../services/agent/providers');

const SALON = 1;
const CHANNEL = 'whatsapp';

// Хвост реальной переписки 06.08: подтверждение записи и прощание ушли ОДНОЙ
// серией (loyalpro склеит их в один assistant-блок), затем круг благодарностей.
const BOOKED = 'Записала вас! 🌸 Ждём вас 12 августа в 16:00 на комплекс «Тотальное бикини и подмышки» к косметологу-эстетисту Татьяне.';
const BYE = 'Была рада помочь! Хорошего дня! ✨';
const YOURE_WELCOME = 'Пожалуйста! Рада была помочь. 🤍';

const CASES = [
  {
    phone: '79000000921',
    label: 'круг благодарностей — вторая благодарность подряд',
    seed: [
      ['incoming', 'Запишите меня на глубокое бикини и подмышки 12.08 на 16:00'],
      ['outgoing', BOOKED], ['outgoing', BYE],
      ['incoming', 'Спасибо!'],
      ['outgoing', YOURE_WELCOME],
    ],
    text: 'Благодарю!И Вам🌹',
    wantSilent: true,
    wantLlm: false,
  },
  {
    phone: '79000000922',
    label: 'ПЕРВАЯ благодарность после подтверждения записи — ответ нужен',
    seed: [
      ['incoming', 'Запишите меня на глубокое бикини и подмышки 12.08 на 16:00'],
      ['outgoing', BOOKED], ['outgoing', BYE],
    ],
    text: 'Спасибо!',
    wantSilent: false,
    wantLlm: true,
  },
  {
    phone: '79000000923',
    label: 'благодарность с вопросом после прощания — молчать НЕЛЬЗЯ',
    seed: [
      ['incoming', 'Запишите меня на глубокое бикини и подмышки 12.08 на 16:00'],
      ['outgoing', BOOKED], ['outgoing', BYE],
      ['incoming', 'Спасибо!'],
      ['outgoing', YOURE_WELCOME],
    ],
    text: 'Спасибо! А во сколько лучше подойти?',
    wantSilent: false,
    wantLlm: true,
  },
];

// Пишущие инструменты застаблены: пробник ничего не записывает в YClients.
function wrapRegistry(calls) {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      calls.push(name);
      console.log(`    ▸ tool ${name} ${JSON.stringify(input).slice(0, 140)}`);
      if (/create_booking|book_chain|modify_booking_services|reschedule_booking|cancel_booking/.test(name)) {
        console.log('      · [stub] запись в YClients не выполняется');
        return { created: false, error: 'stub: пробник молчания ничего не записывает' };
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
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
}

async function runCase(c) {
  console.log(`\n=== ${c.label} ===\n  «${c.text}»`);
  await cleanup(c.phone);

  const ts = Math.floor(Date.now() / 1000);
  const insert = (direction, text, at) => db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts, authored_by)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `closeprobe:${c.phone}:${at}:${direction}:${Math.random().toString(36).slice(2, 8)}`,
     text, c.phone, at, direction === 'outgoing' ? 'agent' : null]);

  const seed = c.seed || [];
  for (let i = 0; i < seed.length; i++) await insert(seed[i][0], seed[i][1], ts - (seed.length - i) * 60);
  await insert('incoming', c.text, ts);

  // Провайдер настоящий — считаем ВЫЗОВЫ: бесплатность молчания это факт, а не
  // намерение, и проверять её надо счётчиком, а не на слово.
  const realProvider = providers.getProvider();
  let llmCalls = 0;
  const provider = Object.assign(Object.create(realProvider), {
    createMessage: async (req, o) => { llmCalls++; return realProvider.createMessage(req, o); },
  });

  const calls = [];
  const sent = [];
  const escalations = [];
  let res = null;
  await dispatcher.process(SALON, c.phone, { phone: c.phone, channel: CHANNEL, messageId: `probe-${ts}` }, {
    settings: { isAllowed: async () => ({ allow: true, reason: 'probe' }), loadStopTopicsSafe: async () => [] },
    // Полная цепочка диспетчера, но с подменёнными инструментами и провайдером.
    orchestrator: {
      runDialog: async (salonId, key, o) => {
        res = await orchestratorReal.runDialog(salonId, key, { ...o, deps: { registry: wrapRegistry(calls), provider } });
        return res;
      },
    },
    send: async (m, text) => { sent.push(text); },
    escalate: async (salonId, key, reason) => { escalations.push(reason); },
    authorship: { remember: () => {} },
  });

  await cleanup(c.phone);

  const silent = !!(res && res.silent);
  console.log(`  инструменты: ${calls.length ? calls.join(' → ') : '(нет)'}`);
  console.log(`  вызовов LLM: ${llmCalls}`);
  console.log(`  реплика модели: ${(res && res.replies || []).map((t) => `«${t}»`).join(' | ') || '(нет)'}`);
  console.log(`  отправлено (${sent.length}): ${sent.map((t) => `«${t}»`).join(' | ') || '(ничего)'}`);
  console.log(`  эскалаций: ${escalations.length ? escalations.join('; ') : '(нет)'}`);

  const okSilent = silent === c.wantSilent;
  // Молчим — значит НИЧЕГО не ушло и на оператора диалог не свалился.
  const okSent = c.wantSilent ? sent.length === 0 : sent.length > 0;
  // Эскалация — критерий провала для молчаливого кейса: именно её ветка
  // res.silent и предотвращает. На отвечающих кейсах ход идёт мимо новой ветки
  // (silent=false ⇒ код в точности прежний), и сработать там может любая старая
  // защита — например анти-ложь на синтетическом номере, у которого записи в
  // YClients нет, а транскрипт фикстуры про неё говорит.
  const okEsc = c.wantSilent ? escalations.length === 0 : true;
  const okLlm = c.wantLlm ? llmCalls > 0 : llmCalls === 0;
  console.log(`  silent=${silent} (ждали ${c.wantSilent}) ${okSilent ? '✅' : '❌'}`);
  console.log(`  отправка: ${okSent ? '✅' : '❌'}   LLM: ${okLlm ? '✅' : '❌'}`
    + (c.wantSilent ? `   эскалации нет: ${okEsc ? '✅' : '❌'}` : ''));
  return okSilent && okSent && okEsc && okLlm;
}

async function main() {
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}, AGENT_CLOSING_SILENCE=${config.AGENT_CLOSING_SILENCE}`);
  const only = process.argv[2];
  const cases = only ? CASES.filter((c) => c.label.includes(only)) : CASES;
  const results = [];
  for (const c of cases) {
    dispatcher._reset();
    results.push(await runCase(c));
  }
  console.log(`\n=== ИТОГ: ${results.filter(Boolean).length}/${results.length} ===`);
  return results.every(Boolean);
}

main().then(async (ok) => { await pool.end(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error('PROBE FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
