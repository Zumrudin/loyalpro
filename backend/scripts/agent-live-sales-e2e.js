#!/usr/bin/env node
'use strict';
// Живой сквозной прогон Милы на ДЕВ-стенде (ветка feat/mila-consultative-sales):
// новые кейсы консультативной продажи (цена → факт + шаг, «дорого», «подумаю»,
// «не знаю, что выбрать», справка в напоминании о себе, гашение напоминания
// записью в CRM) + базовые (первое обращение, staff_options, запись с
// подтверждением, «я записана?», перенос, отмена, стыковка двух услуг, прайс,
// КБ, «+» на акцию, оценка визита 5/2, «спасибо», мед. граница, осложнение).
//
// Реплики пациента — ДОСЛОВНО из реальной истории chatpush_messages (кроме
// помеченных synthetic). Диалог — Telegram (tdlib) тестового номера владельца
// 79200255591 / chat 385578542. Ход идёт через НАСТОЯЩИЙ диспетчер: реальный
// LLM (дев-провайдер codex — PATH с node v20), реальные инструменты, реальный
// YClients, РЕАЛЬНАЯ ОТПРАВКА в Telegram (флаг --dry застабливает отправку).
// Гейт допуска подменён in-process (agent_settings в БД не трогаем).
//
// БЕЗОПАСНОСТЬ:
//  - только дев-БД loyalpro_test;
//  - записи в YClients — только на номер владельца; все НОВЫЕ будущие записи
//    клиента 134014107, появившиеся за прогон, удаляются в finally;
//  - история диалога 79200255591 (реальная переписка владельца с клиникой в
//    dev-БД) бэкапится в logs/ ДО прогона и восстанавливается в finally;
//  - строки agent_followups скрипта ставятся с next_at = +1 сутки (боевой
//    воркер pm2 их не арендует) и удаляются в finally.
//
// Usage:
//   PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH \
//     node backend/scripts/agent-live-sales-e2e.js [--dry] [--only=A,B,...] [--keep-records]
// Группы: A — продажа (1,2,3,7), B — нерешительность+цена+напоминание (4,1b,5),
// C — запись/перенос/отмена/спасибо (6,8,9,10,11,12,18), D — стыковка (13),
// E — прайс/КБ/мед. граница (14,15,19), F — осложнение (20), G — «+» на акцию (16),
// H — оценка визита (17).
// НЕ ПАЙПИТЬ вывод (уборка в finally): пишите в файл `> log 2>&1`.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config');

let dbName = '';
try { dbName = new URL(config.DATABASE_URL).pathname; } catch (_) { /* ниже отказ */ }
if (dbName !== '/loyalpro_test') {
  console.error(`agent-live-sales-e2e: только для дев-БД loyalpro_test (сейчас «${dbName || '?'}») — отказ`);
  process.exit(2);
}

const { db, pool } = require('../db');
const agentSettings = require('../services/agent-settings');
const dispatcher = require('../services/agent/dispatcher');
const orchestrator = require('../services/agent/orchestrator');
const providers = require('../services/agent/providers');
const registry = require('../services/agent/tools');
const chatpush = require('../services/chatpush');
const authorship = require('../services/outgoing-authorship');
const seqOffers = require('../services/agent/sequential-offers');
const pendingReplies = require('../services/agent/pending-replies');
const additionalProposals = require('../services/agent/additional-proposals');
const followupWorker = require('../services/agent/followup-worker');
const { ycHeaders } = require('../services/yclients');
const { ycGetClientRecords } = require('../services/yclients-records');
const getSlots = require('../services/agent/tools/get-available-slots');
const bookingModify = require('../services/agent/booking-modify');
const { TAIL_HEADER } = require('../services/agent/sales-modules');

const SALON = 1;
const PHONE = '79200255591';
const CHANNEL = 'tdlib';
const CHAT_ID = '385578542';
const YC_CLIENT = 134014107;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const KEEP_RECORDS = argv.includes('--keep-records');
const ONLY = ((argv.find(a => a.startsWith('--only=')) || '').slice(7) || '').split(',').filter(Boolean);
const PAUSE_MS = 5000;
const RUN_TAG = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_JSON = path.join(__dirname, '..', 'logs', `e2e-live-sales-${RUN_TAG}.json`);
const BACKUP_JSON = path.join(__dirname, '..', 'logs', `e2e-live-sales-backup-${RUN_TAG}.json`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// ── перехват stdout: телеметрия оркестратора/guard'ов пишется winston'ом ──
let logBuf = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  try { for (const l of stripAnsi(chunk).split('\n')) if (l.trim()) logBuf.push(l); } catch (_) {}
  return origWrite(chunk, ...rest);
};
const INTERESTING = /(price-followthrough|справка об услуге|reply-guard|молчим|оценка визита|предвызов|дописываю|довызов|погашенн|гашу|перевод на человека|эскалац|escalat|выбрасываю|повтор с теми же|hint|FollowupWorker|followup #|отложенный прогон|ход без реплик|подтверждено журналом|принят в доставку|price photo|фото прайса|завершающая вежливость|акци|needs_phone|tool \w+)/i;

const results = [];          // все ходы
const caseNotes = {};        // доп. факты по кейсам
const calls = [];
let curTurn = null;
const sentLog = [];          // реальные отправки (текст + delivery id)
const createdRecordIds = new Set();
let seedCounter = 0;

function note(caseId, key, val) { (caseNotes[caseId] ||= {})[key] = val; console.log(`  [note ${caseId}] ${key}: ${JSON.stringify(val)}`); }

// ── обёртки: реестр (журнал вызовов), провайдер (системные промпты) ──
function wrapRegistry() {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      const result = await fn(salonId, input, ctx);
      const brief = JSON.stringify(result || {});
      calls.push({ turn: curTurn && curTurn.n, name, input, result });
      if (curTurn) curTurn.tools.push({ name, input, result: brief.length > 700 ? brief.slice(0, 700) + '…' : brief });
      for (const k of ['record_id']) if (result && result[k] && (result.created || result.rescheduled || result.new_record_id)) createdRecordIds.add(String(result[k]));
      if (result && result.new_record_id) createdRecordIds.add(String(result.new_record_id));
      if (result && Array.isArray(result.records)) for (const r of result.records) if (r && r.record_id) createdRecordIds.add(String(r.record_id));
      console.log(`    ▸ ${name}(${JSON.stringify(input)}) → ${brief.length > 300 ? brief.slice(0, 300) + '…' : brief}`);
      return result;
    };
  }
  return { schemas: base.schemas, handlers };
}

function wrapProvider() {
  const base = providers.getProviderForSalon(SALON);
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'createMessage') {
        return (req, o) => { if (curTurn) curTurn.systems.push(String((req && req.system) || '')); return target.createMessage(req, o); };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const BLOCKS = {
  'СПРАВКА ОБ УСЛУГЕ': 'СПРАВКА ОБ УСЛУГЕ (найдена автоматически',
  'СЦЕНАРИЙ (продажа)': TAIL_HEADER,
  'СТАТЬЯ ОБ АКЦИИ': 'СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА (найдена',
  'ПЕРВОЕ ОБРАЩЕНИЕ': '\nПЕРВОЕ ОБРАЩЕНИЕ:',
  'НАЧАЛО НОВОЙ ПЕРЕПИСКИ': '\nНАЧАЛО НОВОЙ ПЕРЕПИСКИ:',
  'АКТУАЛЬНЫЕ ЗАПИСИ': 'АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА (сверено',
  'ЖУРНАЛ ДЕЙСТВИЙ': 'ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ В ПРЕДЫДУЩИХ ХОДАХ (твоя',
  'ПРЕДЫДУЩИЕ СООБЩЕНИЯ КЛИНИКИ': 'ПРЕДЫДУЩИЕ СООБЩЕНИЯ КЛИНИКИ ЭТОМУ ПАЦИЕНТУ:',
  'АКТИВНЫЕ ВАРИАНТЫ СТЫКОВКИ': 'АКТИВНЫЕ ВАРИАНТЫ СТЫКОВКИ (действительны',
};

// ── отправка: реальная (или стаб при --dry), с журналом ──
let sendFailures = 0;
async function realSend(meta, text) {
  if (DRY) {
    // Без отправки эха не будет: кладём свою реплику в БД сами (authored_by='agent'),
    // иначе hasAgentEverWritten/hasEverAnswered врут и Мила представляется заново.
    const ts = Math.floor(Date.now() / 1000);
    await db.query(
      `INSERT INTO chatpush_messages
         (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, chat_id, msg_ts, authored_by)
       VALUES ($1,$2,$3,'outgoing',$4,'text',$5,$6,$7,$8,'agent')`,
      [SALON, config.CHATPUSH.customerId || null, CHANNEL, `e2e-live:${RUN_TAG}:out:${ts}:${Math.floor(Math.random() * 1e6)}`, text, PHONE, CHAT_ID, ts]);
    sentLog.push({ text, delivery: 'dry' }); if (curTurn) curTurn.sent.push(text); return { id: `dry-${Date.now()}` };
  }
  let out;
  try { out = await dispatcher.defaultSend(meta, text); }
  catch (e) { sendFailures += 1; sentLog.push({ text, error: String(e.message).slice(0, 200) }); if (curTurn) curTurn.sendErrors = [...(curTurn.sendErrors || []), String(e.message).slice(0, 120)]; throw e; }
  sentLog.push({ text, delivery: out && out.id });
  if (curTurn) curTurn.sent.push(text);
  return out;
}
async function realSendFile(meta, att) {
  if (DRY) { if (curTurn) curTurn.files.push(att.fileUrl); return { id: 'dry' }; }
  const out = await dispatcher.defaultSendFile(meta, att);
  if (curTurn) curTurn.files.push(`${att.fileUrl} → delivery ${out && out.id}`);
  return out;
}

function meta(text) { return { phone: PHONE, channel: CHANNEL, chatId: CHAT_ID, text }; }

async function insertIncoming(text) {
  const ts = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, chat_id, msg_ts, authored_by)
     VALUES ($1,$2,$3,'incoming',$4,'text',$5,$6,$7,$8,NULL)
     ON CONFLICT (salon_id, external_message_id) DO NOTHING`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL,
     `e2e-live:${RUN_TAG}:in:${ts}:${Math.floor(Math.random() * 1e6)}`, text, PHONE, CHAT_ID, ts]);
}

// Служебное сообщение клиники (опрос, акция, касание) — отправляется РЕАЛЬНО,
// автор 'system' пишется в журнал авторства, в БД кладётся эхом (ждём до 45 с),
// иначе вставляем сами. В --dry только вставка.
async function seedSystem(text) {
  seedCounter += 1;
  const insertSelf = async () => {
    const ts = Math.floor(Date.now() / 1000);
    await db.query(
      `INSERT INTO chatpush_messages
         (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, chat_id, msg_ts, authored_by)
       VALUES ($1,$2,$3,'outgoing',$4,'text',$5,$6,$7,$8,'system')`,
      [SALON, config.CHATPUSH.customerId || null, CHANNEL, `e2e-live:${RUN_TAG}:seed:${seedCounter}`, text, PHONE, CHAT_ID, ts]);
  };
  if (DRY) { await insertSelf(); return 'inserted(dry)'; }
  await authorship.remember(SALON, PHONE, text, 'system');
  const since = Math.floor(Date.now() / 1000) - 5;
  const out = await chatpush.sendMessage(config.CHATPUSH.instanceToken, { text, phone: PHONE, dispatchRouting: ['tdlib'] });
  console.log(`  [seed] отправлено служебное (delivery=${out && out.id}): ${text.slice(0, 70)}`);
  for (let i = 0; i < 15; i++) {
    await sleep(3000);
    const r = await db.oneOrNone(
      `SELECT id, authored_by FROM chatpush_messages WHERE salon_id=$1 AND phone=$2 AND direction='outgoing'
          AND msg_ts >= $3 AND text=$4 ORDER BY id DESC LIMIT 1`, [SALON, PHONE, since, text]);
    if (r) {
      if (r.authored_by !== 'system') {
        await db.query(`UPDATE chatpush_messages SET authored_by='system' WHERE id=$1`, [r.id]);
        return `echo id=${r.id} (authored_by ${r.authored_by} → system)`;
      }
      return `echo id=${r.id} authored_by=system`;
    }
  }
  await insertSelf();
  return 'echo не пришло за 45 с — вставлено скриптом';
}

async function dialogState() {
  return db.oneOrNone(`SELECT status, escalated_reason FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
}

async function resetEscalation(why) {
  const r = await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  console.log(`  [reset] agent_dialogs удалено ${r.rowCount} (${why})`);
}

async function clearHistory(label) {
  seqOffers._reset(); pendingReplies._reset(); additionalProposals._reset(); dispatcher._reset();
  const del = await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  console.log(`\n######## [${label}] история очищена (${del.rowCount} сообщений) ########`);
}

async function runTurn(caseId, text, opts = {}) {
  if (stopRequested) throw new Error('остановлено сигналом');
  const st = await dialogState();
  if (st && st.status === 'escalated' && st.escalated_reason === 'operator_reply') {
    note(caseId, 'operator_reply_pause_before_turn', st);
    await resetEscalation('пауза operator_reply перед ходом — вероятно, эхо своей реплики классифицировано как оператор');
  }
  const n = results.length + 1;
  curTurn = { n, caseId, text, synthetic: !!opts.synthetic, tools: [], systems: [], sent: [], files: [], res: null, logs: [], at: new Date().toISOString() };
  console.log(`\n=== ХОД ${n} [${caseId}]: «${text}» ===`);
  logBuf = [];
  await insertIncoming(text);
  const t0 = Date.now();
  await dispatcher.process(SALON, PHONE, meta(text), {
    settings: { ...agentSettings, isAllowed: async () => ({ allow: true, reason: 'ok' }) },
    send: realSend,
    sendFile: realSendFile,
    // --dry: журнал доставок НЕ пишем — иначе сторож доставки pm2 (крон */2)
    // через 5 мин переотправил бы «неподтверждённую» реплику по-настоящему.
    ...(DRY ? { deliveryLog: { record: async () => {} } } : {}),
    windowHandoverMin: 60,
    orchestrator: {
      runDialog: async (sid, key, o) => {
        const res = await orchestrator.runDialog(sid, key, {
          ...o, deps: { ...(o.deps || {}), registry: wrapRegistry(), provider: wrapProvider() },
        });
        if (curTurn) curTurn.res = res;
        return res;
      },
    },
  });
  await sleep(1500); // markDelivered / followup schedule — fire-and-forget
  const turn = curTurn;
  turn.ms = Date.now() - t0;
  const r = turn.res || {};
  turn.flags = {
    replies: (r.replies || []).length, silent: !!r.silent, escalated: !!r.escalated, alreadyEscalated: !!r.alreadyEscalated,
    falseSuccess: !!r.falseSuccess, bookingFailed: !!r.bookingFailed, writeSucceeded: !!r.writeSucceeded,
    sideEffect: !!r.sideEffect, turnId: r.turnId || null, followupStopReason: r.followupStopReason || null,
  };
  const first = turn.systems[0] || '';
  turn.blocks = Object.entries(BLOCKS).filter(([, m]) => first.includes(m)).map(([k]) => k);
  const fi = first.indexOf('СПРАВКА ОБ УСЛУГЕ (найдена автоматически');
  if (fi >= 0) turn.serviceFactBlock = first.slice(fi, fi + 900);
  const ti = first.indexOf(TAIL_HEADER);
  if (ti >= 0) turn.salesTail = first.slice(ti, ti + 700);
  turn.passes = turn.systems.length;
  turn.dialog = await dialogState();
  turn.logs = logBuf.filter(l => INTERESTING.test(l) && !/\[INFO \] \[(Webhook|Server)/.test(l)).map(l => l.slice(0, 600));
  delete turn.systems;
  console.log(`  инструменты: ${turn.tools.map(t => t.name).join(' → ') || '(нет)'} | проходов: ${turn.passes} | блоки: ${turn.blocks.join(', ') || '-'}`);
  for (const s of turn.sent) console.log(`  → Мила: ${s.replace(/\n/g, '\n           ')}`);
  if (!turn.sent.length) console.log('  → (ничего не отправлено)');
  console.log(`  флаги: ${JSON.stringify(turn.flags)} | диалог: ${JSON.stringify(turn.dialog)}`);
  results.push(turn);
  curTurn = null;
  if (turn.sendErrors && turn.sendErrors.length && !DRY) {
    saveJson();
    throw new Error(`отправка в Chatpush упала (${turn.sendErrors[0]}) — прогон остановлен`);
  }
  saveJson();
  await sleep(PAUSE_MS);
  return turn;
}

function saveJson() {
  try { fs.writeFileSync(OUT_JSON, JSON.stringify({ runTag: RUN_TAG, dry: DRY, results, caseNotes, sentLog, createdRecordIds: [...createdRecordIds] }, null, 1)); } catch (e) { origWrite(`saveJson: ${e.message}\n`); }
}

const lastSent = (t) => (t && t.sent.length ? t.sent.join('\n') : '');
const TIME_RE = /(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/g;
function timesIn(text) { return [...String(text).matchAll(TIME_RE)].map(m => `${m[1].padStart(2, '0')}:${m[2]}`); }
const okCall = (t, name, pred) => calls.some(c => c.turn === t.n && c.name === name && c.result && !c.result.error && (!pred || pred(c.result)));

// ── YClients ──
let salonRow = null;
// includeCancelled: отменённая Милой запись (cancel_booking) в YClients остаётся
// с attendance=-1 и deleted=false — для уборки её тоже надо удалить.
async function listFutureRecords(includeCancelled = false) {
  const recs = await ycGetClientRecords(salonRow, YC_CLIENT, { startDate: new Date().toISOString().slice(0, 10) });
  return recs.filter(r => !r.deleted && (includeCancelled || Number(r.attendance) !== -1))
    .map(r => ({ id: String(r.id), datetime: r.datetime, staff: r.staff && r.staff.name, services: (r.services || []).map(s => s.title) }));
}
async function deleteRecord(id) {
  try {
    await axios.delete(`${config.YC}/record/${salonRow.yclients_company_id}/${id}`, { headers: ycHeaders(salonRow), timeout: 15000 });
    return 'deleted';
  } catch (e) {
    const r = await bookingModify.cancelBookingRecord(SALON, { dialogKey: 'e2e', recordId: id, expectedYcClientId: YC_CLIENT });
    return r.ok ? `cancelled (delete failed: ${e.response ? e.response.status : e.message})` : `FAILED: ${r.error}`;
  }
}

// ── агент_followups: строка скрипта (не арендуется боевым воркером) ──
const scriptFollowupIds = new Set();
async function insertFollowup(dialogKey, phone, anchorAt, turnId) {
  const row = await db.one(
    `INSERT INTO agent_followups
       (salon_id, dialog_key, phone, channel, chat_id, anchor_at, next_at, anchor_turn_id, stage, status, attempts, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, NOW() + interval '1 day', $7, 0, 'scheduled', 0, now())
     RETURNING *`, [SALON, dialogKey, phone, CHANNEL, CHAT_ID, anchorAt, turnId ? String(turnId) : null]);
  scriptFollowupIds.add(row.id);
  return row;
}
async function leaseShape(row) {
  // То же, что LEASE_SQL кладёт в RETURNING, но с рабочими интервалами
  // (на деве followup_delay1_min=0 — настройки салона не трогаем).
  const extra = await db.one(
    `SELECT (SELECT name FROM salons WHERE id=$1) AS salon_name,
            (SELECT cl.name FROM clients cl WHERE cl.salon_id=$1 AND cl.phone LIKE '%' || $2 ORDER BY cl.id LIMIT 1) AS client_name`,
    [SALON, PHONE]);
  return { ...row, ...extra, attempts: 1, followup_delay1_min: 15, followup_delay2_min: 60,
    followup_final_text: null, followup_latest_time: null, followup_bonus_text: null,
    followup_welcome_text: null, followup_bonus_min_balance: null };
}
const workerDeps = (sendCapture) => ({
  followupEnabled: () => true,
  agentGloballyEnabled: () => true,
  isAllowed: async () => ({ allow: true, reason: 'ok' }),
  sendMessage: sendCapture,
});

// ══════════════════════ СЦЕНАРИИ ══════════════════════

async function groupA() {
  await clearHistory('A: первое обращение + цена + дорого + подумаю');
  const t1 = await runTurn('7+1', 'Я хотела уточнить по поводу чистка лица и фото омоложение Lumecca сколько стоит? Что входить.');
  const t2 = await runTurn('2', 'Дороговато для меня', { synthetic: true });
  const t3 = await runTurn('3', 'Спасибо за информацию,подумаю');
  return [t1, t2, t3];
}

async function groupB() {
  await clearHistory('B: не знаю что выбрать + цена + напоминание о себе');
  const t1 = await runTurn('4', 'Хочется немного освежить лицо перед отпуском. Может быть сможете подсказать, пожалуйста, что лучше рассмотреть?');
  const t2 = await runTurn('1b', 'Добрый день. Хочу узнать стоимость процедуры Volnewmer');
  // Кейс 5: напоминание о себе stage 0 после хода с ценой. Строка — скрипта
  // (next_at +1 сутки), обработка — настоящим processOne с реальной отправкой.
  await sleep(4000);
  const row = await insertFollowup(PHONE, PHONE, new Date(), t2.flags.turnId);
  const leased = await leaseShape(row);
  logBuf = [];
  const captured = [];
  await followupWorker.processOne(leased, workerDeps(async (payload) => {
    captured.push(payload.text);
    if (DRY) return { id: 'dry' };
    const out = await chatpush.sendMessage(config.CHATPUSH.instanceToken, payload);
    sentLog.push({ text: payload.text, delivery: out && out.id, followup: true });
    return out;
  }));
  const after = await db.one(`SELECT status, stage, close_reason, rendered_text, error FROM agent_followups WHERE id=$1`, [row.id]);
  note('5', 'followup_row_after', after);
  note('5', 'sent_text', captured);
  note('5', 'logs', logBuf.filter(l => /followup|справка|Followup/i.test(l)).map(l => l.slice(0, 400)));
  return [t1, t2];
}

async function groupC() {
  await clearHistory('C: запись → «я записана?» → перенос → отмена → спасибо');
  // Кейс 6 (а): строка ожидания ответа под ДРУГИМ ключом с номером в форме +7…,
  // гасить её должен вебхук YClients record create на pm2 (closeByPhone).
  const fu6 = await insertFollowup('e2e-live-fu6', '+79200255591', new Date(Date.now() - 60000), null);
  note('6', 'followup_row_inserted', { id: fu6.id, dialog_key: fu6.dialog_key, phone: fu6.phone });
  const anchorBeforeBooking = new Date(Date.now() - 30000);

  const turns = [];
  // Эпиляцию не берём: у владельца мужское имя, и Мила законно отказывает в
  // мужской лазерной эпиляции (правило промпта) — поймано первым прогоном.
  turns.push(await runTurn('8', 'Добрый день! Хотелось бы записаться на чистку лица. Подскажите, пожалуйста, какие есть свободные слоты на 12 октября?'));
  let booked = null;
  for (let i = 0; i < 5 && !booked; i++) {
    const last = lastSent(turns[turns.length - 1]);
    const ts = timesIn(last);
    let reply;
    if (/как\s+(?:к\s+вам\s+)?(?:можно\s+)?обращ|ваше\s+имя|как\s+вас\s+зовут/i.test(last)) reply = 'Зумрудин';
    else if (/для\s+кого|для\s+меня|другому\s+человеку|вам\s+или/i.test(last)) reply = 'Для меня';
    else if (/подтвер|верно\?|всё\s+верно|оформ(ля|и)ть|записыва(ю|ем)\s*\?|записать\s+вас/i.test(last) && i > 0) reply = 'Да, подтверждаю';
    else if (ts.length) reply = `Хорошо запишите 12.10 на ${ts[0].replace(':', '.')}`;
    else reply = 'Да';
    const t = await runTurn(i === 0 ? '9' : '9', reply);
    turns.push(t);
    const cb = calls.find(c => c.turn === t.n && c.name === 'create_booking' && c.result && c.result.created);
    if (cb) booked = cb.result;
  }
  note('9', 'booking', booked ? { record_id: booked.record_id, datetime: booked.datetime || null } : 'запись НЕ создана');

  // Кейс 6: ждём вебхук YClients (pm2) — closeByPhone по +7-форме номера.
  if (booked) {
    let fuAfter = null;
    for (let i = 0; i < 24; i++) {
      fuAfter = await db.one(`SELECT status, close_reason, updated_at FROM agent_followups WHERE id=$1`, [fu6.id]);
      if (fuAfter.status !== 'scheduled') break;
      await sleep(5000);
    }
    note('6', 'closeByPhone_row_after', fuAfter);
    const rec = await db.oneOrNone(
      `SELECT r.id, r.yclients_record_id, r.status, r.created_at FROM records r JOIN clients c ON c.id=r.client_id
        WHERE r.salon_id=$1 AND c.phone LIKE '%9200255591' ORDER BY r.id DESC LIMIT 1`, [SALON]);
    note('6', 'records_row', rec);
    // Кейс 6 (б): bookedSinceAnchor — вторая строка, якорь ДО записи; отправка застаблена.
    const fu6b = await insertFollowup('e2e-live-fu6b', PHONE, anchorBeforeBooking, null);
    const cap = [];
    await followupWorker.processOne(await leaseShape(fu6b), workerDeps(async (p) => { cap.push(p.text); return { id: 'stub' }; }));
    note('6', 'bookedSinceAnchor_row_after', await db.one(`SELECT status, close_reason FROM agent_followups WHERE id=$1`, [fu6b.id]));
    note('6', 'bookedSinceAnchor_stub_sent', cap);
  }

  turns.push(await runTurn('10', 'Добрый день, подскажите, я записана?', { synthetic: true }));

  // Кейс 11: перенос на другое реально свободное время того же мастера/дня.
  let moved = false;
  if (booked) {
    const live = await listFutureRecords();
    const cur = live.find(r => r.id === String(booked.record_id)) || live[0];
    note('11', 'record_before', cur);
    const callIn = calls.find(c => c.name === 'create_booking' && c.result && c.result.created);
    const staffId = callIn && callIn.input.staff_yc_id;
    const svc = callIn && callIn.input.service_yc_id;
    const date = cur && cur.datetime ? cur.datetime.slice(0, 10) : '2026-10-12';
    const curTime = cur && cur.datetime ? cur.datetime.slice(11, 16) : null;
    const probe = await getSlots.run(SALON, { staff_yc_id: staffId, service_yc_id: svc, date }, { nowMs: Date.now() });
    const alt = (probe.slots || []).map(s => s.time).filter(t => t !== curTime);
    const target = alt.find(t => t >= '15:00') || alt[alt.length - 1];
    note('11', 'target', { date, from: curTime, to: target, staffId, svc });
    if (target) {
      let t = await runTurn('11', `Добрый день! Можно перенести чистку на ${target.replace(':', '.')}?`);
      turns.push(t);
      for (let i = 0; i < 3; i++) {
        if (okCall(t, 'reschedule_booking', r => r.rescheduled)) { moved = true; break; }
        t = await runTurn('11', 'Да, переносим');
        turns.push(t);
      }
      if (okCall(t, 'reschedule_booking', r => r.rescheduled)) moved = true;
      note('11', 'records_after', await listFutureRecords());
    }
  }
  note('11', 'moved', moved);

  // Кейс 12: отмена.
  let t = await runTurn('12', 'Отмените запись вообще пожалуйста, я напишу, когда буду готова)');
  turns.push(t);
  for (let i = 0; i < 2 && !okCall(t, 'cancel_booking', r => !r.invalid_args && !r.unverified); i++) {
    t = await runTurn('12', 'Да, отмените');
    turns.push(t);
  }
  note('12', 'records_after', await listFutureRecords());

  // Кейс 18: завершающая вежливость.
  turns.push(await runTurn('18', 'Спасибо!'));
  turns.push(await runTurn('18', 'Спасибо большое!'));
  return turns;
}

async function groupD() {
  await clearHistory('D: две услуги подряд (get_sequential_slots / book_chain)');
  const turns = [];
  let t = await runTurn('13', 'Добрый день! Хотела бы записаться к Татьяне на лазерную эпиляцию подмышек и верхней губы одним визитом. Подскажите, что есть 14 октября?');
  turns.push(t);
  for (let i = 0; i < 4; i++) {
    if (okCall(t, 'book_chain', r => r.booked_all || r.partial)) break;
    const last = lastSent(t);
    const ts = timesIn(last);
    let reply;
    if (/для\s+кого|другому\s+человеку|вам\s+или/i.test(last)) reply = 'Для меня';
    else if (/подтвер|верно\?|всё\s+верно|оформ|записыва(ю|ем)\s*\?/i.test(last) && i > 0) reply = 'Да, подтверждаю';
    else if (ts.length) reply = `Давайте на ${ts[0].replace(':', '.')}`;
    else reply = 'Да';
    t = await runTurn('13', reply);
    turns.push(t);
  }
  note('13', 'records_after', await listFutureRecords());
  return turns;
}

async function groupE() {
  await clearHistory('E: прайс-фото, адрес (КБ), беременность');
  const t1 = await runTurn('14', 'Пришлите, пожалуйста, прайс на биоревитализацию', { synthetic: true });
  const t2 = await runTurn('15', 'Скажите пожалуйста адрес клиники?');
  const t3 = await runTurn('19', 'Беременным нельзя делать?');
  return [t1, t2, t3];
}

async function groupF() {
  await clearHistory('F: осложнение после процедуры');
  note('20', 'seed', await seedSystem('Добрый день! Это PERI CLINIC. Как вы себя чувствуете после биоревитализации? Если появятся вопросы — пишите, мы на связи.'));
  const t = await runTurn('20', 'Немного отеки на глазах.');
  const st = await dialogState();
  note('20', 'dialog_after', st);
  if (st && st.status === 'escalated') await resetEscalation('кейс 20: снять эскалацию после проверки');
  return [t];
}

async function groupG() {
  await clearHistory('G: «+» на акцию');
  note('16', 'seed', await seedSystem('Надежда, здравствуйте! Прошло время с вашей процедуры ботулинотерапии, и мы хотели бы напомнить, что эффект скоро может закончиться. Приглашаем вас на повторный визит, чтобы сохранить результат. Кстати, у нас появился новый косметолог, и в августе действует скидка до 15% на визит к нему — отправьте «+», если интересно. Давайте подберём удобное время для записи? 😊'.replace('Надежда, здравствуйте! ', 'Здравствуйте! ').replace('в августе', 'в октябре')));
  const t = await runTurn('16', '+');
  const st = await dialogState();
  if (st && st.status === 'escalated') { note('16', 'dialog_after', st); await resetEscalation('кейс 16'); }
  return [t];
}

async function groupH() {
  const SURVEY = 'Спасибо что посетили «PERI CLINIC»! Просим Вас оценить обслуживание, отправив в ответ сообщение с цифрой от 2 до 5, где \n2- Вы совершенно недовольны визитом\n3- больше минусов, чем плюсов\n4- были мелкие недочеты, но в целом всё Ок\n5- все отлично';
  await clearHistory('H1: оценка визита «5»');
  note('17a', 'seed', await seedSystem(SURVEY));
  const t1 = await runTurn('17a', '5');
  await clearHistory('H2: оценка визита «2»');
  note('17b', 'seed', await seedSystem(SURVEY));
  const t2 = await runTurn('17b', '2', { synthetic: true });
  const st = await dialogState();
  note('17b', 'dialog_after', st);
  if (st && st.status === 'escalated') await resetEscalation('кейс 17b: снять эскалацию после проверки');
  return [t1, t2];
}

const GROUPS = { A: groupA, B: groupB, C: groupC, D: groupD, E: groupE, F: groupF, G: groupG, H: groupH };

// ══════════════════════ main ══════════════════════
async function main() {
  salonRow = await db.one(`SELECT * FROM salons WHERE id=$1`, [SALON]);
  console.log(`БД=${dbName} провайдер=${config.AGENT_PROVIDER} промпт=${config.AGENT_PROMPT_VERSION} каталог=${config.AGENT_CATALOG_IN_PROMPT} справка=${config.AGENT_SERVICE_FACT_PREFETCH} price-followthrough=${config.AGENT_PRICE_FOLLOWTHROUGH} ${DRY ? '[DRY]' : '[РЕАЛЬНАЯ ОТПРАВКА]'}`);

  if (!DRY) {
    try {
      await axios.get(`${config.CHATPUSH.apiBase}/api/v1/delivery/1`, { headers: { Authorization: `Bearer ${config.CHATPUSH.instanceToken}` }, timeout: 20000, validateStatus: s => s < 500 });
    } catch (e) { console.error(`Chatpush API недоступен (${e.response ? e.response.status : e.message}) — реальная отправка невозможна, отказ`); process.exit(3); }
  }
  // Бэкап реальной истории владельца (dev-БД) — восстановим в finally.
  const backup = {
    messages: await db.any(`SELECT * FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2 ORDER BY id`, [SALON, PHONE]),
    dialog: await db.any(`SELECT * FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]),
  };
  fs.writeFileSync(BACKUP_JSON, JSON.stringify(backup));
  console.log(`бэкап истории: ${backup.messages.length} сообщений, ${backup.dialog.length} строк agent_dialogs → ${BACKUP_JSON}`);
  const recordsBefore = new Set((await listFutureRecords(true)).map(r => r.id));
  console.log(`будущих записей клиента до прогона: ${recordsBefore.size}`);

  try {
    for (const [g, fn] of Object.entries(GROUPS)) {
      if (ONLY.length && !ONLY.includes(g)) continue;
      try { await fn(); }
      catch (e) { console.error(`ГРУППА ${g} упала:`, e); note(g, 'group_error', String(e && e.stack || e).slice(0, 800)); if (sendFailures || stopRequested) break; }
    }
  } finally {
    console.log('\n=== УБОРКА ===');
    // 1. записи YClients
    try {
      const after = await listFutureRecords(true);
      const toDelete = after.filter(r => !recordsBefore.has(r.id));
      const cleanup = [];
      if (KEEP_RECORDS) console.log(`--keep-records: оставлены ${JSON.stringify(toDelete)}`);
      else for (const r of toDelete) { const res = await deleteRecord(r.id); cleanup.push({ ...r, res }); console.log(`  запись ${r.id} ${r.datetime}: ${res}`); }
      const left = (await listFutureRecords(true)).filter(r => !recordsBefore.has(r.id));
      note('cleanup', 'records_deleted', cleanup);
      note('cleanup', 'records_left_new', left);
      note('cleanup', 'created_record_ids_seen', [...createdRecordIds]);
    } catch (e) { console.error('уборка записей упала:', e); note('cleanup', 'records_error', e.message); }
    // 2. строки ожидания скрипта
    try {
      if (scriptFollowupIds.size) await db.query(`DELETE FROM agent_followups WHERE id = ANY($1::int[])`, [[...scriptFollowupIds]]);
      await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
    } catch (e) { console.error('уборка followups:', e.message); }
    // 3. история: подождать эхо, снести тестовую, вернуть исходную
    try {
      if (!DRY) await sleep(30000);
      await clearHistory('финальная уборка');
      const b = JSON.parse(fs.readFileSync(BACKUP_JSON, 'utf8'));
      let restored = 0;
      for (const m of b.messages) {
        const r = await db.query(
          `INSERT INTO chatpush_messages SELECT * FROM jsonb_populate_record(NULL::chatpush_messages, $1::jsonb)
           ON CONFLICT DO NOTHING`, [JSON.stringify(m)]);
        restored += r.rowCount;
      }
      for (const d of b.dialog) {
        await db.query(`INSERT INTO agent_dialogs SELECT * FROM jsonb_populate_record(NULL::agent_dialogs, $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(d)]);
      }
      note('cleanup', 'history_restored', { restored, of: b.messages.length, dialogRows: b.dialog.length });
    } catch (e) { console.error('восстановление истории упало:', e); note('cleanup', 'history_error', e.message); }
    saveJson();
    console.log(`\nрезультаты: ${OUT_JSON}`);
  }
}

// Сигнал: прерываем ТЕКУЩИЙ шаг исключением — finally main() сделает уборку.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.error(`${sig}: прерывание — уборка в finally (бэкап ${BACKUP_JSON})`); stopRequested = true; });
let stopRequested = false;

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); saveJson(); try { await pool.end(); } catch (_) {} process.exit(1); });
