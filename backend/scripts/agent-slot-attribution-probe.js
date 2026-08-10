#!/usr/bin/env node
// Живая проверка трёх фиксов от 2026-08-10 (ветка fix/agent-slot-attribution).
// Проверяет ровно то, чего не проверить юнит-тестами: как ведёт себя МОДЕЛЬ,
// получив новые поля выдачи и новые правила промпта.
//
//  1. Мастер в отпуске + окна у другого специалиста (инцидент 79166524647):
//     Мила написала «у главного врача Пери Исамудиновны … есть окошки в 11:00 и
//     15:30» — времена Астемира Боташева. Ждём: чужое время либо не называется,
//     либо называется ВМЕСТЕ с именем его владельца.
//  2. Представление, когда Мила пишет в диалог впервые (79166524647/79295059889):
//     раньше отвечал только живой администратор. Ждём «Я Мила, виртуальный
//     администратор …». Отдельно печатаем, сказала ли это САМА модель или
//     дописал код (ensureIntroduction) — правило и дописка меряются раздельно.
//  3. Оценка визита (79776646672): пациент прислал «5» на автоопрос, который в
//     переписку не попал. Ждём благодарность, а НЕ «чем могу помочь?».
//  4. Контроль ложных срабатываний: мастер работает, окна есть — ход обязан
//     пройти С ПЕРВОГО РАЗА, без корректирующего довызова. unknown_time и
//     alien_time_attribution стали жёсткими, и цена ошибки в эту сторону —
//     лишний платный вызов на КАЖДОМ нормальном ходу.
//
// НИЧЕГО НЕ ОТПРАВЛЯЕТ ЖИВЫМ КЛИЕНТАМ: runDialog только считает реплику,
// отправкой занимается диспетчер, который здесь не участвует. Инструменты
// записи застаблены, номера синтетические, за собой чистит.
//
// ВНИМАНИЕ: ходит в платный LLM (~5 ₽ за ход).
// Usage: node backend/scripts/agent-slot-attribution-probe.js [фильтр] [повторов]
const { db, pool } = require('../db');
const config = require('../config');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const providers = require('../services/agent/providers');
const guard = require('../services/agent/reply-guard');
const greeting = require('../services/agent/greeting');

const SALON = 1;
const CHANNEL = 'whatsapp';

// Реальные id и имена с прода — чтобы промпт-каталог и ответы инструмента
// говорили об одних и тех же людях.
const PERI = { yc_id: 1910274, name: 'Гаджиева Пери' };
const ASTEMIR = { yc_id: 5708379, name: 'Астемир Боташев' };

const slot = (date, time) => ({ time, datetime: `${date}T${time}:00+03:00`, seance_length: 1800 });

// Дословная форма инцидентной выдачи: у запрошенного мастера пусто и он не в
// графике, окна есть у другого исполнителя той же услуги.
function vacancyPayload(date) {
  return {
    slots: [],
    source: 'schedule',
    offer_slots: [],
    staff_name: PERI.name,
    staff_not_working: true,
    staff_next_working_date: '2026-09-01',
    alternative_staff: [{
      staff_yc_id: ASTEMIR.yc_id,
      name: ASTEMIR.name,
      slots: ['10:00', '11:00', '12:00', '14:30', '15:30', '17:30', '19:00'].map(t => slot(date, t)),
      offer_slots: [slot(date, '17:30'), slot(date, '19:00')],
    }],
    hint: 'Мастер Гаджиева Пери в этот день НЕ РАБОТАЕТ — его нет в графике (отпуск или выходной). '
      + 'У него не «всё занято»: свободного времени в этот день не существует и не появится. '
      + 'Его ближайший приёмный день — 2026-09-01: предложи пациенту именно его (слоты на эту дату запроси отдельным вызовом). '
      + 'КАТЕГОРИЧЕСКИ НЕЛЬЗЯ называть пациенту любое время как время ЭТОГО мастера: ни из этой выдачи, ни из предыдущих ходов, ни из окон других специалистов. '
      + 'У выбранного мастера на эту дату свободного времени нет, но ЭТУ ЖЕ услугу в этот день выполняют другие мастера — их реальные свободные окна в alternative_staff. '
      + 'Предложи пациенту записаться к одному из них (назови имя), время бери ДОСЛОВНО из их offer_slots.',
  };
}

function healthyPayload(date) {
  return {
    slots: ['11:00', '12:00', '17:30', '19:00'].map(t => slot(date, t)),
    source: 'schedule',
    offer_slots: [slot(date, '17:30')],
    staff_name: ASTEMIR.name,
  };
}

const CASES = [
  {
    phone: '79000000921',
    label: 'мастер в отпуске — чужие окна нельзя выдавать за его',
    // Услуга названа ЯВНО и мастер тоже: иначе промпт (справедливо) сначала
    // уточняет процедуру, ход кончается вопросом и до слотов не доходит вовсе —
    // фикстура не отрабатывает, а проверка зеленеет впустую.
    client: 'Марина',
    text: `Здравствуйте! Хочу записаться на Profhilo 2 ml к ${PERI.name.split(' ')[1]} на понедельник, 17 августа`,
    slots: (input) => vacancyPayload(input.date || '2026-08-17'),
    seed: [['outgoing', 'До встречи🤍', 'operator']],
    check(reply, calls, tools) {
      const v = guard.checkStaffAttribution(reply, {
        emptyStaff: [PERI.name], availableStaff: [ASTEMIR.name],
      });
      const namedOwner = guard.mentionsPerson(reply, ASTEMIR.name);
      const hasTime = guard.extractTimes(reply).length > 0;
      return [
        // Без вызова слотов сценарий не отработал: фикстура не доехала до модели,
        // и «нарушений нет» ничего не доказывает.
        ['слоты действительно запрашивались', tools.includes('get_available_slots'), tools.join(' → ') || '(нет)'],
        ['чужое время не приписано мастеру в отпуске', v.length === 0, JSON.stringify(v)],
        ['назван владелец окон либо время не названо вовсе', namedOwner || !hasTime,
          `владелец=${namedOwner} время=${hasTime}`],
      ];
    },
  },
  {
    phone: '79000000922',
    label: 'раньше отвечал только администратор — Мила обязана представиться',
    text: 'Добрый день! Подскажите, сколько длится процедура?',
    seed: [
      ['incoming', 'Опоздаю на 10 минут'],
      ['outgoing', 'Добрый день!🤍 Ожидаем вас☺️', 'operator'],
    ],
    check(reply) {
      return [['есть представление', greeting.hasIntroduction(reply), reply.slice(0, 80)]];
    },
  },
  {
    phone: '79000000923',
    label: 'оценка визита «5» — благодарность, а не «чем могу помочь»',
    text: '5',
    // Все исходящие служебные и идут ПОДРЯД в начале окна — ровно та форма, на
    // которой ведущие assistant-реплики срезаются целиком.
    seed: [
      ['outgoing', 'Вы записаны на прием 09.08.2026 19:30 в «PERI CLINIC».', 'system'],
      ['outgoing', 'Спасибо что посетили «PERI CLINIC»! Просим Вас оценить обслуживание, '
        + 'отправив в ответ сообщение с цифрой от 2 до 5, где \n2- Вы совершенно недовольны визитом\n'
        + '3- больше минусов, чем плюсов\n4- были мелкие недочеты, но в целом всё Ок\n5- все отлично', 'system'],
    ],
    check(reply) {
      return [
        ['поблагодарила за оценку', /(спасибо|благодар)/i.test(reply), reply.slice(0, 80)],
        ['не спрашивает «чем могу помочь»', !/чем\s+(могу|можем)\s+помочь/i.test(reply), reply.slice(0, 80)],
      ];
    },
  },
  {
    phone: '79000000924',
    label: 'КОНТРОЛЬ: мастер работает, окна есть — довызова быть не должно',
    client: 'Анна',
    text: `Здравствуйте! Хочу записаться на Profhilo 2 ml к ${ASTEMIR.name.split(' ')[0]}у на 17 августа`,
    slots: (input) => healthyPayload(input.date || '2026-08-17'),
    check(reply, calls, tools) {
      const toolless = calls.filter(c => Array.isArray(c.tools) && c.tools.length === 0).length;
      const times = guard.extractTimes(reply);
      return [
        ['слоты действительно запрашивались', tools.includes('get_available_slots'), tools.join(' → ') || '(нет)'],
        ['корректирующего довызова не было', toolless === 0, `вызовов без инструментов: ${toolless}`],
        // Время должно быть ИЗ ВЫДАЧИ: это же контроль на ложные unknown_time.
        ['названо время из выдачи', times.some(t => ['11:00', '12:00', '17:30', '19:00'].includes(t)),
          `${times.join(',')} | ${reply.slice(0, 60)}`],
      ];
    },
  },
];

function wrapRegistry(c, calls) {
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
      // Слоты подменяем фикстурой: сценарий обязан быть воспроизводимым, а
      // боевое расписание живёт своей жизнью (отпуск Пери кончается 31.08).
      if (name === 'get_available_slots' && c.slots) {
        const out = c.slots(input || {});
        console.log(`      · [fixture] ${JSON.stringify(out).slice(0, 120)}…`);
        return out;
      }
      return fn(salonId, input, ctx);
    };
  }
  return { schemas: base.schemas, handlers };
}

async function cleanup(c) {
  for (const t of ['chatpush_messages', 'agent_dialogs', 'agent_events', 'agent_tool_events']) {
    const col = t === 'chatpush_messages' ? `COALESCE(NULLIF(phone,''), chat_id)` : 'dialog_key';
    await db.query(`DELETE FROM ${t} WHERE salon_id=$1 AND ${col}=$2`, [SALON, c.phone]);
  }
  if (c.client) await db.query(`DELETE FROM clients WHERE salon_id=$1 AND phone=$2`, [SALON, c.phone]);
}

async function runCase(c) {
  console.log(`\n=== ${c.label} ===\n  «${c.text}»`);
  await cleanup(c);
  const ts = Math.floor(Date.now() / 1000);
  const insert = (direction, text, at, authoredBy) => db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts, authored_by)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
      `attrprobe:${c.phone}:${at}:${direction}`, text, c.phone, at, authoredBy || null]);
  if (c.client) {
    await db.query(`INSERT INTO clients (salon_id, name, phone) VALUES ($1,$2,$3)`, [SALON, c.client, c.phone]);
  }
  const seed = c.seed || [];
  // Разрыв больше 6 ч — чтобы сработал блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ»: именно на
  // нём стоял запрет представляться, из-за которого случился инцидент.
  for (let i = 0; i < seed.length; i++) {
    await insert(seed[i][0], seed[i][1], ts - 86400 - (seed.length - i) * 60, seed[i][2]);
  }
  await insert('incoming', c.text, ts);

  const realProvider = providers.getProvider();
  const providerCalls = [];
  const provider = Object.assign(Object.create(realProvider), {
    createMessage: async (req) => {
      const resp = await realProvider.createMessage(req);
      providerCalls.push({ tools: req.tools, system: String(req.system || ''), text: resp.text || '' });
      return resp;
    },
  });

  const calls = [];
  const res = await orchestrator.runDialog(SALON, c.phone, {
    ctx: { phone: c.phone, channel: CHANNEL },
    deps: { registry: wrapRegistry(c, calls), provider },
  });
  const reply = (res.replies || []).join('\n');
  const lastModelText = (providerCalls.filter(p => p.text).slice(-1)[0] || {}).text || '';
  console.log(`  инструменты: ${calls.length ? calls.join(' → ') : '(нет)'}`);
  console.log(`  вызовов провайдера: ${providerCalls.length}`);
  if (lastModelText && lastModelText !== reply) {
    console.log(`  ← сама модель: ${lastModelText.replace(/\n/g, ' | ').slice(0, 220)}`);
    console.log(`    (расхождение = сработала детерминированная правка кода)`);
  }
  console.log(`  → Мила: ${reply.replace(/\n/g, ' | ') || '(нет ответа)'}`);
  await cleanup(c);

  const checks = c.check(reply, providerCalls, calls);
  let ok = true;
  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${name}${pass ? '' : ` — ${detail}`}`);
    ok = ok && pass;
  }
  return ok;
}

async function main() {
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}`);
  console.log('реальные сообщения НЕ отправляются: диспетчер не участвует, пишет только БД пробника\n');
  const only = process.argv[2];
  const repeat = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 1;
  const cases = only ? CASES.filter(c => c.label.includes(only)) : CASES;
  const results = [];
  for (let r = 0; r < repeat; r++) for (const c of cases) results.push([c.label, await runCase(c)]);
  console.log(`\n=== ИТОГ: ${results.filter(([, o]) => o).length}/${results.length} ===`);
  for (const [label, o] of results) console.log(`  ${o ? '✅' : '❌'} ${label}`);
  return results.every(([, o]) => o);
}

main().then(async (ok) => { await pool.end(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error('PROBE FAILED:', e); try { await pool.end(); } catch (_) { /* */ } process.exit(1); });
