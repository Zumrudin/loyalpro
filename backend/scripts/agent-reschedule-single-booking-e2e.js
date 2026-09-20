#!/usr/bin/env node
// Живая проверка фикса «лишний вопрос про процедуру + wrong_service при переносе»
// (инцидент 2026-09-19, 79096664042; ветка agent-reschedule-redundant-question-guard,
// смержена в main). Два сценария на тестовом номере:
//
//   1. ОДНА активная запись + пациент просит перенести на пятницу — Мила НЕ должна
//      спрашивать «на какую процедуру», должна сразу перейти к поиску времени по
//      мастеру и услуге ЭТОЙ записи. После переноса услуга записи должна остаться
//      той же (проверяется прямым запросом к YClients).
//   2. ДВЕ активные записи + тот же неконкретный запрос переноса — Мила ДОЛЖНА
//      уточнить, какую именно (guard не должен мешать легальному уточнению).
//
// Прогоняется через НАСТОЯЩИЙ диспетчер (реальный LLM, реальные инструменты,
// реальный YClients). Ответы клиенту НЕ отправляются (send застаблен) — реплики
// печатаются здесь. Тестовые записи создаются и УДАЛЯЮТСЯ в конце (--keep оставляет).
//
// ВНИМАНИЕ: платный LLM (polza/gemini), реальные записи в боевом YClients (удаляются).
//
// Usage: node backend/scripts/agent-reschedule-single-booking-e2e.js [--keep] [--only 1|2]
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
const CHANNEL = 'max';
const STAFF = 3356928;      // Богатырева Татьяна
const SERVICE_A = 9536765;  // ноги+бикини+подмышки
const SERVICE_B = 9536744;  // малая зона

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

const ASK_PROCEDURE_RE = /на\s+как[а-яё]*\s+(?:процедур|услуг)[а-яё]*/iu;

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

async function clearHistory() {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
}

async function runTurn(n, incomings) {
  turn = n;
  console.log(`\n=== ХОД ${n}: ${incomings.map(t => `«${t}»`).join(' + ')} ===`);
  for (const t of incomings) await insertMsg('incoming', t);
  const replies = [];
  await dispatcher.process(SALON, PHONE, meta(incomings[incomings.length - 1]), {
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
  const names = calls.filter(c => c.turn === n).map(c => c.name);
  console.log(`  инструменты: ${names.length ? names.join(' → ') : '(нет)'}`);
  for (const t of replies) { console.log(`  → Мила: ${t.replace(/\n/g, '\n           ')}`); await insertMsg('outgoing', t); }
  if (!replies.length) console.log('  → (реплик нет)');
  const askedProcedure = replies.some(t => ASK_PROCEDURE_RE.test(t));
  console.log(`  спросила «на какую процедуру»: ${askedProcedure ? 'ДА ⚠️' : 'нет'}`);
  await new Promise(r => setTimeout(r, 1500));   // markDelivered — fire-and-forget
  return { names, replies, askedProcedure };
}

async function listRecords(salon) {
  const recs = await ycGetClientRecords(salon, CLIENT_ID, { startDate: '2026-09-20' });
  return recs.filter(r => !r.deleted && Number(r.attendance) !== -1)
    .map(r => ({ id: r.id, datetime: r.datetime, staff: r.staff && r.staff.name,
      services: (r.services || []).map(s => ({ id: s.id, title: s.title })), comment: r.comment }));
}

async function deleteRecord(salon, id) {
  try {
    await axios.delete(`${config.YC}/record/${salon.yclients_company_id}/${id}`, { headers: ycHeaders(salon), timeout: 15000 });
    return 'deleted';
  } catch (e) {
    const r = await bookingModify.cancelBookingRecord(SALON, { dialogKey: 'e2e', recordId: id, expectedYcClientId: CLIENT_ID });
    return r.ok ? 'cancelled (delete failed: ' + (e.response ? e.response.status : e.message) + ')' : 'FAILED: ' + r.error;
  }
}

async function probeSlot(salon, serviceId, date) {
  const probe = await getSlots.run(SALON, { staff_yc_id: STAFF, service_yc_id: serviceId, date }, { nowMs: Date.now() });
  const times = (probe.slots || []).map(s => s.time);
  return { times, notWorking: !!probe.staff_not_working, seance: probe.slots && probe.slots[0] && probe.slots[0].seance_length };
}

// ── Сценарий 1: одна запись — переспроса про процедуру быть не должно ──────
async function scenario1(salon) {
  console.log('\n\n########## СЦЕНАРИЙ 1: одна активная запись ##########');
  const initDate = '2026-09-23'; // ср — у Татьяны рабочий день (проверено пробником)
  const probeInit = await probeSlot(salon, SERVICE_A, initDate);
  if (!probeInit.times.length) { console.error(`нет слотов у Татьяны на ${initDate} — правь initDate в скрипте`); return null; }
  const initTime = probeInit.times[0];

  const before = await listRecords(salon);
  if (before.length) console.log(`ВНИМАНИЕ: у тестового клиента уже есть будущие записи: ${JSON.stringify(before)}`);

  const rec = await ycCreateRecord(salon, {
    staffYcId: STAFF, serviceYcIds: [SERVICE_A], datetime: `${initDate}T${initTime}:00+03:00`,
    seanceLength: probeInit.seance || 3000, clientPhone: PHONE, clientName: 'Зумрудин',
    comment: 'E2E: сценарий 1 (одна запись, перенос без переспроса) — тестовая, удалить',
  });
  console.log(`создана запись ${rec && rec.id} на ${initDate} ${initTime}, услуга ${SERVICE_A}`);

  await clearHistory();

  try {
    const t1 = await runTurn(1, ['Добрый день! Перенесите, пожалуйста, на четверг']);
    let t2 = null, t3 = null;
    // Живой ответ непредсказуем: подыграем разумно, чтобы довести до факта переноса.
    const last = () => (t3 || t2 || t1).replies.slice(-1)[0] || '';
    if (/половин[а-яё]*\s+дня|утр|вечер|перв[а-яё]*\s+или/i.test(last())) {
      t2 = await runTurn(2, ['Вторая половина дня, пожалуйста']);
    } else if (/на\s+\d{1,2}\s+сентября|уточн[а-яё]*\s+дату|какую\s+дату/i.test(last())) {
      t2 = await runTurn(2, ['На четверг, 24 сентября']);
    }
    if (t2 && /\d{1,2}[:.]\d{2}/.test(last()) && !/(перенесл|записал)/i.test(last())) {
      const m = last().match(/(\d{1,2})[:.](\d{2})/);
      t3 = await runTurn(3, [`Да, ${m[1]}:${m[2]} подходит`]);
    }
    const allAsked = [t1, t2, t3].filter(Boolean).some(t => t.askedProcedure);

    console.log('\n--- Итог сценария 1 ---');
    console.log(`спросила «на какую процедуру» хоть раз за диалог: ${allAsked ? 'ДА — ДЕФЕКТ ⚠️' : 'нет — ОК'}`);
    const after = await listRecords(salon);
    console.log(`записи после диалога: ${JSON.stringify(after)}`);
    const moved = after.find(r => r.id !== rec.id) || after.find(r => r.datetime && r.datetime.startsWith('2026-09-24'));
    if (moved) {
      const sameService = moved.services.length === 1 && Number(moved.services[0].id) === SERVICE_A;
      console.log(`перенесена на 24.09: ${moved.datetime}; услуга сохранена (id ${SERVICE_A}): ${sameService ? 'ДА — ОК' : 'НЕТ — ДЕФЕКТ ⚠️ (' + JSON.stringify(moved.services) + ')'}`);
    } else {
      console.log('перенос НЕ подтверждён записью в YClients (диалог не довели до конца этим прогоном)');
    }
    return { rec, after, allAsked };
  } catch (e) {
    console.error('СЦЕНАРИЙ 1 упал:', e);
    return { rec, after: await listRecords(salon), error: e };
  }
}

// ── Сценарий 2 (контроль): две записи — переспрос «какую именно» легален ───
async function scenario2(salon) {
  console.log('\n\n########## СЦЕНАРИЙ 2 (контроль): две активные записи ##########');
  const dateA = '2026-09-23';
  const dateB = '2026-09-24';
  const probeA = await probeSlot(salon, SERVICE_A, dateA);
  const probeB = await probeSlot(salon, SERVICE_B, dateB);
  if (!probeA.times.length || !probeB.times.length) {
    console.error(`нет слотов на ${dateA}/${dateB} — правь даты в скрипте`); return null;
  }
  const recA = await ycCreateRecord(salon, {
    staffYcId: STAFF, serviceYcIds: [SERVICE_A], datetime: `${dateA}T${probeA.times[0]}:00+03:00`,
    seanceLength: probeA.seance || 3000, clientPhone: PHONE, clientName: 'Зумрудин',
    comment: 'E2E: сценарий 2, запись A — тестовая, удалить',
  });
  const recB = await ycCreateRecord(salon, {
    staffYcId: STAFF, serviceYcIds: [SERVICE_B], datetime: `${dateB}T${probeB.times[0]}:00+03:00`,
    seanceLength: probeB.seance || 900, clientPhone: PHONE, clientName: 'Зумрудин',
    comment: 'E2E: сценарий 2, запись B — тестовая, удалить',
  });
  console.log(`созданы записи ${recA && recA.id} (${dateA}) и ${recB && recB.id} (${dateB})`);

  await clearHistory();

  try {
    const t1 = await runTurn(1, ['Здравствуйте, перенесите мою запись на пятницу, пожалуйста']);
    const askedWhich = /как[а-яё]*\s+имен|уточн[а-яё]*,?\s+как[а-яё]*|которую/i.test(t1.replies.join(' '));
    console.log('\n--- Итог сценария 2 ---');
    console.log(`уточнила, какую именно запись: ${askedWhich ? 'ДА — ОК (легальное уточнение)' : 'НЕТ — возможно дефект, проверь реплику выше'}`);
    console.log(`спросила «на какую процедуру» (гейт не должен был тронуть эту ветку): ${t1.askedProcedure ? 'ДА — обсудить' : 'нет'}`);
    return { recA, recB };
  } catch (e) {
    console.error('СЦЕНАРИЙ 2 упал:', e);
    return { recA, recB, error: e };
  }
}

async function main() {
  const salon = await db.one(`SELECT * FROM salons WHERE id=$1`, [SALON]);
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}, память=${config.AGENT_TOOL_MEMORY}`);

  const created = [];
  try {
    if (!ONLY || ONLY === '1') {
      const r1 = await scenario1(salon);
      if (r1 && r1.rec) created.push(r1.rec.id);
      if (r1 && r1.after) for (const rr of r1.after) if (!created.includes(rr.id)) created.push(rr.id);
    }
    if (!ONLY || ONLY === '2') {
      const r2 = await scenario2(salon);
      if (r2 && r2.recA) created.push(r2.recA.id);
      if (r2 && r2.recB) created.push(r2.recB.id);
    }
  } finally {
    console.log('\n\n=== ЖУРНАЛ ВЫЗОВОВ ИНСТРУМЕНТОВ (все ходы) ===');
    for (const c of calls) console.log(`  ход ${c.turn}: ${c.name}(${JSON.stringify(c.input)})`);

    if (!KEEP) {
      console.log('\n=== ОЧИСТКА ===');
      const finalRecs = await listRecords(salon);
      const idsToDelete = new Set([...created, ...finalRecs.map(r => r.id)]);
      for (const id of idsToDelete) console.log(`  запись ${id}: ${await deleteRecord(salon, id)}`);
    } else {
      console.log('\n--keep: тестовые записи оставлены в YClients');
    }
  }
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
