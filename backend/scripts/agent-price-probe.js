#!/usr/bin/env node
// Живая проверка цены: различает ли Мила цену у обычного врача и у главного
// врача, и берёт ли мужской прайс («Муж.»-услуги) пациенту-мужчине.
// Инцидент 2026-08-01: на «сколько для меня стоит комплекс ботокс 5в1 у Пери»
// пациенту-мужчине названы 19 000 ₽ (женская базовая цена; у главврача 23 000 ₽,
// мужская — 29 900 ₽).
//
// Работает на СИНТЕТИЧЕСКИХ номерах: реальные диалоги (в т.ч. тестовый
// 79200255591) не трогает и после прогона чистит за собой. Инструменты записи
// подменены заглушками — вопрос только про цену, но страховка обязательна.
//
// ВНИМАНИЕ: ходит в платный LLM (~3-5 ₽ за ход).
// Usage: node backend/scripts/agent-price-probe.js
const { db, pool } = require('../db');
const config = require('../config');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');

const SALON = 1;
const CHANNEL = 'whatsapp';

// Что ждём: 19000 — базовая женская цена (провал), 23000 — женская у главврача,
// 24700 — мужская базовая, 29900 — мужская у главврача.
const CASES = [
  {
    phone: '79000000901',
    label: 'мужчина, главный врач Пери',
    text: 'Здравствуйте! Меня зовут Зумрудин. Сколько для меня будет стоить комплекс ботокс 5в1 у Пери?',
    expect: '29 900',
    bad: ['19 000', '19000', '23 000', '24 700'],
  },
  {
    phone: '79000000902',
    label: 'женщина, главный врач Пери',
    text: 'Здравствуйте! Меня зовут Анна. Сколько стоит комплекс ботокс 5в1 у Пери Исамудиновны?',
    expect: '23 000',
    bad: ['19 000', '19000', '29 900', '24 700'],
  },
  {
    // Худший случай: в истории висит СТАРЫЙ неверный ответ, а пациент просит
    // «уточнить ещё раз» — соблазн скопировать свою же прошлую сумму.
    phone: '79000000903',
    label: 'мужчина переспрашивает, в истории старый неверный ответ 19 000 ₽',
    seed: [
      ['incoming', 'Здравствуйте! Меня зовут Зумрудин. Сколько для меня будет стоить комплекс ботокс 5в1 у Пери?'],
      ['outgoing', 'Зумрудин, стоимость комплекса «5в1» у главного врача Пери Исамудиновны составляет 19 000 ₽.\n\nХотите записаться на процедуру?'],
    ],
    text: 'еще раз уточните ,сколько для меня будет стоить комплекс ботокс 5в1 у Пери ?',
    expect: '29 900',
    bad: ['19 000', '19000', '23 000', '24 700'],
  },
];

function wrapRegistry(calls) {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      calls.push(name);
      console.log(`    ▸ tool ${name} ${JSON.stringify(input).slice(0, 200)}`);
      if (/create_booking|book_chain|modify_booking_services|reschedule_booking|cancel_booking/.test(name)) {
        console.log('      · [stub] запись в YClients не выполняется');
        return { created: false, error: 'stub: пробник цен ничего не записывает' };
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
}

async function runCase(c) {
  console.log(`\n=== ${c.label} ===\n  «${c.text}»`);
  await cleanup(c.phone);
  const ts = Math.floor(Date.now() / 1000);
  const insert = (direction, text, at) => db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `probe:${c.phone}:${at}:${direction}`, text, c.phone, at]);
  // История до вопроса (если кейс её задаёт) — с более ранними msg_ts.
  const seed = c.seed || [];
  for (let i = 0; i < seed.length; i++) await insert(seed[i][0], seed[i][1], ts - (seed.length - i) * 60);
  await insert('incoming', c.text, ts);

  const calls = [];
  const res = await orchestrator.runDialog(SALON, c.phone, {
    ctx: { phone: c.phone, channel: CHANNEL },
    deps: { registry: wrapRegistry(calls) },
  });
  const reply = (res.replies || []).join('\n');
  console.log(`  инструменты: ${calls.length ? calls.join(' → ') : '(нет)'}`);
  console.log(`  → Мила: ${reply || '(нет ответа)'}`);
  await cleanup(c.phone);

  const flat = reply.replace(/ /g, ' ');
  const ok = flat.includes(c.expect) || flat.includes(c.expect.replace(/\s/g, ''));
  const wrong = c.bad.filter(b => flat.includes(b));
  console.log(`  ожидали ${c.expect} ₽ → ${ok ? 'ЕСТЬ ✅' : 'НЕТ ❌'}${wrong.length ? `; в ответе чужая цена: ${wrong.join(', ')} ❌` : ''}`);
  return ok && !wrong.length;
}

async function main() {
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}`);
  const results = [];
  for (const c of CASES) results.push(await runCase(c));
  console.log(`\n=== ИТОГ: ${results.filter(Boolean).length}/${results.length} ===`);
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('PROBE FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
