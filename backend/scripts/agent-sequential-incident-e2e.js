#!/usr/bin/env node
// Живая репродукция инцидента 2026-09-22 (79265824264): стыковка трёх услуг у
// Пери на 06.10, пациентка просит 18:00 — до фикса `get_sequential_slots` отдавал
// первые 4 хронологических старта, 18:00 срезал кап, и Мила отвечала «не помещается».
//
// Два сценария в ОДНОМ процессе (кэш вариантов in-memory):
//   A — дословные реплики инцидента (ждём: 18:00 подтверждено, book_chain на 18:00);
//   B — та же просьба БЕЗ времени (ждём: первым названо плотное время из offer_times).
// Реальный LLM, реальный YClients (сетка Пери), реальные инструменты, КРОМЕ записи:
// book_chain подменён заглушкой (в YClients ничего не создаётся). Отправка застаблена,
// гейт допуска подменён in-process (на деве агент выключен), исходящие пишем в БД сами.
// История тестового номера ЧИСТИТСЯ. Платный LLM: ≈5 ходов ≈ 10–15 ₽.
//
// Usage: node backend/scripts/agent-sequential-incident-e2e.js [--date 2026-10-06] [--scenario A|B]
//
// Первый прогон 22.09 нашёл ДВЕ дыры мимо юнит-тестов: (1) витрина вариантов
// (in-memory) утекала из сценария A в B — теперь сбрасывается в clearHistory;
// (2) честный черновик «6 октября, во вторник, … 13:30 или 16:00» гасил
// offer-attribution: день недели после явной даты перезаписывал контекст
// ближайшим вторником, то есть СЕГОДНЯ — починено в offer-attribution.js.
const { db, pool } = require('../db');
const config = require('../config');
const settings = require('../services/agent-settings');
const dispatcher = require('../services/agent/dispatcher');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const bookChain = require('../services/agent/tools/book-chain');
const seqOffers = require('../services/agent/sequential-offers');

const SALON = 1;
const PHONE = '79200255591';
const CHANNEL = 'whatsapp';
const argDate = (() => { const i = process.argv.indexOf('--date'); return i > 0 ? process.argv[i + 1] : null; })();
// --scenario A|B — гонять один сценарий (каждый ход ≈ 3 ₽).
const ONLY = (() => { const i = process.argv.indexOf('--scenario'); return i > 0 ? String(process.argv[i + 1]).toUpperCase() : null; })();
const DATE_HUMAN = argDate ? argDate : '6 октября';

const calls = [];
let turn = 0;
let fakeRecordId = 900000001;
const seqResults = [];

function wrapRegistry() {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      calls.push({ turn, name, input });
      console.log(`    ▸ tool ${name} ${JSON.stringify(input).slice(0, 200)}`);
      if (name === 'book_chain') {
        return bookChain.run(salonId, input, ctx, {
          createBooking: async (sid, inp) => {
            console.log(`      · [stub] create_booking ${inp.datetime} svc=${inp.service_yc_id} staff=${inp.staff_yc_id} len=${inp.seance_length}`);
            calls.push({ turn, name: 'create_booking(stub)', input: inp });
            return { created: true, record_id: fakeRecordId++ };
          },
          modifyServices: async (sid, inp) => ({ modified: true, record_id: inp.record_id, services_count: 1 + (inp.add_service_yc_ids || []).length }),
        });
      }
      const res = await fn(salonId, input, ctx);
      if (name === 'get_sequential_slots') {
        seqResults.push({ turn, res });
        for (const v of (res.variants || [])) {
          console.log(`      · ${v.type} ${v.date} ${v.staff.map(s => s.name).join('+')}: starts=${v.starts.map(s => s.time).join(',')} offer_times=${JSON.stringify(v.offer_times)}`);
        }
        console.log(`      · patient_time_free=${JSON.stringify(res.patient_time_free)}`);
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
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts, authored_by)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9)
     ON CONFLICT (salon_id, external_message_id) DO NOTHING`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `e2e:${direction}:${ts}:${Math.floor(Math.random() * 1e6)}`, text, PHONE, ts,
     direction === 'outgoing' ? 'agent' : null]);
}

async function clearHistory() {
  // Витрина вариантов — in-memory на процесс; без сброса второй сценарий видел бы
  // варианты первого в промпте (поймано первым прогоном: модель сама поставила day_part=evening).
  seqOffers._reset();
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]).catch(() => {});
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]).catch(() => {});
}

const qa = [];
async function runTurn(n, incoming) {
  turn = n;
  console.log(`\n=== ХОД ${n}: «${incoming}» ===`);
  await insertMsg('incoming', incoming);
  const replies = [];
  await dispatcher.process(SALON, PHONE, { phone: PHONE, channel: CHANNEL, text: incoming }, {
    send: async (meta, text) => { replies.push(text); },
    orchestrator: {
      runDialog: (sid, key, o) => orchestrator.runDialog(sid, key, {
        ...o, deps: { ...(o.deps || {}), registry: wrapRegistry() },
      }),
    },
  });
  const names = calls.filter(c => c.turn === n).map(c => c.name);
  console.log(`  инструменты хода: ${names.length ? names.join(' → ') : '(нет)'}`);
  for (const t of replies) { console.log(`  → Мила: ${t}`); await insertMsg('outgoing', t); }
  if (!replies.length) console.log('  → (реплик нет)');
  qa.push({ q: incoming, a: replies.length ? replies.join('\n\n') : '(молчание)', tools: names });
  return { names, replies };
}

async function main() {
  // Гейт допуска — in-process: на деве агент выключен, а менять настройки салона
  // в БД ради прогона нельзя (живой PM2 начал бы отвечать реальным входящим).
  settings.isAllowed = async () => ({ allow: true, reason: 'e2e' });
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}, номер=${PHONE}`);

  let a2 = { replies: [] }, b1 = { replies: [] }, qaA = [], qaB = [];
  if (!ONLY || ONLY === 'A') {
    console.log('\n########## СЦЕНАРИЙ A — дословный инцидент (пациентка просит 18:00) ##########');
    await clearHistory();
    await runTurn(1, `Здравствуйте! Подскажите, пожалуйста, Пери работает ${DATE_HUMAN}?`);
    a2 = await runTurn(2, 'Запишите пожалуйста на 18.00. Ботокс глаза и меж бровка , увеличение губ.');
    await runTurn(3, 'Да, записывайте');
    qaA = qa.splice(0);
  }
  if (!ONLY || ONLY === 'B') {
    console.log('\n########## СЦЕНАРИЙ B — та же просьба без времени (плотность) ##########');
    await clearHistory();
    b1 = await runTurn(4, `Здравствуйте! Запишите меня, пожалуйста, к Пери на ${DATE_HUMAN}: ботокс глаза и межбровье, увеличение губ.`);
    qaB = qa.splice(0);
  }

  console.log('\n=== ИТОГ ===');
  const seqA = seqResults.find(r => r.turn === 2);
  const starts18 = seqA && (seqA.res.variants || []).some(v => v.type === 'same_staff' && v.starts.some(s => s.time === '18:00'));
  const ptf = seqA && Array.isArray(seqA.res.patient_time_free) && seqA.res.patient_time_free.includes('18:00');
  const lied = /18[:.]00[^.]*(не помещ|занят|недоступ|не получ)/iu.test(a2.replies.join(' '))
    || /(не помещ|занят|недоступ)[^.]*18[:.]00/iu.test(a2.replies.join(' '));
  const confirmed18 = /18[:.]00/.test(a2.replies.join(' ')) && !lied;
  const booked = calls.filter(c => c.turn === 3 && c.name === 'create_booking(stub)');
  const booked18 = booked.some(c => /T18:00/.test(String(c.input.datetime)));
  if (!ONLY || ONLY === 'A') {
    console.log(`A: 18:00 в starts same_staff: ${starts18 ? '✅' : '❌'}; patient_time_free=18:00: ${ptf ? '✅' : '❌'}`);
    console.log(`A: реплика хода 2 подтверждает 18:00 (без «не помещается/занято»): ${confirmed18 ? '✅' : '❌'}`);
    console.log(`A: book_chain на ходе 3 → create_booking на 18:00: ${booked18 ? '✅' : '❌'}${booked.length ? '' : ' (записи не было)'}`);
  }
  const seqB = seqResults.find(r => r.turn === 4);
  const offerB = seqB && (seqB.res.variants[0] || {}).offer_times;
  const firstTimeB = (b1.replies.join(' ').match(/\b(\d{1,2}[:.]\d{2})\b/) || [])[1];
  const denseFirst = offerB && firstTimeB && offerB.includes(firstTimeB.replace('.', ':'));
  if (!ONLY || ONLY === 'B') {
    console.log(`B: offer_times=${JSON.stringify(offerB)}, первое названное время в реплике: ${firstTimeB || '(нет)'} → ${denseFirst ? '✅ плотное' : '❌'}`);
  }

  console.log('\n=== ВОПРОС → ОТВЕТ ===');
  for (const [title, list] of [['СЦЕНАРИЙ A', qaA], ['СЦЕНАРИЙ B', qaB]]) {
    console.log(`\n--- ${title} ---`);
    for (const x of list) console.log(`\nПациент: ${x.q}\nМила: ${x.a}\n[инструменты: ${x.tools.join(', ') || 'нет'}]`);
  }
  await clearHistory();
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
