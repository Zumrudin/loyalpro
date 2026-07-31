#!/usr/bin/env node
// Живой двухходовой E2E: переживает ли option_id границу хода.
// Ход 1 — просьба состыковать две услуги (ждём get_sequential_slots + витрину вариантов).
// Ход 2 — «давайте первый вариант» (ждём СРАЗУ book_chain по option_id из промпта,
//         БЕЗ повторного get_sequential_slots).
// Реальный LLM и реальные инструменты, кроме записи в YClients: createBooking/modify
// подменены заглушками (проверяем маршрут выбора варианта, а не создание записей —
// оно уже проверялось живым E2E 30.07). Ответы клиенту НЕ отправляются: send застаблен,
// исходящие пишем в БД сами (иначе транскрипт второго хода будет без реплики Милы).
//
// ВНИМАНИЕ: ходит в платный LLM (2 хода ≈ 10 ₽ на gemini-2.5-pro) и ЧИСТИТ историю
// тестового диалога. Оба хода обязаны идти в ОДНОМ процессе: кэш вариантов
// (sequential-offers) — in-memory, ровно это и проверяем.
//
// Usage: node backend/scripts/agent-sequential-e2e.js
const { db, pool } = require('../db');
const config = require('../config');
const dispatcher = require('../services/agent/dispatcher');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const bookChain = require('../services/agent/tools/book-chain');
const seqOffers = require('../services/agent/sequential-offers');

const SALON = 1;
const PHONE = '79200255591';
const CHANNEL = 'whatsapp';

const calls = [];          // [{ turn, name, input }]
let turn = 0;
let fakeRecordId = 900000001;

function wrapRegistry() {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      calls.push({ turn, name, input });
      console.log(`    ▸ tool ${name} ${JSON.stringify(input).slice(0, 220)}`);
      if (name === 'book_chain') {
        return bookChain.run(salonId, input, ctx, {
          createBooking: async (sid, inp) => {
            console.log(`      · [stub] create_booking ${inp.datetime} svc=${inp.service_yc_id} staff=${inp.staff_yc_id} len=${inp.seance_length}`);
            return { created: true, record_id: fakeRecordId++ };
          },
          modifyServices: async (sid, inp) => {
            console.log(`      · [stub] modify_booking_services record=${inp.record_id} add=${JSON.stringify(inp.add_service_yc_ids)}`);
            return { modified: true, record_id: inp.record_id, services_count: 1 + (inp.add_service_yc_ids || []).length };
          },
        });
      }
      const res = await fn(salonId, input, ctx);
      if (name === 'get_sequential_slots') {
        const opts = res && res.options ? Object.keys(res.options).length : (Array.isArray(res && res.variants) ? res.variants.length : '?');
        console.log(`      · вариантов в ответе: ${opts}`);
      }
      return res;
    };
  }
  return { schemas: base.schemas, handlers };
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

async function runTurn(n, incoming) {
  turn = n;
  console.log(`\n=== ХОД ${n}: «${incoming}» ===`);
  await insertMsg('incoming', incoming);

  const live = seqOffers.peek(SALON, PHONE);
  const rendered = live ? seqOffers.renderOffers(live) : [];
  console.log(`  витрина вариантов в промпте: ${rendered.length ? '' : '(пусто)'}`);
  for (const l of rendered) console.log(`    - ${l}`);

  const replies = [];
  await dispatcher.process(SALON, PHONE, { phone: PHONE, channel: CHANNEL }, {
    send: async (meta, text) => { replies.push(text); },
    orchestrator: {
      runDialog: (sid, key, o) => orchestrator.runDialog(sid, key, {
        ...o, deps: { ...(o.deps || {}), registry: wrapRegistry() },
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
  return { names, replies };
}

async function main() {
  // Чистый лист: история и состояние диалога.
  const del = await db.query(
    `DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  console.log(`история очищена (${del.rowCount} сообщений), провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}`);

  const t1 = await runTurn(1, 'Здравствуйте! Хочу комбинированную чистку лица и консультацию врача-косметолога в один день, желательно подряд. Что есть на этой неделе?');
  const t2 = await runTurn(2, 'Давайте первый вариант');

  console.log('\n=== ИТОГ ===');
  const seqT2 = t2.names.filter(n => n === 'get_sequential_slots').length;
  const chainT2 = calls.filter(c => c.turn === 2 && c.name === 'book_chain');
  console.log(`get_sequential_slots на ходе 1: ${t1.names.filter(n => n === 'get_sequential_slots').length}`);
  console.log(`get_sequential_slots на ходе 2: ${seqT2}  (ожидание: 0)`);
  console.log(`book_chain на ходе 2: ${chainT2.length}${chainT2.length ? ` option_id=${chainT2.map(c => c.input && c.input.option_id).join(',')}` : ''}`);
  console.log(seqT2 === 0 && chainT2.length ? 'ВЕРДИКТ: option_id пережил границу хода ✅' : 'ВЕРДИКТ: дефект воспроизводится ❌');
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
