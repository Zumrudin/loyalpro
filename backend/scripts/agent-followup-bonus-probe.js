#!/usr/bin/env node
'use strict';
// Живой пробник бонусного довода в напоминании Милы о себе (спека
// docs/superpowers/specs/2026-09-20-agent-followup-bonus-argument-design.md).
//
// На КАЖДЫЙ сценарий: пациент пишет → Мила отвечает НАСТОЯЩИМ диспетчером
// (реальный LLM, реальные инструменты чтения; write-инструменты застаблены —
// ни одной записи в YClients) → диспетчер сам заводит строку ожидания ответа →
// строка сдвигается на «пора» → ОДИН тик настоящего followup-воркера (реальный
// LLM пишет напоминание, код дописывает бонусную фразу) → печатается всё.
//
//   node scripts/agent-followup-bonus-probe.js [--only N] [--allow-worker-running]
//
// НИЧЕГО НЕ ОТПРАВЛЯЕТ: send диспетчера и sendMessage воркера застаблены.
// Настройки салона (enabled/mode/интервалы/бонусные шаблоны) меняются на время
// прогона и восстанавливаются в finally. История тестовых номеров чистится ДО
// и ПОСЛЕ каждого сценария. ВНИМАНИЕ: платный LLM (~3–5 ₽ на сценарий).
//
// Как и agent-followup-e2e.js, отказывается работать при online pm2 «loyalpro»:
// боевой followup-воркер тикает раз в минуту и может арендовать строку первым.

const { execFileSync } = require('child_process');
const { db, pool } = require('../db');
const config = require('../config');
const agentSettings = require('../services/agent-settings');
const dispatcher = require('../services/agent/dispatcher');
const orchestrator = require('../services/agent/orchestrator');
const providers = require('../services/agent/providers');
const registry = require('../services/agent/tools');
const worker = require('../services/agent/followup-worker');

const SALON = 1;
const CHANNEL = 'whatsapp';
const CARD_PHONE = '79200255591';   // тестовый клиент с картой лояльности
const NO_CARD_PHONE = '79990000001'; // номера нет ни в нашей БД, ни в YClients

const WRITE_TOOLS = new Set(['create_booking', 'book_chain', 'reschedule_booking', 'cancel_booking', 'modify_booking_services']);

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? Number(argv[onlyIdx + 1]) : null;
const ALLOW_WORKER_RUNNING = argv.includes('--allow-worker-running');

const BONUS_TEXT = 'Кстати, на вашей бонусной карте {balance} бонусов — ими можно оплатить часть визита 🤍';
const WELCOME_TEXT = 'Кстати, при регистрации в нашей программе лояльности дарим 500 приветственных баллов — регистрация в Telegram-боте или по QR на сайте.';

const SCENARIOS = [
  { n: 1, phone: CARD_PHONE, expect: 'balance', label: 'вопрос о цене (класс price, держатель карты)',
    text: 'Здравствуйте! Подскажите, сколько стоит комбинированная чистка лица?' },
  { n: 2, phone: CARD_PHONE, expect: 'balance', label: 'просьба о времени (класс choice, держатель карты)',
    // Не лазерная эпиляция: тестовый клиент — мужчина (Зумрудин), Мила законно
    // отказывает, и напоминание на отказе молчит (llm_skip) — довод не при чём.
    text: 'Добрый день! Хочу записаться на комбинированную чистку лица. Есть что-нибудь на завтра вечером?' },
  { n: 3, phone: CARD_PHONE, expect: 'none', label: 'справка по уходу (класс unknown — довода быть НЕ должно)',
    text: 'Здравствуйте, подскажите, как ухаживать за кожей после чистки лица?' },
  { n: 4, phone: CARD_PHONE, expect: 'none', label: 'перенос записи (класс modify — довода быть НЕ должно)',
    text: 'Здравствуйте! Хочу перенести свою запись на другой день, подскажите, когда можно?' },
  { n: 5, phone: NO_CARD_PHONE, expect: 'welcome', label: 'вопрос о цене от номера без карты (welcome)',
    text: 'Здравствуйте! Сколько стоит биоревитализация?' },
];

function pm2Online(name) {
  try {
    const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000 }));
    const p = (list || []).find((x) => x && x.name === name);
    return !!(p && p.pm2_env && p.pm2_env.status === 'online');
  } catch (e) { return false; }
}

const calls = [];
function wrapRegistry() {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      if (WRITE_TOOLS.has(name)) {
        calls.push({ name, stubbed: true });
        return { invalid_args: true, error: 'ПРОБНИК: изменения записей не выполняются — попроси пациента подтвердить время и сообщи, что оформит администратор.' };
      }
      const result = await fn(salonId, input, ctx);
      calls.push({ name, input });
      return result;
    };
  }
  return { schemas: base.schemas, handlers };
}

async function insertMsg(phone, direction, text) {
  const ts = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, chat_id, msg_ts, authored_by)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9,$10)
     ON CONFLICT (salon_id, external_message_id) DO NOTHING`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `probe:${direction}:${ts}:${Math.floor(Math.random() * 1e6)}`, text, phone, `probe-${phone}`, ts,
     direction === 'outgoing' ? 'agent' : null]);
}

async function clearHistory(phone) {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
}

const state = { settingsBefore: undefined };

async function setSettings() {
  const before = await db.oneOrNone(
    `SELECT enabled, mode, followup_delay1_min, followup_delay2_min, followup_bonus_text, followup_welcome_text
       FROM agent_settings WHERE salon_id=$1`, [SALON]);
  state.settingsBefore = before || null;
  await db.query(
    `INSERT INTO agent_settings (salon_id, enabled, mode, followup_delay1_min, followup_delay2_min,
                                 followup_bonus_text, followup_welcome_text, updated_at)
     VALUES ($1, TRUE, 'all', 15, 60, $2, $3, now())
     ON CONFLICT (salon_id) DO UPDATE
       SET enabled=TRUE, mode='all', followup_delay1_min=15, followup_delay2_min=60,
           followup_bonus_text=$2, followup_welcome_text=$3, updated_at=now()`,
    [SALON, BONUS_TEXT, WELCOME_TEXT]);
}

async function restoreSettings() {
  if (state.settingsBefore === undefined) return;
  if (state.settingsBefore === null) {
    await db.query(`DELETE FROM agent_settings WHERE salon_id=$1`, [SALON]);
    return;
  }
  const b = state.settingsBefore;
  await db.query(
    `UPDATE agent_settings
        SET enabled=$2, mode=$3, followup_delay1_min=$4, followup_delay2_min=$5,
            followup_bonus_text=$6, followup_welcome_text=$7, updated_at=now()
      WHERE salon_id=$1`,
    [SALON, b.enabled, b.mode, b.followup_delay1_min, b.followup_delay2_min,
     b.followup_bonus_text, b.followup_welcome_text]);
}

async function runScenario(s) {
  console.log(`\n${'═'.repeat(78)}\n=== СЦЕНАРИЙ ${s.n}: ${s.label}\n=== ожидание: ${s.expect}\n${'═'.repeat(78)}`);
  await clearHistory(s.phone);
  calls.length = 0;
  await insertMsg(s.phone, 'incoming', s.text);
  console.log(`\n👤 Пациент (${s.phone}): ${s.text}`);

  const replies = [];
  await dispatcher.process(SALON, s.phone, { phone: s.phone, channel: CHANNEL, chatId: `probe-${s.phone}`, text: s.text }, {
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
  console.log(`   инструменты хода: ${calls.length ? calls.map((c) => c.name + (c.stubbed ? '(stub)' : '')).join(' → ') : '(нет)'}`);
  for (const t of replies) { console.log(`\n🤖 Мила: ${t.replace(/\n/g, '\n         ')}`); await insertMsg(s.phone, 'outgoing', t); }
  if (!replies.length) console.log('\n🤖 Мила: (реплик нет — ход ушёл на администратора?)');
  // followupQueue.schedule и markDelivered — fire-and-forget после возврата process().
  await new Promise((r) => setTimeout(r, 2500));

  const row = await db.oneOrNone(
    `SELECT id, stage, status, anchor_turn_id FROM agent_followups
      WHERE salon_id=$1 AND dialog_key=$2 AND status='scheduled'`, [SALON, s.phone]);
  if (!row) {
    const any = await db.oneOrNone(`SELECT status, close_reason FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2 ORDER BY id DESC LIMIT 1`, [SALON, s.phone]);
    console.log(`\n⏳ Строка ожидания НЕ заведена (${any ? `${any.status}/${any.close_reason}` : 'строк нет'}) — ход не ждёт ответа (запись/эскалация/молчание).`);
    return { ...s, replies, nudge: null, bonus: 'no_row' };
  }
  console.log(`\n⏳ Строка ожидания #${row.id} заведена (anchor_turn_id=${row.anchor_turn_id || 'null'}). Сдвигаю «на 15 минут вперёд»…`);
  await db.query(`UPDATE agent_followups SET next_at = now() - interval '1 minute' WHERE id=$1`, [row.id]);

  const nudges = [];
  const logLines = [];
  const log = {
    info: (m) => { if (/бонусный довод/.test(m)) logLines.push(m.replace(/^followup #\d+: /, '')); },
    warn: (m) => logLines.push('WARN ' + m), error: (m) => logLines.push('ERROR ' + m),
  };
  await worker.processTick({
    sendMessage: async (p) => { nudges.push(p.text); return { id: 'stub', channel: CHANNEL }; },
    rememberPending: async () => {}, persistWhatsapp: async () => {}, log,
  });
  const after = await db.oneOrNone(`SELECT status, close_reason, bonus_kind, bonus_balance FROM agent_followups WHERE id=$1`, [row.id]);
  if (nudges.length) console.log(`\n🔔 Напоминание через 15 мин:\n   ${nudges[0].replace(/\n/g, '\n   ')}`);
  else console.log(`\n🔔 Напоминание НЕ отправлено: ${after.status}/${after.close_reason}`);
  console.log(`   ${logLines.join('\n   ') || '(лога бонусного довода нет)'}`);
  console.log(`   журнал строки: bonus_kind=${after.bonus_kind} bonus_balance=${after.bonus_balance}`);
  const got = after.bonus_kind || 'none';
  const ok = nudges.length ? got === s.expect : s.expect === 'none';
  console.log(`   ИТОГ: ${ok ? '✅' : '❌'} ожидали ${s.expect}, получили ${nudges.length ? got : 'напоминания нет'}`);
  return { ...s, replies, nudge: nudges[0] || null, bonus: got, ok };
}

async function main() {
  if (!ALLOW_WORKER_RUNNING && pm2Online('loyalpro')) {
    console.error('ОТКАЗ: pm2-процесс «loyalpro» online — его followup-воркер может арендовать строку первым.\n  pm2 stop loyalpro && node scripts/agent-followup-bonus-probe.js && PORT=3001 pm2 start loyalpro');
    process.exit(1);
  }
  await setSettings();
  const results = [];
  try {
    for (const s of SCENARIOS) {
      if (ONLY != null && s.n !== ONLY) continue;
      try { results.push(await runScenario(s)); }
      catch (e) { console.error(`сценарий ${s.n} упал: ${e.stack || e.message}`); results.push({ ...s, ok: false, bonus: 'error' }); }
      finally { await clearHistory(s.phone); }
    }
  } finally {
    await restoreSettings();
    console.log('\nнастройки салона восстановлены, история тестовых номеров очищена');
  }
  console.log(`\n${'═'.repeat(78)}\nСВОДКА`);
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} #${r.n} ${r.label}: ожидали ${r.expect}, получили ${r.bonus}`);
  await pool.end();
  process.exit(results.every((r) => r.ok) ? 0 : 2);
}

main().catch(async (e) => {
  console.error(e);
  try { await restoreSettings(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
