#!/usr/bin/env node
// Живая репродукция инцидента 2026-11-11 (прод, 79166123348) на тестовом номере.
//
// Запись у Пери из ТРЁХ услуг (Profhilo + Lumecca + 600 ИМП, 75 мин); пациентка
// переносит её на четверг и спрашивает «в 11? или 12?». У Пери в четверг в 12:00
// окно лишь до 13:00 — вся запись туда не помещается. До фикса Мила называла
// 12:00 «свободным», YClients отказывал после «да», диалог уходил администратору.
//
// Что делает: (1) создаёт в YClients тестовую запись на 79200255591; (2) чистит
// историю диалога в БД (дев); (3) гонит реплики через НАСТОЯЩИЙ диспетчер
// (реальный LLM, реальные инструменты, реальный YClients), ответы пациентки на
// предложение Милы — по её же реплике («да» / первое названное время);
// (4) проверяет итог и УДАЛЯЕТ тестовую запись. Сообщения никому не уходят
// (send застаблен). ВНИМАНИЕ: платный LLM и запись в боевом YClients.
//
// Usage: node backend/scripts/agent-reschedule-record-length-e2e.js [--keep]
//          [--date 2026-11-17 --time 13:15 --target-day четверг --target 2026-11-19]
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
const { ycGetRecord } = require('../services/yclients-records');
const { extractTimes } = require('../services/agent/reply-guard');

const SALON = 1;
const PHONE = '79200255591';
const YC_CLIENT = 134014107;
const CHANNEL = 'whatsapp';
const STAFF = 1910274;                          // Гаджиева Пери
const SERVICES = [9536495, 15394152, 26099275]; // Profhilo 2 ml, Lumecca лицо, 600 ИМП
const SEANCE = 4500;                            // 75 мин, как у пациентки
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DATE = argOf('--date', '2026-11-17');
const TIME = argOf('--time', '13:15');
const TARGET = argOf('--target', '2026-11-19');
const TARGET_DAY = argOf('--target-day', 'четверг');
const DAY_NUM = Number(DATE.slice(8, 10));

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
      console.log(`    ▸ ${name}(${JSON.stringify(input)}) → ${brief.length > 300 ? brief.slice(0, 300) + '…' : brief}`);
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
     `e2e:${direction}:${ts}:${Math.floor(Math.random() * 1e6)}`, text, PHONE, `${PHONE}@c.us`, ts,
     direction === 'outgoing' ? 'agent' : null]);
}

async function runTurn(n, incomings) {
  turn = n;
  console.log(`\n=== ХОД ${n}: ${incomings.map(t => `«${t}»`).join(' + ')} ===`);
  for (const t of incomings) await insertMsg('incoming', t);
  const replies = [];
  await dispatcher.process(SALON, PHONE, { phone: PHONE, channel: CHANNEL, chatId: `${PHONE}@c.us`, text: incomings[incomings.length - 1] }, {
    settings: { ...agentSettings, isAllowed: async () => ({ allow: true, reason: 'ok' }) },
    send: async (_m, text) => { replies.push(text); },
    persistOwn: async () => {},
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
  return { names, replies, text: replies.join('\n'), dlg };
}

async function clearHistory() {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  for (const t of ['agent_dialogs', 'agent_events', 'agent_tool_events', 'agent_followups']) {
    await db.query(`DELETE FROM ${t} WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  }
}

async function deleteRecord(salon, id) {
  try {
    await axios.delete(`${config.YC}/record/${salon.yclients_company_id}/${id}`, { headers: ycHeaders(salon), timeout: 15000 });
    return 'deleted';
  } catch (e) { return 'DELETE FAILED: ' + (e.response ? e.response.status : e.message); }
}

async function main() {
  const salon = await db.one(`SELECT * FROM salons WHERE id=$1`, [SALON]);
  console.log(`провайдер=${config.AGENT_PROVIDER}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}, память=${config.AGENT_TOOL_MEMORY}`);

  const rec = await ycCreateRecord(salon, {
    staffYcId: STAFF, serviceYcIds: SERVICES, datetime: `${DATE}T${TIME}:00+03:00`, seanceLength: SEANCE,
    clientPhone: PHONE, clientName: 'Зумрудин', comment: 'E2E-репродукция инцидента 2026-11-11 (тестовая запись, удалить)',
  });
  const recId = rec && rec.id;
  if (!recId) { console.error('запись не создалась:', JSON.stringify(rec)); return; }
  console.log(`создана тестовая запись ${recId}: ${DATE} ${TIME}, 3 услуги, ${SEANCE / 60} мин`);
  await clearHistory();

  const verdict = [];
  let moved = null;
  try {
    await runTurn(1, [`здравствуйте! я записана ${DAY_NUM} ноября, но скорее всего не смогу, когда можно ещё придти к пери на след неделе?`]);
    await runTurn(2, ['в какие она работает скажите', `${DAY_NUM} не могу`]);
    const t3 = await runTurn(3, [`в ${TARGET_DAY} в 11?`, 'или 12?']);
    if (extractTimes(t3.text).includes('12:00') && !/не\s+(помещ|получ|подойд)|занят|недоступ/i.test(t3.text)) {
      verdict.push('ПРОВАЛ: Мила снова назвала 12:00 как вариант');
    }
    // Ответ пациентки — по реплике Милы: одно время → «да», несколько → первое.
    for (let n = 4; n <= 6; n++) {
      const last = calls.filter(c => c.name === 'reschedule_booking' && c.result && c.result.rescheduled);
      if (last.length) break;
      const prev = (await db.oneOrNone(
        `SELECT text FROM chatpush_messages WHERE salon_id=$1 AND phone=$2 AND direction='outgoing' ORDER BY id DESC LIMIT 1`,
        [SALON, PHONE]) || {}).text || '';
      // Время СТАРОЙ записи («с 17 ноября 13:15 на …») вариантом не считаем.
      const times = extractTimes(prev).filter(t => t !== TIME);
      const answer = times.length > 1 ? `давайте в ${times[0]}` : 'да';
      const t = await runTurn(n, [answer]);
      if (t.dlg && t.dlg.status === 'escalated') { verdict.push(`ПРОВАЛ: диалог ушёл администратору (${t.dlg.escalated_reason})`); break; }
    }
  } finally {
    console.log('\n=== ИТОГ ===');
    const resch = calls.filter(c => c.name === 'reschedule_booking');
    for (const c of resch) console.log(`  reschedule_booking(${JSON.stringify(c.input)}) → ${JSON.stringify(c.result).slice(0, 300)}`);
    try {
      const r = await ycGetRecord(salon, recId);
      moved = { datetime: r.datetime, seance_length: r.seance_length, staff: r.staff_id,
        services: (r.services || []).map(s => Number(s.id)), deleted: !!r.deleted };
      console.log(`  запись ${recId} в YClients после прогона: ${JSON.stringify(moved)}`);
    } catch (e) { console.log(`  запись ${recId}: не прочитать (${e.message})`); }
    const ok = resch.some(c => c.result && c.result.rescheduled);
    if (!ok && !verdict.length) verdict.push('ПРОВАЛ: перенос так и не выполнен');
    if (moved) {
      if (!String(moved.datetime).startsWith(TARGET) && ok) verdict.push(`ПРОВАЛ: перенесено не на ${TARGET}`);
      if (Number(moved.seance_length) !== SEANCE) verdict.push(`ПРОВАЛ: длительность ${moved.seance_length} вместо ${SEANCE}`);
      if (JSON.stringify([...moved.services].sort()) !== JSON.stringify([...SERVICES].sort())) verdict.push('ПРОВАЛ: состав услуг изменился');
      if (Number(moved.staff) !== STAFF) verdict.push('ПРОВАЛ: сменился мастер');
    }
    console.log(verdict.length ? verdict.map(v => '  ' + v).join('\n') : '  PASS: 12:00 не предлагалось, перенос выполнен, услуги/мастер/длительность сохранены, без администратора');
    if (!KEEP) {
      console.log(`  удаление тестовой записи ${recId}: ${await deleteRecord(salon, recId)}`);
      await clearHistory();
      console.log('  история тестового диалога очищена');
    } else console.log('  --keep: запись и история оставлены');
  }
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
