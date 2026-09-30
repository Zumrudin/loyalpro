#!/usr/bin/env node
// Живая репродукция инцидента 2026-09-30 (79110624600, tdlib): пациентка четырежды
// подтвердила перенос («Да», «Да», «Переносим», «Подтверждаю»), а гейт согласия
// отвечал needs_confirmation — он разбирал реплику Милы и требовал в ней одну дату.
// После фикса согласие определяет модель (patient_confirmed у reschedule_booking).
//
// На тестовом номере создаётся та же запись (капельница «Золушка» у Татьяны на 09.10
// вечером), реплики пациентки гонятся дословно через НАСТОЯЩИЙ диспетчер (реальный
// LLM, реальные инструменты, реальный YClients). Ответы клиенту НЕ отправляются (send
// застаблен) — реплики печатаются здесь. Запись в конце УДАЛЯЕТСЯ (--keep оставляет).
// Время переноса: 14:00 на 10.10, как в инциденте; если оно занято — первое свободное
// во второй половине дня (--time HH:MM задаёт явно).
//
// ВНИМАНИЕ: платный LLM, реальная запись в боевом YClients (удаляется).
//
// --seed: первые два хода НЕ играются моделью — в историю кладутся реплики Милы из
// инцидента дословно (вопрос с ДВУМЯ датами «с 9 октября на это время»), живьём идёт
// только ответ «Да». Это ровно та точка, где гейт отказывал.
//
// Usage: node backend/scripts/agent-reschedule-consent-e2e.js [--keep] [--time HH:MM] [--seed]
const axios = require('axios');
const { db, pool } = require('../db');
const config = require('../config');
const agentSettings = require('../services/agent-settings');
const dispatcher = require('../services/agent/dispatcher');
const orchestrator = require('../services/agent/orchestrator');
const providers = require('../services/agent/providers');
const registry = require('../services/agent/tools');
const { ycHeaders } = require('../services/yclients');
const { ycCreateRecord } = require('../services/yclients-booking');
const { ycGetClientRecords } = require('../services/yclients-records');
const getSlots = require('../services/agent/tools/get-available-slots');
const bookingModify = require('../services/agent/booking-modify');

const SALON = 1;
const PHONE = '79200255591';
const CLIENT_ID = 134014107;
const CHANNEL = 'tdlib';
const STAFF = 3356928;     // Богатырева Татьяна
const SERVICE = 12496006;  // капельница «Золушка», 60 мин — услуга записи из инцидента
const FROM_DATE = '2026-10-09';
const TO_DATE = '2026-10-10';

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const SEED = argv.includes('--seed');
const timeIdx = argv.indexOf('--time');
const TIME_ARG = timeIdx >= 0 ? argv[timeIdx + 1] : null;

const calls = [];
let turn = 0;

function wrapRegistry() {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      const result = await fn(salonId, input, ctx);
      calls.push({ turn, name, input, result });
      const brief = JSON.stringify(result || {});
      console.log(`    ▸ ${name}(${JSON.stringify(input)}) → ${brief.length > 220 ? brief.slice(0, 220) + '…' : brief}`);
      return result;
    };
  }
  return { schemas: base.schemas, handlers };
}

async function insertMsg(direction, text) {
  const ts = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, chat_id, msg_ts, authored_by)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9,$10)
     ON CONFLICT (salon_id, external_message_id) DO NOTHING`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `e2e:${direction}:${ts}:${Math.floor(Math.random() * 1e6)}`, text, PHONE, 'e2e-chat', ts,
     direction === 'outgoing' ? 'agent' : null]);
}

async function clearHistory() {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  for (const t of ['agent_dialogs', 'agent_events', 'agent_tool_events', 'agent_followups']) {
    await db.query(`DELETE FROM ${t} WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  }
}

async function runTurn(n, incomings) {
  turn = n;
  console.log(`\n=== ХОД ${n} ===`);
  for (const t of incomings) { console.log(`  ← Пациент: ${t}`); await insertMsg('incoming', t); }
  const replies = [];
  await dispatcher.process(SALON, PHONE, { phone: PHONE, channel: CHANNEL, chatId: 'e2e-chat', text: incomings[incomings.length - 1] }, {
    settings: { ...agentSettings, isAllowed: async () => ({ allow: true, reason: 'ok' }) },
    send: async (_m, text) => { replies.push(text); },
    persistOwn: async () => {},
    windowHandoverMin: 60,
    orchestrator: {
      runDialog: (sid, key, o) => orchestrator.runDialog(sid, key, {
        ...o, deps: { ...(o.deps || {}), registry: wrapRegistry(), provider: providers.getProvider() },
      }),
    },
  });
  for (const t of replies) { console.log(`  → Мила: ${t.replace(/\n/g, '\n          ')}`); await insertMsg('outgoing', t); }
  if (!replies.length) console.log('  → (реплик нет)');
  await new Promise(r => setTimeout(r, 1500));   // markDelivered — fire-and-forget
  const mine = calls.filter(c => c.turn === n && c.name === 'reschedule_booking');
  return { replies, moved: mine.some(c => c.result && c.result.rescheduled), reschedule: mine };
}

async function listRecords(salon) {
  const recs = await ycGetClientRecords(salon, CLIENT_ID, { startDate: '2026-09-30' });
  return recs.filter(r => !r.deleted && Number(r.attendance) !== -1)
    .map(r => ({ id: r.id, datetime: r.datetime, staff: r.staff && r.staff.name,
      services: (r.services || []).map(s => s.id) }));
}

async function deleteRecord(salon, id) {
  try {
    await axios.delete(`${config.YC}/record/${salon.yclients_company_id}/${id}`, { headers: ycHeaders(salon), timeout: 15000 });
    return 'deleted';
  } catch (e) {
    const r = await bookingModify.cancelBookingRecord(SALON, { dialogKey: 'e2e', recordId: id, expectedYcClientId: CLIENT_ID });
    return r.ok ? 'cancelled' : 'FAILED: ' + r.error;
  }
}

async function slotsOn(date) {
  const probe = await getSlots.run(SALON, { staff_yc_id: STAFF, service_yc_id: SERVICE, date }, { nowMs: Date.now() });
  return probe.slots || [];
}

async function main() {
  const salon = await db.one(`SELECT * FROM salons WHERE id=$1`, [SALON]);
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}, память=${config.AGENT_TOOL_MEMORY}`);

  const before = await listRecords(salon);
  if (before.length) { console.error(`у тестового клиента уже есть будущие записи — прогон остановлен: ${JSON.stringify(before)}`); return; }

  const fromSlots = await slotsOn(FROM_DATE);
  const toSlots = await slotsOn(TO_DATE);
  const fromSlot = fromSlots.find(s => s.time === '19:00') || fromSlots[fromSlots.length - 1];
  const toTime = TIME_ARG || (toSlots.find(s => s.time === '14:00') || toSlots.find(s => s.time >= '14:00') || {}).time;
  if (!fromSlot || !toTime) { console.error(`нет слотов: ${FROM_DATE}=${fromSlots.length}, ${TO_DATE}=${toSlots.length}`); return; }
  console.log(`свободно ${TO_DATE}: ${toSlots.map(s => s.time).join(', ')}`);

  const rec = await ycCreateRecord(salon, {
    staffYcId: STAFF, serviceYcIds: [SERVICE], datetime: fromSlot.datetime,
    seanceLength: fromSlot.seance_length || 3600, clientPhone: PHONE, clientName: 'Зумрудин',
    comment: 'E2E: инцидент 30.09 (согласие на перенос) — тестовая, удалить',
  });
  console.log(`создана запись ${rec && rec.id} на ${FROM_DATE} ${fromSlot.time}; пациент попросит ${TO_DATE} ${toTime}`);
  await clearHistory();

  let moved = false;
  let confirmations = 0;
  try {
    const first = ['Добрый день, можно ли сместить запись с 9.10 на 10 или 11 число?',
      'Или 8 вечер) Не знаю в какие дни Татьяна работает'];
    let r = { moved: false };
    if (SEED) {
      const seeded = [
        ['incoming', first[0]], ['incoming', first[1]],
        ['outgoing', 'Здравствуйте! Татьяна работает в субботу, 10 октября, с 10:00 до 22:00; 8-го и 11-го она не принимает. На какое время 10-го посмотреть возможность переноса?'],
        ['incoming', toTime],
        ['outgoing', `В субботу, 10 октября, в ${toTime} у Татьяны свободно. Перенести Вашу запись на капельницу «Золушка» с 9 октября на это время?`],
      ];
      console.log('\n=== ЗАСЕВ (реплики инцидента, модель не вызывалась) ===');
      for (const [d, t] of seeded) {
        console.log(`  ${d === 'incoming' ? '← Пациент' : '→ Мила (засев)'}: ${t}`);
        await insertMsg(d, t);
        await new Promise(res => setTimeout(res, 1100));   // разные msg_ts — порядок транскрипта
      }
    } else {
      await runTurn(1, first);
      r = await runTurn(2, [toTime]);
    }
    moved = r.moved;
    // Дословные ответы пациентки из инцидента — по одному, пока перенос не состоится.
    for (const [i, text] of ['Да', 'Да', 'Переносим', 'Подтверждаю'].entries()) {
      if (moved) break;
      confirmations += 1;
      r = await runTurn(3 + i, [text]);
      moved = r.moved;
    }
  } catch (e) {
    console.error('ПРОГОН упал:', e);
  } finally {
    console.log('\n=== ВЫЗОВЫ reschedule_booking ===');
    for (const c of calls.filter(x => x.name === 'reschedule_booking')) {
      const res = c.result || {};
      console.log(`  ход ${c.turn}: patient_confirmed=${JSON.stringify(c.input.patient_confirmed)} datetime=${c.input.datetime} → ${res.rescheduled ? 'ПЕРЕНЕСЕНО' : Object.keys(res).filter(k => res[k] === true).join(',') || res.error}`);
    }
    const after = await listRecords(salon);
    console.log('\n=== ИТОГ ===');
    console.log(`подтверждений пациента до переноса: ${confirmations}; перенос состоялся: ${moved ? 'ДА' : 'НЕТ ⚠️'}`);
    console.log(`записи в YClients после диалога: ${JSON.stringify(after)}`);
    if (!KEEP) {
      const ids = new Set([rec && rec.id, ...after.map(x => x.id)].filter(Boolean));
      for (const id of ids) console.log(`  очистка: запись ${id}: ${await deleteRecord(salon, id)}`);
    } else {
      console.log('--keep: тестовая запись оставлена в YClients');
    }
  }
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
