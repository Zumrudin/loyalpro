#!/usr/bin/env node
'use strict';
// ============================================================
// Живая проверка ответов пациентов на уведомления (Task 11, шаг 2 плана
// docs/superpowers/plans/2026-10-13-yclients-notifications-own-module.md).
//
//   node scripts/notifications-replies-e2e.js [--allow-worker-running] [--synthetic] [--staff <yc_id>] [--service <yc_id>]
//
// ЧТО ДЕЛАЕТ. Создаёт в YClients будущую запись тестового клиента (79200255591), задаёт ей ИНДИВИДУАЛЬНУЮ цену и
// скидку (иначе проверка «цена не изменилась» ничего не доказывает: у свежей записи цена и так каталожная), кладёт
// в БД «ушедшее» напоминание и его эхо в переписку и прогоняет НАСТОЯЩИЙ replies.handleIncoming:
//   • «Подтверждаю» → handled/confirmed; в YClients attendance = 2; confirmed_at у задания; отбивка ушла в заглушку;
//   • ГЛАВНАЯ ПРОВЕРКА: цена и скидка услуг, имя клиента, мастер, время, длительность записи после подтверждения
//     не изменились (confirmBookingRecord шлёт PUT с services:[{id}] — YClients мог бы сбросить цену). Явный вердикт
//     «PRICE_PRESERVED: yes|no» с таблицей до/после; при «no» скрипт НИЧЕГО не чинит, только показывает дифф;
//   • повторное «Подтверждаю» → duplicate (ни отбивки, ни Милы);
//   • опрос + «5» → строка visit_ratings, отбивка rating_high_text, без перевода на администратора; повтор → duplicate;
//   • опрос + «3» → строка visit_ratings, отбивка rating_low_text, перевод на администратора (reason low_rating);
//   • контроль: цифра после напоминания и «Подтверждаю» после опроса НЕ перехватываются (ход уходит Миле).
//
// БЕЗОПАСНОСТЬ (дев получает НАСТОЯЩИЕ вебхуки клиники и держит боевые аккаунты мессенджеров):
//  • режим салона читается из БД на старте; не 'off' (строки нет — тоже off) → отказ. notification_settings НЕ
//    пишется: режим 'live' подменяется только в процессе (monkeypatch settings.getSettings); SQL-ловушка на
//    pool.query не пропускает запись в notification_settings и таблицы Милы/«Заботы»;
//  • транспорт подменён в процессе, флага --send НЕТ; нижний слой chatpush.* — ловушка, бросающая при любой
//    попытке отправки мимо заглушки; журнал авторства (outgoing_authored) заглушён;
//  • эскалация подменена (запись аргументов), dialogState.getOrCreate тоже: реальные agent_dialogs/agent_events/
//    care_enrollments тестового номера не трогаются;
//  • переписка-фикстура лежит под ключом диалога '+79200255591' (сырая форма номера), а НЕ '79200255591': под
//    последним живёт настоящий рабочий диалог владельца, и его реплики администратора в окне часа молча
//    превратили бы «Подтверждаю» в ход Миле (live-dialog-проверка replies.js) — прогон оказался бы флаки;
//  • записи YClients — только тестового клиента, только созданная этим скриптом, удаляется в finally;
//  • dev pm2 `loyalpro` должен быть ОСТАНОВЛЕН (отказ без --allow-worker-running).
//
// --synthetic — без YClients (подменены ycGetRecord/ycUpdateRecord, запись живёт в памяти), для отладки скрипта;
//   --fake-reset-prices (только с --synthetic) имитирует YClients, который сбрасывает цену при PUT без цен: нужен,
//   чтобы увидеть, как выглядит вердикт «no».
// Всё вставленное (задания, visit_ratings, строки переписки, состояние записи) удаляется в finally по id.
// ============================================================
const { assertWorkerStopped } = require('./notifications-e2e-worker-guard');
const axios = require('axios');
const { db, pool } = require('../db');
const config = require('../config');

// ── аргументы ────────────────────────────────────────────────
const KNOWN_FLAGS = new Set(['--synthetic', '--allow-worker-running', '--staff', '--service', '--fake-reset-prices']);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  if (!KNOWN_FLAGS.has(argv[i])) {
    console.error(`Неизвестный флаг ${argv[i]}. Реальной отправки у скрипта нет и не будет (флага --send не существует).`);
    process.exit(2);
  }
  if (argv[i] === '--staff' || argv[i] === '--service') i += 1;
}
const flag = (n) => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SYNTHETIC = flag('--synthetic');
const ALLOW_WORKER_RUNNING = flag('--allow-worker-running');
const FAKE_RESET_PRICES = flag('--fake-reset-prices');
if (FAKE_RESET_PRICES && !SYNTHETIC) { console.error('--fake-reset-prices имеет смысл только вместе с --synthetic'); process.exit(2); }

const SALON = 1;
const PHONE = '79200255591';             // канон
const RAW_PHONE = '+79200255591';        // форма, в которой номер приходит из мессенджера; ключ диалога-фикстуры
const CLIENT_YC_ID = 134014107;
const STAFF = Number(val('--staff', 3356928));        // Богатырева Татьяна
const SERVICE = Number(val('--service', 9536744));    // малая зона
const COMMENT = 'E2E ответов на уведомления (тестовая запись, удалить)';
const PM2_NAME = 'loyalpro';
const RUN = Date.now().toString(36);

// ── страховка: боевой процесс дева ───────────────────────────
function guardAgainstLiveWorker() {
  if (ALLOW_WORKER_RUNNING) {
    console.warn('⚠️  --allow-worker-running: проверка pm2-процесса дева ОБОЙДЕНА осознанно.');
    return;
  }
  assertWorkerStopped(PM2_NAME);
}

// ── ловушки: запись в БД и отправка мимо заглушек ────────────
const violations = [];
const FORBIDDEN_WRITE_RE = new RegExp('\\b(?:insert\\s+into|update|delete\\s+from|truncate(?:\\s+table)?|alter\\s+table|drop\\s+table)\\s+(?:only\\s+)?(?:public\\.)?'
  + '(notification_settings|agent_dialogs|agent_events|agent_tool_events|agent_followups|care_enrollments|care_touch_sends|outgoing_authored)\\b', 'i');
const origPoolQuery = pool.query.bind(pool);
pool.query = (sql, params) => {
  const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
  const m = FORBIDDEN_WRITE_RE.exec(text);
  if (m) {
    violations.push(`${m[0].replace(/\s+/g, ' ')}`);
    return Promise.reject(new Error(`e2e: запись в ${m[1]} запрещена`));
  }
  return origPoolQuery(sql, params);
};

const settingsSvc = require('../services/notifications/settings');
const transport = require('../services/messaging/transport');
const chatpush = require('../services/chatpush');
const authorship = require('../services/outgoing-authorship');
const dialogState = require('../services/agent/dialog-state');
const escalateTool = require('../services/agent/tools/escalate-to-operator');
const { withRateLimitRetry } = require('../services/yclients-retry');
const { normalizePhoneKey } = require('../services/agent-gate');

const realSendAttempts = [];
for (const fn of ['sendMessage', 'sendFile', 'getDeliveryStatus']) {
  if (typeof chatpush[fn] === 'function') {
    chatpush[fn] = () => { realSendAttempts.push(fn); throw new Error(`e2e: попытка реального chatpush.${fn} мимо заглушки транспорта`); };
  }
}

// Настройки — только в процессе: режим live, тексты отбивок — дефолты салона, эскалация по низкой оценке включена.
const cfg = Object.freeze({ ...settingsSvc.DEFAULTS, salon_id: SALON, mode: 'live', quiet_from: null, quiet_to: null, prefer_last_channel: false,
  default_channels: Object.freeze(['tdlib', 'max']), rating_escalate_low: true });
settingsSvc.getSettings = async () => cfg;
settingsSvc.updateSettings = async () => { throw new Error('e2e: запись notification_settings запрещена'); };

const sent = [];
let deliverySeq = 0;
transport.sendMessage = async (salonId, payload) => {
  sent.push({ salonId, ch: (payload.dispatchRouting || [])[0], payload });
  deliverySeq += 1;
  return { id: `e2e-stub-${deliverySeq}`, accountId: 'e2e-stub', channels: payload.dispatchRouting };
};
transport.sendFile = async (salonId, payload) => { sent.push({ salonId, ch: (payload.dispatchRouting || [])[0], payload, file: true }); deliverySeq += 1; return { id: `e2e-stub-${deliverySeq}`, accountId: 'e2e-stub' }; };
transport.getDeliveryStatus = async () => ({ status: { status_id: 3, description: 'Доставлено (e2e-заглушка)' } });
authorship.remember = async () => {};

// Эскалация: запись аргументов вместо UPDATE agent_dialogs/INSERT agent_events/SSE.
const escalateCalls = [];
const getOrCreateCalls = [];
escalateTool.run = async (salonId, input, ctx) => { escalateCalls.push({ salonId, input, ctx }); return { escalated: true, reason: input && input.reason }; };
dialogState.getOrCreate = async (salonId, key) => { getOrCreateCalls.push({ salonId, key }); return { id: 0, status: 'bot', escalated_reason: null }; };

// ── YClients: настоящий или выдуманный (до загрузки replies/booking-modify: они берут функции деструктуризацией) ──
const clone = (o) => JSON.parse(JSON.stringify(o));
const CATALOG_PRICE = 1000;
const fakeYc = {
  recs: new Map(),
  get(id) {
    const r = this.recs.get(Number(id));
    if (!r) throw new Error('Запись не найдена');
    return clone(r);
  },
  put(id, body) {
    const r = this.recs.get(Number(id));
    if (!r) throw new Error('Запись не найдена');
    if (body.staff_id != null) { r.staff_id = body.staff_id; r.staff = { ...r.staff, id: body.staff_id }; }
    if (body.datetime) r.datetime = body.datetime;
    if (body.seance_length != null) { r.seance_length = body.seance_length; r.length = body.seance_length; }
    if (body.client) r.client = { ...r.client, ...body.client };
    if ('attendance' in body) { r.attendance = body.attendance; r.confirmed = body.attendance === 2 ? 1 : 0; }
    if ('comment' in body) r.comment = body.comment;
    if (Array.isArray(body.services)) {
      r.services = body.services.map((s) => {
        const old = r.services.find((o) => Number(o.id) === Number(s.id)) || { id: s.id, title: 'Малая зона (синтетика)' };
        const priced = s.first_cost != null || s.discount != null || s.cost != null;
        if (priced) {
          const first = Number(s.first_cost != null ? s.first_cost : (s.cost != null ? s.cost : old.first_cost));
          const discount = Number(s.discount || 0);
          const cost = Number(s.cost != null ? s.cost : Math.round(first * (100 - discount) / 100));
          return { ...old, first_cost: first, discount, cost, cost_to_pay: cost, manual_cost: cost, cost_per_unit: cost, amount: 1 };
        }
        if (FAKE_RESET_PRICES || !old.cost) {   // «плохой» YClients: цены не присланы → сброс на каталог
          return { ...old, first_cost: CATALOG_PRICE, discount: 0, cost: CATALOG_PRICE, cost_to_pay: CATALOG_PRICE, manual_cost: CATALOG_PRICE, cost_per_unit: CATALOG_PRICE, amount: 1 };
        }
        return old;
      });
    }
    return {};
  },
};
if (SYNTHETIC) {
  const yr = require('../services/yclients-records');
  yr.ycGetRecord = async (_salon, id) => fakeYc.get(id);
  yr.ycUpdateRecord = async (_salon, id, body) => fakeYc.put(id, body);
}

const enroll = require('../services/notifications/enroll');
const replies = require('../services/notifications/replies');       // ПОСЛЕ подмены yclients-records (см. выше)
const { lastConversation } = require('../services/notifications/rules');

// ── вывод ────────────────────────────────────────────────────
let nPass = 0;
let nFail = 0;
let nWarn = 0;
// Предупреждение — не провал проверяемого кода: среда (YClients) не дала сделать проверку сильной.
function warn(name, detail) {
  nWarn += 1;
  console.log(`  WARN  ${name}${detail ? `  ← ${detail}` : ''}`);
}
function check(name, cond, detail) {
  const ok = !!cond;
  if (ok) nPass += 1; else nFail += 1;
  const tail = detail != null && detail !== '' ? (ok ? `  (${detail})` : `  ← ${detail}`) : '';
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${tail}`);
  return ok;
}
const section = (t) => console.log(`\n── ${t} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function msk(ms) {
  const iso = new Date(ms + 3 * 3600 * 1000).toISOString();
  return { date: `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`, time: iso.slice(11, 16), ymd: iso.slice(0, 10) };
}

// ── состояние прогона ────────────────────────────────────────
let salon = null;
const recordIds = [];            // записи YClients (в --synthetic — выдуманные)
const fakeRecordIds = [];        // выдуманные id для оценок: в YClients их нет
const jobIds = [];
const msgIds = [];
let msgSeq = 0;

const authSalonFor = (s) => (config.YCLIENTS_INTEGRATION_USER_TOKEN ? { ...s, yclients_user_token: config.YCLIENTS_INTEGRATION_USER_TOKEN } : s);
const assertOwned = (id) => { if (!recordIds.includes(Number(id))) throw new Error(`e2e: запись ${id} создана не этим прогоном — трогать нельзя`); };

function liveOps() {
  const { ycCreateRecord } = require('../services/yclients-booking');
  const { ycGetRecord, ycUpdateRecord } = require('../services/yclients-records');
  const { ycHeaders } = require('../services/yclients');
  const getSlots = require('../services/agent/tools/get-available-slots');
  const fetch = (id) => withRateLimitRetry(() => ycGetRecord(salon, id));
  return {
    name: 'YClients (боевой)', live: true,
    fetch,
    async pickSlot() {
      const now = Date.now();
      for (let i = 2; i <= 16; i++) {
        const ymd = msk(now + i * 86400000).ymd;
        const r = await getSlots.run(SALON, { staff_yc_id: STAFF, service_yc_id: SERVICE, date: ymd }, { nowMs: now });
        const slot = (r.slots || []).find((s) => s.time >= '11:00' && s.time <= '19:30');
        if (slot) return { ymd, time: slot.time, datetime: slot.datetime || `${ymd}T${slot.time}:00+03:00`, seance_length: slot.seance_length || 300 };
      }
      throw new Error(`нет свободных дневных слотов у мастера ${STAFF} на услугу ${SERVICE} в ближайшие 2 недели`);
    },
    async create(slot) {
      const created = await withRateLimitRetry(() => ycCreateRecord(salon, {
        staffYcId: STAFF, serviceYcIds: [SERVICE], datetime: slot.datetime, seanceLength: slot.seance_length,
        clientPhone: PHONE, clientName: 'Зумрудин', comment: COMMENT,
      }));
      const id = Number(created && created.id);
      if (!id) throw new Error(`YClients не вернул id записи: ${JSON.stringify(created)}`);
      recordIds.push(id);
      await sleep(700);
      const rec = await fetch(id);
      if (Number(rec.client && rec.client.id) !== CLIENT_YC_ID || normalizePhoneKey(rec.client && rec.client.phone) !== PHONE) {
        throw new Error(`запись ${id} оказалась у другого клиента: ${JSON.stringify(rec.client)} — прерываю (запись будет удалена)`);
      }
      return rec;
    },
    async put(rec, over) {
      assertOwned(rec.id);
      const body = {
        staff_id: rec.staff_id, services: (rec.services || []).map((s) => ({ id: s.id })),
        client: { id: rec.client.id, phone: rec.client.phone, name: rec.client.name || '' },
        datetime: rec.datetime, seance_length: rec.seance_length, comment: rec.comment || '', ...over,
      };
      await withRateLimitRetry(() => ycUpdateRecord(authSalonFor(salon), rec.id, body));
      await sleep(700);
      return fetch(rec.id);
    },
    async remove(id) {
      assertOwned(id);
      const url = `${config.YC}/record/${salon.yclients_company_id}/${id}`;
      try {
        await withRateLimitRetry(() => axios.delete(url, { headers: ycHeaders(salon), timeout: 15000 }));
      } catch (e1) {
        await withRateLimitRetry(() => axios.delete(url, { headers: ycHeaders(authSalonFor(salon)), timeout: 15000 }));
      }
      await sleep(700);
    },
    async isGone(id) {
      try { const r = await fetch(id); return r.deleted === true; } catch (e) { return /404|не найден/i.test(String(e.message) + String(e.status)); }
    },
    async emergencyCancel(rec) { try { await this.put(rec, { attendance: -1 }); return true; } catch (e) { return false; } },
  };
}

function syntheticOps() {
  return {
    name: 'синтетика (YClients не трогаем)', live: false,
    fetch: async (id) => fakeYc.get(id),
    async pickSlot() {
      const ymd = msk(Date.now() + 3 * 86400000).ymd;
      return { ymd, time: '12:00', datetime: `${ymd}T12:00:00+03:00`, seance_length: 300 };
    },
    async create(slot) {
      const id = 9000000000 + (Date.now() % 100000000) * 10 + 1;
      const rec = {
        id, datetime: slot.datetime, date: `${slot.ymd} ${slot.time}:00`, seance_length: slot.seance_length, length: slot.seance_length,
        attendance: 0, confirmed: 0, deleted: false, prepaid: false, sms_before: 0, staff_id: STAFF, staff: { id: STAFF, name: 'Богатырева Татьяна' },
        services: [{ id: SERVICE, title: 'Малая зона (синтетика)', cost: CATALOG_PRICE, first_cost: CATALOG_PRICE, discount: 0, amount: 1,
          cost_to_pay: CATALOG_PRICE, manual_cost: CATALOG_PRICE, cost_per_unit: CATALOG_PRICE }],
        client: { id: CLIENT_YC_ID, name: 'Зумрудин', display_name: 'Зумрудин', surname: '', patronymic: '', phone: '+79200255591' },
        comment: COMMENT, short_link: 'https://example.invalid/r',
      };
      fakeYc.recs.set(id, rec);
      recordIds.push(id);
      return clone(rec);
    },
    async put(rec, over) {
      assertOwned(rec.id);
      fakeYc.put(rec.id, over);
      return fakeYc.get(rec.id);
    },
    async remove(id) { assertOwned(id); fakeYc.recs.get(Number(id)).deleted = true; },
    async isGone(id) { const r = fakeYc.recs.get(Number(id)); return !r || r.deleted === true; },
    async emergencyCancel() { return true; },
  };
}

// ── фикстуры в БД ────────────────────────────────────────────
// «Ушедшее» уведомление: sent-задание (рендеренный текст = текст в переписке) и его эхо — исходящее system.
async function insertSentJob({ type, recordId, visitMs, text, ask, sentAgoSec, clientId }) {
  const n = jobIds.length + 1;
  const r = await db.oneOrNone(
    `INSERT INTO notification_jobs
       (salon_id, rule_id, rule_title, trigger_type, yclients_record_id, visit_datetime, client_id, phone, scheduled_at, status, rendered_text, meta,
        sent_at, channel_used, delivery_id, cascade_log)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, now() - make_interval(secs => $8::int + 5), 'sent', $9, $10::jsonb,
             now() - make_interval(secs => $8::int), 'tdlib', $11, '[]'::jsonb)
     RETURNING id`,
    [SALON, `E2E-ответы ${RUN}`, type, recordId, visitMs != null ? new Date(visitMs) : null, clientId || null, PHONE, sentAgoSec, text,
      JSON.stringify({ askConfirmation: !!ask, e2e: RUN }), `e2e-delivery-${RUN}-${n}`]);
  const id = Number(r.id);
  jobIds.push(id);
  return id;
}
async function insertOutgoing(text, agoSec, chatId) {
  msgSeq += 1;
  const ts = Math.floor(Date.now() / 1000) - agoSec;
  const r = await db.oneOrNone(
    `INSERT INTO chatpush_messages (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, chat_id, msg_ts, authored_by)
     VALUES ($1,$2,'tdlib','outgoing',$3,'text',$4,$5,$6,$7,'system') RETURNING id`,
    [SALON, config.CHATPUSH.customerId || null, `e2e-notify:${RUN}:${msgSeq}`, text, RAW_PHONE, chatId, ts]);
  msgIds.push(Number(r.id));
}

// ── сравнение записи до/после ────────────────────────────────
const PRICE_KEYS = ['cost', 'discount', 'amount', 'first_cost', 'cost_to_pay', 'manual_cost', 'cost_per_unit'];
const EXPECTED_CHANGE = new Set(['attendance', 'confirmed', 'last_change_date', 'visit_attendance']);
const fmtV = (v) => (v === undefined ? '∅' : JSON.stringify(v));

function priceDiff(before, after) {
  const rows = [];
  const bs = before.services || [];
  const as = after.services || [];
  if (bs.length !== as.length || bs.some((s, i) => Number(s.id) !== Number(as[i] && as[i].id))) {
    rows.push({ what: 'состав услуг', before: bs.map((s) => s.id).join(','), after: as.map((s) => s.id).join(','), same: false });
  }
  for (const s of bs) {
    const a = as.find((x) => Number(x.id) === Number(s.id)) || {};
    for (const k of PRICE_KEYS) {
      if (!(k in s) && !(k in a)) continue;
      rows.push({ what: `услуга ${s.id} «${String(s.title || '').slice(0, 40)}»: ${k}`, before: s[k], after: a[k], same: Number(s[k]) === Number(a[k]) });
    }
  }
  return rows;
}
const CORE_FIELDS = {
  'клиент.id': (r) => r.client && r.client.id,
  'клиент.имя (name)': (r) => r.client && r.client.name,
  'клиент.display_name': (r) => r.client && r.client.display_name,
  'клиент.фамилия': (r) => r.client && r.client.surname,
  'клиент.отчество': (r) => r.client && r.client.patronymic,
  'клиент.телефон': (r) => normalizePhoneKey(r.client && r.client.phone),
  'мастер.id': (r) => (r.staff && r.staff.id) != null ? r.staff.id : r.staff_id,
  'мастер.имя': (r) => r.staff && r.staff.name,
  'время (datetime)': (r) => Date.parse(r.datetime),
  'длительность (seance_length)': (r) => Number(r.seance_length),
  'длительность (length)': (r) => (r.length == null ? undefined : Number(r.length)),
  'комментарий': (r) => r.comment || '',
  'названия услуг': (r) => (r.services || []).map((s) => s.title).join('|'),
  'предоплата (prepaid)': (r) => r.prepaid,
  'sms_before': (r) => r.sms_before,
};
function coreDiff(before, after) {
  return Object.entries(CORE_FIELDS).map(([what, f]) => {
    const b = f(before);
    const a = f(after);
    return { what, before: b, after: a, same: JSON.stringify(b) === JSON.stringify(a) };
  });
}
function deepDiff(a, b, path = '', out = []) {
  if (a === b) return out;
  const isObj = (x) => x && typeof x === 'object';
  if (!isObj(a) || !isObj(b)) {
    if (!(typeof a === 'number' && typeof b === 'number' && a === b) && JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, before: a, after: b });
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) deepDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
  return out;
}

// ── сценарий ─────────────────────────────────────────────────
async function scenario(ops) {
  // 0. Чат тестового номера: реальный tdlib id (чтение), иначе любой.
  const conv = await lastConversation(SALON, PHONE).catch(() => null);
  const CHAT_ID = (conv && conv.chats && conv.chats.tdlib) || 'e2e-chat';
  const client = await db.oneOrNone('SELECT id FROM clients WHERE salon_id = $1 AND yclients_client_id = $2', [SALON, CLIENT_YC_ID]);
  const clientId = client ? client.id : null;
  console.log(`tdlib-чат тестового номера: ${CHAT_ID}; клиент в БД: #${clientId}; ключ диалога-фикстуры: ${RAW_PHONE}`);
  const msgSeqNo = { n: 0 };
  const incoming = (text) => ({ direction: 'incoming', channel: 'tdlib', phone: RAW_PHONE, chatId: CHAT_ID, chatType: 'person', type: 'text', text, messageId: `e2e-${RUN}-${++msgSeqNo.n}` });
  const handle = async (text) => {
    const m = incoming(text);
    const before = sent.length;
    const res = await replies.handleIncoming(SALON, m);
    return { m, res, calls: sent.slice(before) };
  };

  // 1. Будущая запись.
  section('запись: будущая, с индивидуальной ценой и скидкой');
  const slot = await ops.pickSlot();
  let rec = await ops.create(slot);
  console.log(`запись #${rec.id}: ${rec.datetime}, ${(rec.staff && rec.staff.name) || ''}; услуги: ${(rec.services || []).map((s) => `${s.id} «${s.title}» cost=${s.cost} first_cost=${s.first_cost} discount=${s.discount}`).join('; ')}`);
  check('запись создана у тестового клиента, визит в будущем', Number(rec.client.id) === CLIENT_YC_ID && Date.parse(rec.datetime) > Date.now() + 3600 * 1000, rec.datetime);

  // 2. Индивидуальная цена/скидка: без неё PRICE_PRESERVED ничего не доказывает.
  let hardened = false;
  const s0 = rec.services[0];
  const first = Number(s0.first_cost != null ? s0.first_cost : s0.cost);
  const DISCOUNT = 10;
  if (first >= 100) {
    const wantCost = Math.round(first * (100 - DISCOUNT) / 100);
    try {
      rec = await ops.put(rec, { services: rec.services.map((x, i) => (i === 0 ? { id: x.id, first_cost: first, discount: DISCOUNT, cost: wantCost } : { id: x.id })) });
      const u = rec.services[0];
      hardened = PRICE_KEYS.some((k) => Number(u[k]) !== Number(s0[k]));      // хоть что-то из цены/скидки отличается от каталожного
      console.log(`после PUT с ценой: cost=${u.cost} first_cost=${u.first_cost} discount=${u.discount} manual_cost=${u.manual_cost} cost_to_pay=${u.cost_to_pay} (были cost=${s0.cost} discount=${s0.discount})`);
      if (!hardened) console.log(`⚠️  YClients не принял индивидуальную цену/скидку (хотели cost=${wantCost}, discount=${DISCOUNT}) — проверка цены будет СЛАБОЙ (цена каталожная).`);
    } catch (e) {
      console.log(`⚠️  PUT с индивидуальной ценой отклонён YClients: ${e.message} — проверка цены будет СЛАБОЙ (цена каталожная).`);
      rec = await ops.fetch(rec.id);
    }
  } else {
    console.log(`⚠️  цена услуги ${first} слишком мала для скидки — проверка цены будет СЛАБОЙ.`);
  }
  if (hardened) check('индивидуальная цена и скидка на записи заданы (проверка цены сильная)', true, `скидка ${rec.services[0].discount}%, cost=${rec.services[0].cost}`);
  else warn('индивидуальная цена/скидка на записи НЕ заданы — вердикт PRICE_PRESERVED будет по каталожной цене (слабая проверка)');
  const visitMs = Date.parse(rec.datetime);

  // 3. Состояние записи — как после вебхука create (правил в БД нет — ставится только состояние).
  await enroll.handleRecordEvent(salon, { status: 'create', data: rec }, Date.now());
  const st = await db.oneOrNone('SELECT attendance, deleted FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = $2', [SALON, rec.id]);
  check('состояние записи сохранено вебхук-путём (attendance 0, не удалена)', st && Number(st.attendance) === 0 && st.deleted === false, JSON.stringify(st));

  // 4. «Ушедшее» напоминание и его эхо в переписке.
  const reminderText = `E2E-ответы ${RUN}: напоминаем о записи ${msk(visitMs).date} в ${msk(visitMs).time}. Подтвердите запись, ответив «Подтверждаю».`;
  const reminderJobId = await insertSentJob({ type: 'visit_reminder', recordId: rec.id, visitMs, text: reminderText, ask: true, sentAgoSec: 60, clientId });
  await insertOutgoing(reminderText, 60, CHAT_ID);

  // ── контроль: цифра после напоминания (не опроса) не перехватывается ──
  section('контроль: цифра после НАПОМИНАНИЯ не перехватывается');
  const c0 = await handle('5');
  check('«5» после напоминания → handled:false (ход уходит Миле), ничего не отправлено', c0.res.handled === false && c0.calls.length === 0, JSON.stringify(c0.res));

  // ── «Подтверждаю» ──
  section('«Подтверждаю» → статус «Подтвердил» в YClients без потери цены');
  const beforeConfirm = await ops.fetch(rec.id);
  const c1 = await handle('Подтверждаю');
  check('handleIncoming → handled:true, kind confirmed', c1.res.handled === true && c1.res.kind === 'confirmed', JSON.stringify(c1.res));
  const afterConfirm = await ops.fetch(rec.id);
  check('в YClients attendance = 2 («Подтвердил»)', Number(afterConfirm.attendance) === 2, `attendance=${afterConfirm.attendance} confirmed=${afterConfirm.confirmed}`);
  const jobRow = await db.oneOrNone('SELECT confirmed_at FROM notification_jobs WHERE id = $1', [reminderJobId]);
  check('у задания-напоминания стоит confirmed_at', jobRow && jobRow.confirmed_at, jobRow && jobRow.confirmed_at && new Date(jobRow.confirmed_at).toISOString());
  check('отбивка ушла ОДНА: текст confirm_reply_text, ответом на сообщение пациента, в tdlib',
    c1.calls.length === 1 && c1.calls[0].payload.text === cfg.confirm_reply_text && c1.calls[0].payload.replyToMessageId === c1.m.messageId && c1.calls[0].ch === 'tdlib',
    c1.calls.map((c) => `${c.ch}:${JSON.stringify(c.payload.text).slice(0, 40)}`).join(' | '));
  check('эскалации на подтверждении нет', escalateCalls.length === 0);

  // Как после настоящего вебхука «update attendance=2»: состояние записи обновляется.
  await enroll.handleRecordEvent(salon, { status: 'update', data: afterConfirm }, Date.now());

  // ── ГЛАВНАЯ ПРОВЕРКА ──
  section('ГЛАВНАЯ ПРОВЕРКА: цена, скидка, имя клиента, мастер, время и длительность после подтверждения');
  const pRows = priceDiff(beforeConfirm, afterConfirm);
  const cRows = coreDiff(beforeConfirm, afterConfirm);
  console.log('  цены услуг (до → после):');
  for (const r of pRows) console.log(`    ${r.same ? '=' : 'Δ'} ${r.what}: ${fmtV(r.before)} → ${fmtV(r.after)}`);
  console.log('  прочие поля записи (до → после):');
  for (const r of cRows) console.log(`    ${r.same ? '=' : 'Δ'} ${r.what}: ${fmtV(r.before)} → ${fmtV(r.after)}`);
  const other = deepDiff(beforeConfirm, afterConfirm).filter((d) => !EXPECTED_CHANGE.has(d.path.split('.').pop()) && !d.path.startsWith('services.'));
  const expected = deepDiff(beforeConfirm, afterConfirm).filter((d) => EXPECTED_CHANGE.has(d.path.split('.').pop()));
  console.log(`  ожидаемые изменения: ${expected.map((d) => `${d.path} ${fmtV(d.before)}→${fmtV(d.after)}`).join('; ') || '(нет)'}`);
  console.log(`  прочие различия записи вне таблиц выше: ${other.length ? other.slice(0, 25).map((d) => `${d.path} ${fmtV(d.before)}→${fmtV(d.after)}`).join('; ') : '(нет)'}`);
  const pricePreserved = pRows.length > 0 && pRows.every((r) => r.same);
  const fieldsPreserved = cRows.every((r) => r.same);
  console.log(`\nPRICE_PRESERVED: ${pricePreserved ? 'yes' : 'no'}${hardened ? '' : '   (ВНИМАНИЕ: индивидуальная цена не была задана — проверка по каталожной цене слабая)'}`);
  if (!pricePreserved) {
    console.log('ДИФФ ЦЕН:');
    for (const r of pRows.filter((x) => !x.same)) console.log(`   ${r.what}: ${fmtV(r.before)} → ${fmtV(r.after)}`);
  }
  console.log(`RECORD_FIELDS_PRESERVED (клиент/мастер/время/длительность/комментарий): ${fieldsPreserved ? 'yes' : 'no'}\n`);
  check('PRICE_PRESERVED: цена и скидка услуг записи не изменились', pricePreserved,
    pricePreserved ? '' : pRows.filter((x) => !x.same).map((r) => `${r.what}: ${fmtV(r.before)}→${fmtV(r.after)}`).join('; '));
  check('имя клиента, мастер, время и длительность записи не изменились', fieldsPreserved,
    fieldsPreserved ? '' : cRows.filter((x) => !x.same).map((r) => `${r.what}: ${fmtV(r.before)}→${fmtV(r.after)}`).join('; '));

  // ── повтор ──
  section('повторное «Подтверждаю» → duplicate');
  const c2 = await handle('Подтверждаю');
  check('повтор → handled:true, kind duplicate', c2.res.handled === true && c2.res.kind === 'duplicate', JSON.stringify(c2.res));
  check('повтор молчит: ни одной отправки', c2.calls.length === 0);

  // ── оценка 5 ──
  section('опрос + «5» → visit_ratings, благодарность, без перевода на администратора');
  const rec5 = 9200000000 + (Date.now() % 100000000) * 10 + 5;
  fakeRecordIds.push(rec5);
  const survey5 = `E2E-ответы ${RUN}: спасибо, что посетили PERI CLINIC! Оцените визит цифрой от 2 до 5 (1).`;
  const job5 = await insertSentJob({ type: 'visit_review', recordId: rec5, visitMs: Date.now() - 3600 * 1000, text: survey5, ask: false, sentAgoSec: 40, clientId });
  await insertOutgoing(survey5, 40, CHAT_ID);
  const r5 = await handle('5');
  check('«5» → handled:true, kind rating, rating 5', r5.res.handled === true && r5.res.kind === 'rating' && r5.res.rating === 5, JSON.stringify(r5.res));
  const vr5 = await db.oneOrNone('SELECT rating, source_job_id, phone, client_id, yclients_record_id FROM visit_ratings WHERE salon_id = $1 AND source_job_id = $2', [SALON, job5]);
  check('строка visit_ratings: оценка 5, запись, телефон-канон, клиент, задание-источник',
    vr5 && vr5.rating === 5 && Number(vr5.yclients_record_id) === rec5 && vr5.phone === PHONE && Number(vr5.client_id) === Number(clientId), JSON.stringify(vr5));
  check('отправлена ОДНА благодарность rating_high_text', r5.calls.length === 1 && r5.calls[0].payload.text === cfg.rating_high_text, r5.calls.map((c) => JSON.stringify(c.payload.text).slice(0, 40)).join(' | '));
  check('на «5» перевода на администратора нет', escalateCalls.length === 0);
  const r5b = await handle('5');
  check('повторная «5» → duplicate, молча', r5b.res.handled === true && r5b.res.kind === 'duplicate' && r5b.calls.length === 0, JSON.stringify(r5b.res));

  // ── оценка 3 ──
  section('новый опрос + «3» → visit_ratings, «что не устроило», перевод на администратора (low_rating)');
  const rec3 = 9300000000 + (Date.now() % 100000000) * 10 + 3;
  fakeRecordIds.push(rec3);
  const survey3 = `E2E-ответы ${RUN}: спасибо, что посетили PERI CLINIC! Оцените визит цифрой от 2 до 5 (2).`;
  const job3 = await insertSentJob({ type: 'visit_review', recordId: rec3, visitMs: Date.now() - 1800 * 1000, text: survey3, ask: false, sentAgoSec: 10, clientId });
  await insertOutgoing(survey3, 10, CHAT_ID);
  const r3 = await handle('3');
  check('«3» → handled:true, kind rating, rating 3', r3.res.handled === true && r3.res.kind === 'rating' && r3.res.rating === 3, JSON.stringify(r3.res));
  const vr3 = await db.oneOrNone('SELECT rating, source_job_id, yclients_record_id FROM visit_ratings WHERE salon_id = $1 AND source_job_id = $2', [SALON, job3]);
  check('строка visit_ratings: оценка 3, запись, задание-источник', vr3 && vr3.rating === 3 && Number(vr3.yclients_record_id) === rec3, JSON.stringify(vr3));
  check('отправлена ОДНА отбивка rating_low_text', r3.calls.length === 1 && r3.calls[0].payload.text === cfg.rating_low_text, r3.calls.map((c) => JSON.stringify(c.payload.text).slice(0, 40)).join(' | '));
  check('эскалация вызвана ОДИН раз с reason low_rating и ключом диалога',
    escalateCalls.length === 1 && escalateCalls[0].input.reason === 'low_rating' && escalateCalls[0].ctx.dialogKey === RAW_PHONE && escalateCalls[0].salonId === SALON,
    JSON.stringify(escalateCalls.map((c) => ({ input: c.input, ctx: c.ctx }))));

  // ── контроль ──
  section('контроль: «Подтверждаю» после ОПРОСА не перехватывается');
  const c3 = await handle('Подтверждаю');
  check('«Подтверждаю» после опроса → handled:false, ничего не отправлено', c3.res.handled === false && c3.calls.length === 0, JSON.stringify(c3.res));
  check('реальный диалог тестового номера не создавался/не менялся через getOrCreate (заглушка вызвана только на низкой оценке)',
    getOrCreateCalls.length === 1 && getOrCreateCalls[0].key === RAW_PHONE, JSON.stringify(getOrCreateCalls));
}

// ── уборка и сверка ──────────────────────────────────────────
async function cleanup(ops) {
  section('уборка');
  for (const id of [...recordIds]) {
    try {
      let gone = await ops.isGone(id).catch(() => false);
      if (!gone) {
        try { await ops.remove(id); } catch (e) { console.log(`  запись ${id}: DELETE не прошёл (${e.message})`); }
        gone = await ops.isGone(id).catch(() => false);
      }
      if (!gone) {
        const full = ops.live ? await ops.fetch(id).catch(() => null) : null;
        const cancelled = full ? await ops.emergencyCancel(full) : false;
        console.log(`  запись ${id}: НЕ УДАЛЕНА${cancelled ? ' (поставлено «клиент не придёт»)' : ''} — УДАЛИТЬ ВРУЧНУЮ в YClients`);
      } else {
        console.log(`  запись ${id}: удалена (проверено)`);
      }
      check(`запись ${id} удалена из YClients`, gone);
    } catch (e) {
      check(`запись ${id} удалена из YClients`, false, e.message);
    }
  }
  const allRec = [...recordIds, ...fakeRecordIds];
  const delRat = await db.query('DELETE FROM visit_ratings WHERE salon_id = $1 AND (source_job_id = ANY($2::bigint[]) OR yclients_record_id = ANY($3::bigint[])) RETURNING id', [SALON, jobIds, allRec]);
  const delJobs = await db.query('DELETE FROM notification_jobs WHERE salon_id = $1 AND (id = ANY($2::bigint[]) OR yclients_record_id = ANY($3::bigint[])) RETURNING id', [SALON, jobIds, allRec]);
  const delState = await db.query('DELETE FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = ANY($2::bigint[]) RETURNING yclients_record_id', [SALON, allRec]);
  const delMsgs = await db.query('DELETE FROM chatpush_messages WHERE salon_id = $1 AND id = ANY($2::int[]) RETURNING id', [SALON, msgIds]);
  console.log(`  удалено: оценок ${delRat.rowCount}, заданий ${delJobs.rowCount}, состояний записей ${delState.rowCount}, строк переписки ${delMsgs.rowCount}`);
}

async function snapshotTestNumber() {
  const keys = [PHONE, RAW_PHONE];
  const dialogs = await db.any('SELECT id, dialog_key, status, escalated_reason, updated_at FROM agent_dialogs WHERE salon_id = $1 AND dialog_key = ANY($2)', [SALON, keys]);
  const events = await db.oneOrNone('SELECT count(*)::int AS n, coalesce(max(id),0) AS mx FROM agent_events WHERE salon_id = $1 AND dialog_key = ANY($2)', [SALON, keys]);
  const care = await db.oneOrNone('SELECT count(*)::int AS n, coalesce(max(id),0) AS mx FROM care_enrollments WHERE salon_id = $1 AND phone = ANY($2)', [SALON, keys]);
  const settings = await db.oneOrNone('SELECT mode, updated_at FROM notification_settings WHERE salon_id = $1', [SALON]);
  return JSON.stringify({ dialogs, events, care, settings });
}

async function residue(snapBefore) {
  section('следов в БД нет');
  const q = async (sql, p) => Number((await db.oneOrNone(sql, p)).n);
  const allRec = [...recordIds, ...fakeRecordIds];
  check('заданий прогона в БД нет', (await q('SELECT count(*)::int AS n FROM notification_jobs WHERE salon_id = $1 AND (id = ANY($2::bigint[]) OR yclients_record_id = ANY($3::bigint[]) OR rule_title LIKE $4)', [SALON, jobIds, allRec, `E2E-ответы ${RUN}%`])) === 0);
  check('оценок прогона в БД нет', (await q('SELECT count(*)::int AS n FROM visit_ratings WHERE salon_id = $1 AND (source_job_id = ANY($2::bigint[]) OR yclients_record_id = ANY($3::bigint[]))', [SALON, jobIds, allRec])) === 0);
  check('состояний записей прогона в БД нет', (await q('SELECT count(*)::int AS n FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = ANY($2::bigint[])', [SALON, allRec])) === 0);
  check('строк переписки прогона в БД нет', (await q(`SELECT count(*)::int AS n FROM chatpush_messages WHERE salon_id = $1 AND (id = ANY($2::int[]) OR external_message_id LIKE $3)`, [SALON, msgIds, `e2e-notify:${RUN}:%`])) === 0);
  const after = await snapshotTestNumber();
  check('agent_dialogs / agent_events / care_enrollments тестового номера и notification_settings не изменились', after === snapBefore, after === snapBefore ? '' : `было ${snapBefore} стало ${after}`);
  check('запрещённых SQL-записей (settings/agent_*/care_*) не было', violations.length === 0, violations.join('; '));
  check('реальных отправок через chatpush не было', realSendAttempts.length === 0, realSendAttempts.join(','));
}

// Прерывание (Ctrl-C, kill): запись YClients и строки в БД не должны остаться висеть.
let activeOps = null;
let emergency = false;
async function emergencyStop(sig) {
  if (emergency) return;
  emergency = true;
  console.log(`\n${sig}: прерываю прогон, убираю за собой…`);
  try { if (activeOps) await cleanup(activeOps); } catch (e) { console.log(`уборка при прерывании упала: ${e.message}`); }
  process.exit(130);
}
process.on('SIGINT', () => emergencyStop('SIGINT'));
process.on('SIGTERM', () => emergencyStop('SIGTERM'));

async function main() {
  guardAgainstLiveWorker();
  salon = await db.oneOrNone('SELECT * FROM salons WHERE id = $1', [SALON]);
  if (!salon) throw new Error(`салон ${SALON} не найден`);
  const settingsRow = await db.oneOrNone('SELECT mode FROM notification_settings WHERE salon_id = $1', [SALON]);
  const modeInDb = settingsRow ? settingsRow.mode : 'off';
  if (modeInDb !== 'off') {
    console.error(`ОТКАЗ: режим уведомлений салона ${SALON} в БД — «${modeInDb}», а не off. Дев получает настоящие вебхуки клиники; скрипт работает только при off.`);
    process.exit(2);
  }
  const ops = SYNTHETIC ? syntheticOps() : liveOps();
  activeOps = ops;
  const snapBefore = await snapshotTestNumber();
  console.log(`салон #${salon.id} «${salon.name}», тестовый клиент ${PHONE} (YClients ${CLIENT_YC_ID}); режим в БД: ${modeInDb} (подменён в процессе на live); записи: ${ops.name}`);

  let crashed = null;
  try {
    await scenario(ops);
  } catch (e) {
    crashed = e;
    nFail += 1;
    console.log(`  FAIL  сценарий прерван исключением  ← ${e.stack || e.message}`);
  } finally {
    try { await cleanup(ops); } catch (e) { nFail += 1; console.log(`  FAIL  уборка упала  ← ${e.stack || e.message}`); }
    try { await residue(snapBefore); } catch (e) { nFail += 1; console.log(`  FAIL  сверка следов упала  ← ${e.message}`); }
  }
  console.log(`\nИТОГ: PASS ${nPass} / FAIL ${nFail}${nWarn ? ` / WARN ${nWarn}` : ''}${crashed ? ' (сценарий прерван)' : ''}`);
  return nFail === 0 ? 0 : 1;
}

main().then(async (code) => { await pool.end().catch(() => {}); process.exit(code); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
