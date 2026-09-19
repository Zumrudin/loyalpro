#!/usr/bin/env node
// Живая репродукция инцидента 2026-09-19 (79651442032) на тестовом номере.
//
// Что делает: (1) создаёт в YClients запись на тестовый номер — те же три услуги
// у Богатырёвой Татьяны, что были у пациентки; (2) чистит историю диалога;
// (3) прогоняет через НАСТОЯЩИЙ диспетчер (реальный LLM, реальные инструменты,
// реальный YClients) реплики пациентки в том же порядке; последнюю — через
// ветку закрытого окна расписания (gate outside-schedule); (4) в конце
// удаляет тестовую запись (и ту, куда её перенесла Мила).
// Ответы клиенту НЕ отправляются (send застаблен) — реплики печатаются здесь.
// ВНИМАНИЕ: платный LLM, реальная запись в боевом YClients (удаляется в конце).
//
// Usage: node backend/scripts/agent-reschedule-replay-e2e.js [--keep] [--date YYYY-MM-DD] [--time HH:MM]
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
const CHANNEL = 'max';
const STAFF = 3356928;                       // Богатырева Татьяна
const SERVICES = [9536765, 9536744, 9536762]; // как у пациентки: ноги+бикини+подмышки, малая зона, ягодицы
const SEANCE = 3000 + 300 + 900;
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const DATE = argOf('--date') || '2026-09-20';
const TIME = argOf('--time') || '12:00';

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
      console.log(`    ▸ ${name}(${JSON.stringify(input)}) → ${brief.length > 260 ? brief.slice(0, 260) + '…' : brief}`);
      return result;
    };
  }
  return { schemas: base.schemas, handlers };
}

async function insertMsg(direction, text, extra = {}) {
  const ts = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, chat_id, msg_ts, authored_by)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9,$10)
     ON CONFLICT (salon_id, external_message_id) DO NOTHING`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `e2e:${direction}:${ts}:${Math.floor(Math.random() * 1e6)}`, text, PHONE, 'e2e-chat', ts,
     direction === 'outgoing' ? (extra.authoredBy || 'agent') : null]);
}

function meta(text) { return { phone: PHONE, channel: CHANNEL, chatId: 'e2e-chat', text }; }

async function runTurn(n, incomings, opts = {}) {
  turn = n;
  console.log(`\n=== ХОД ${n}: ${incomings.map(t => `«${t}»`).join(' + ')} ===`);
  for (const t of incomings) await insertMsg('incoming', t);
  const replies = [];
  const settings = {
    ...agentSettings,
    isAllowed: async () => (opts.outsideSchedule
      ? { allow: false, reason: 'outside-schedule' } : { allow: true, reason: 'ok' }),
  };
  await dispatcher.process(SALON, PHONE, meta(incomings[incomings.length - 1]), {
    settings,
    send: async (_m, text) => { replies.push(text); },
    persistOwn: async () => {},
    windowHandoverMin: 60,
    orchestrator: {
      runDialog: (sid, key, o) => orchestrator.runDialog(sid, key, {
        ...o, deps: { ...(o.deps || {}), registry: wrapRegistry(), provider: providers.getProvider() },
      }),
    },
  });
  const names = calls.filter(c => c.turn === n).map(c => c.name);
  console.log(`  инструменты: ${names.length ? names.join(' → ') : '(нет)'}`);
  for (const t of replies) { console.log(`  → Мила: ${t.replace(/\n/g, '\n           ')}`); await insertMsg('outgoing', t); }
  if (!replies.length) console.log('  → (реплик нет)');
  const dlg = await db.oneOrNone(`SELECT status, escalated_reason FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  console.log(`  диалог: ${dlg ? `${dlg.status}${dlg.escalated_reason ? ' (' + dlg.escalated_reason + ')' : ''}` : '(нет строки)'}`);
  await new Promise(r => setTimeout(r, 1500));   // markDelivered — fire-and-forget
  return { names, replies, dlg };
}

async function listRecords(salon) {
  const recs = await ycGetClientRecords(salon, 134014107, { startDate: '2026-09-19' });
  return recs.filter(r => !r.deleted && Number(r.attendance) !== -1)
    .map(r => ({ id: r.id, datetime: r.datetime, staff: r.staff && r.staff.name,
      services: (r.services || []).map(s => s.title), comment: r.comment }));
}

async function deleteRecord(salon, id) {
  try {
    await axios.delete(`${config.YC}/record/${salon.yclients_company_id}/${id}`, { headers: ycHeaders(salon), timeout: 15000 });
    return 'deleted';
  } catch (e) {
    const r = await bookingModify.cancelBookingRecord(SALON, { dialogKey: 'e2e', recordId: id, expectedYcClientId: 134014107 });
    return r.ok ? 'cancelled (delete failed: ' + (e.response ? e.response.status : e.message) + ')' : 'FAILED: ' + r.error;
  }
}

async function main() {
  const salon = await db.one(`SELECT * FROM salons WHERE id=$1`, [SALON]);
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}, память=${config.AGENT_TOOL_MEMORY}`);

  // 0. Свободно ли выбранное время у Татьяны под основную услугу.
  const probe = await getSlots.run(SALON, { staff_yc_id: STAFF, service_yc_id: SERVICES[0], date: DATE }, { nowMs: Date.now() });
  const times = (probe.slots || []).map(s => s.time);
  console.log(`слоты Татьяны ${DATE} (осн. услуга): ${times.join(', ') || '(нет)'}${probe.staff_not_working ? ' — НЕ РАБОТАЕТ' : ''}`);
  if (!times.includes(TIME)) { console.error(`время ${TIME} не свободно — задай --date/--time`); return; }

  // 1. Запись, как у пациентки: три услуги у Татьяны одним визитом.
  const before = await listRecords(salon);
  if (before.length) console.log(`уже есть будущие записи тестового клиента: ${JSON.stringify(before)}`);
  const rec = await ycCreateRecord(salon, {
    staffYcId: STAFF, serviceYcIds: SERVICES, datetime: `${DATE}T${TIME}:00+03:00`, seanceLength: SEANCE,
    clientPhone: PHONE, clientName: 'Зумрудин', comment: 'E2E-репродукция инцидента 2026-09-19 (тестовая запись, удалить)',
  });
  console.log(`создана запись ${rec && rec.id} на ${DATE} ${TIME}: ${JSON.stringify(await listRecords(salon))}`);

  // 2. Чистая история диалога.
  const del = await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  console.log(`история очищена (${del.rowCount} сообщений)`);

  try {
    // 3. Реплики пациентки — дословно.
    await runTurn(1, ['Доброе утро. Чётко не понимала вчера получится или нет. \nМожно перенести на пн утро?']);
    await runTurn(2, ['Вы со скольки работаете и работает ли Татьяна?']);
    await runTurn(3, ['Вт время?']);
    await runTurn(4, ['В среду утром возможно?']);
    await runTurn(5, ['Или утро или ближе к вечеру']);
    await runTurn(6, ['Нет', 'Днем не могу']);
    // 09:32 — окно закрылось. Ветка window-handover.
    await runTurn(7, ['Удобнее, если перезвонит администратор. Здесь просто тратить время.   Бесполезно.'], { outsideSchedule: true });
  } finally {
    console.log('\n=== ИТОГ ===');
    const ev = await db.any(
      `SELECT tool, is_error, delivered, to_char(created_at,'HH24:MI:SS') AS at, input
         FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2 ORDER BY id`, [SALON, PHONE]);
    for (const r of ev) console.log(`  ${r.at} ${r.tool}${r.is_error ? ' ERROR' : ''} delivered=${r.delivered} ${JSON.stringify(r.input)}`);
    const after = await listRecords(salon);
    console.log(`записи тестового клиента в YClients после прогона: ${JSON.stringify(after)}`);
    if (!KEEP) {
      for (const r of after) console.log(`  запись ${r.id} (${r.datetime}): ${await deleteRecord(salon, r.id)}`);
    } else console.log('  --keep: записи оставлены');
  }
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
