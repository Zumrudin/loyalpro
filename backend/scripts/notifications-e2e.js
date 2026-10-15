#!/usr/bin/env node
'use strict';
// ============================================================
// Живая проверка модуля уведомлений YClients на дев-БД (Task 11, шаг 1 плана
// docs/superpowers/plans/2026-10-13-yclients-notifications-own-module.md).
//
//   node scripts/notifications-e2e.js [--allow-worker-running] [--synthetic] [--staff <yc_id>] [--service <yc_id>]
//
// ЧТО ДЕЛАЕТ. Создаёт в YClients запись тестового клиента (79200255591) на будущее, после КАЖДОЙ операции
// (создание, перенос, «не придёт», возврат, удаление) берёт запись обратно GET-ом и подаёт её в
// enroll.handleRecordEvent так, как это делает routes/webhook.js; задания обрабатывает НАСТОЯЩИЙ
// worker.processOne. Сценарии:
//  (а) запись на будущее → «Вы записаны» уходит, напоминание стоит на визит − 24 ч;
//  (б) перенос → старое напоминание погашено, новое стоит, «перенесена» уходит;
//  (в) «клиент не придёт» (attendance −1) → письмо об отмене в очереди, напоминание погашено;
//  (г) возврат (attendance 0) → не ушедшее письмо об отмене погашено, напоминание ожило;
//  (е) второе «не придёт» → письмо об отмене уходит КАСКАДОМ: порядок max → tdlib, max отвечает 422;
//  (г2) второй возврат → напоминание снова ожило, ушедшее письмо не тронуто;
//  (д) удаление записи → письма об отмене НЕТ, всё запланированное погашено;
//  (ж) first_visit клиенту с прошлыми визитами не ставится;
//  (з) «пришёл» — СИНТЕТИЧЕСКОЕ событие с выдуманным id (YClients не трогаем): опрос и рекомендации встают
//      после конца визита, повтор события их не дублирует, второй визит того же дня опроса не получает.
//
// БЕЗОПАСНОСТЬ (дев получает НАСТОЯЩИЕ вебхуки клиники и держит боевые аккаунты мессенджеров):
//  • режим салона читается из БД на старте; не 'off' (строки нет — тоже off) → отказ, ничего не делаем;
//  • notification_settings НЕ пишется НИКОГДА: режим 'live' и настройки подменяются только в процессе
//    (monkeypatch settings.getSettings); updateSettings заменён на бросок, а SQL-ловушка на pool.query
//    не пропускает запись в notification_settings и в таблицы Милы/«Заботы»;
//  • транспорт подменён в процессе (sendMessage/sendFile/getDeliveryStatus), флага --send НЕТ — реальной отправки
//    не бывает; нижний слой chatpush.* заменён на ловушку, бросающую при любой попытке мимо заглушки;
//  • журнал авторства (outgoing_authored) заглушён — след в БД не остаётся;
//  • задания обрабатываются processOne(job, cfg) по id: processTick, аренда и режим из БД не участвуют;
//  • записи YClients — только тестового клиента 79200255591, только созданные этим скриптом (PUT/DELETE
//    проверяют id по списку созданных); удаляются в finally и проверяются;
//  • dev pm2 `loyalpro` должен быть ОСТАНОВЛЕН: его обработчик вебхуков гоняется с этим скриптом за
//    notification_record_state. При online скрипт отказывается работать без --allow-worker-running.
//
// --synthetic — без YClients: записи выдумываются и «ходят» в памяти (id ≥ 9 млрд), для отладки самого скрипта.
// Всё созданное (правила, задания, состояние записей) удаляется в finally по id; в конце — сверка, что следов нет.
// ============================================================
const { execFileSync } = require('child_process');
const axios = require('axios');
const { db, pool } = require('../db');
const config = require('../config');

// ── аргументы ────────────────────────────────────────────────
const KNOWN_FLAGS = new Set(['--synthetic', '--allow-worker-running', '--staff', '--service']);
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

const SALON = 1;
const PHONE = '79200255591';
const CLIENT_YC_ID = 134014107;
const STAFF = Number(val('--staff', 3356928));        // Богатырева Татьяна
const SERVICE = Number(val('--service', 9536744));    // малая зона (как в agent-reschedule-*-e2e)
const HOURS_BEFORE = 24;
const COMMENT = 'E2E уведомлений (тестовая запись, удалить)';
const PM2_NAME = 'loyalpro';

// ── страховка: боевой процесс дева ───────────────────────────
function guardAgainstLiveWorker() {
  if (ALLOW_WORKER_RUNNING) {
    console.warn('⚠️  --allow-worker-running: проверка pm2-процесса дева ОБОЙДЕНА осознанно.');
    return;
  }
  let status = null;
  try {
    const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000 }));
    const proc = (list || []).find((p) => p && p.name === PM2_NAME);
    status = proc && proc.pm2_env && proc.pm2_env.status;
  } catch (e) {
    console.warn(`⚠️  не удалось спросить pm2 (${e.message}) — проверка процесса дева ПРОПУЩЕНА`);
    return;
  }
  if (status === 'online') {
    console.error([
      '', `ОТКАЗ: pm2-процесс «${PM2_NAME}» сейчас ONLINE.`,
      'Его обработчик вебхуков YClients гоняется с этим скриптом за notification_record_state.',
      '  1) pm2 stop ' + PM2_NAME,
      '  2) node scripts/notifications-e2e.js',
      `  3) PORT=3001 pm2 restart ${PM2_NAME} && ss -ltnp | grep 3001`, '',
    ].join('\n'));
    process.exit(2);
  }
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
const { withRateLimitRetry } = require('../services/yclients-retry');
const { normalizePhoneKey } = require('../services/agent-gate');

const realSendAttempts = [];
for (const fn of ['sendMessage', 'sendFile', 'getDeliveryStatus']) {
  if (typeof chatpush[fn] === 'function') {
    chatpush[fn] = () => { realSendAttempts.push(fn); throw new Error(`e2e: попытка реального chatpush.${fn} мимо заглушки транспорта`); };
  }
}

// Настройки: режим 'live' и всё остальное — ТОЛЬКО в процессе. Тихие часы выключены, чтобы моменты
// напоминаний не зависели от времени суток; prefer_last_channel выключен, чтобы порядок каскада был
// ровно тем, что задан (иначе последняя переписка тестового номера переставила бы мессенджеры).
const baseCfg = { ...settingsSvc.DEFAULTS, salon_id: SALON, mode: 'live', quiet_from: null, quiet_to: null, prefer_last_channel: false };
const cfgMain = Object.freeze({ ...baseCfg, default_channels: Object.freeze(['tdlib', 'max']) });
const cfgCascade = Object.freeze({ ...baseCfg, default_channels: Object.freeze(['max', 'tdlib']) });
settingsSvc.getSettings = async () => cfgMain;
settingsSvc.updateSettings = async () => { throw new Error('e2e: запись notification_settings запрещена'); };

// Транспорт-заглушка. rejectChannels — каналы, которые «отвечают 422» (однозначный отказ → каскад идёт дальше).
const sent = [];                  // все вызовы sendMessage/sendFile (и отказанные)
const policy = { rejectChannels: new Set() };
let deliverySeq = 0;
transport.sendMessage = async (salonId, payload) => {
  const ch = (payload.dispatchRouting || [])[0];
  sent.push({ salonId, ch, payload, rejected: policy.rejectChannels.has(ch) });
  if (policy.rejectChannels.has(ch)) throw Object.assign(new Error(`e2e-заглушка: ${ch} отклонил получателя (422)`), { status: 422 });
  deliverySeq += 1;
  return { id: `e2e-stub-${deliverySeq}`, accountId: 'e2e-stub', channels: [ch] };
};
transport.sendFile = async (salonId, payload) => {
  const ch = (payload.dispatchRouting || [])[0];
  sent.push({ salonId, ch, payload, file: true, rejected: false });
  deliverySeq += 1;
  return { id: `e2e-stub-${deliverySeq}`, accountId: 'e2e-stub', channels: [ch] };
};
transport.getDeliveryStatus = async () => ({ status: { status_id: 3, description: 'Доставлено (e2e-заглушка)' } });
authorship.remember = async () => {};

const enroll = require('../services/notifications/enroll');
const worker = require('../services/notifications/worker');
const ev = require('../services/notifications/events');

// ── вывод ────────────────────────────────────────────────────
let nPass = 0;
let nFail = 0;
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
  return { date: `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`, time: iso.slice(11, 16), ymd: iso.slice(0, 10),
    full: `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)}` };
}

// ── состояние прогона ────────────────────────────────────────
let salon = null;
const ruleIds = [];                // правила этого прогона
const recordIds = [];              // записи YClients (или выдуманные в --synthetic) этого прогона
const extraRecordIds = [];         // выдуманные id событий (з): в YClients их нет, чистятся только в БД
const rulesByType = {};

const TPL = {
  record_created: 'E2E-живой прогон: вы записаны на приём {date} в {time}. {services}, специалист {staff}. Ждём вас в {salon}!',
  record_rescheduled: 'E2E-живой прогон: ваша запись перенесена на {date} в {time}. {services}, специалист {staff}.',
  record_cancelled: 'E2E-живой прогон: ваша запись на {date} в {time} отменена.',
  visit_reminder: 'E2E-живой прогон: напоминаем о записи {date} в {time} ({services}, {staff}). Подтвердите запись, ответив «Подтверждаю».',
  visit_review: 'E2E-живой прогон: спасибо, что посетили {salon}! Оцените визит цифрой от 2 до 5.',
  visit_after: 'E2E-живой прогон: рекомендации после процедуры «{services}».',
  first_visit: 'E2E-живой прогон: добро пожаловать в программу лояльности {salon}!',
};

async function createRules() {
  for (const type of Object.keys(TPL)) {
    const r = await db.oneOrNone(
      `INSERT INTO notification_rules
         (salon_id, title, is_enabled, trigger_type, conditions, message_template, channels, prefer_last_channel,
          hours_before, delay_minutes, on_no_show, ask_confirmation)
       VALUES ($1,$2,TRUE,$3,'{"logic":"and","items":[]}'::jsonb,$4,'["telegram","whatsapp"]'::jsonb,TRUE,$5,$6,TRUE,TRUE)
       RETURNING *`,
      [SALON, `E2E-живой прогон: ${type}`, type, TPL[type], type === 'visit_reminder' ? HOURS_BEFORE : null,
        type === 'visit_review' ? 5 : (type === 'visit_after' ? 7 : null)]);
    ruleIds.push(r.id);
    rulesByType[type] = r;
  }
  console.log(`правила созданы: ${Object.entries(rulesByType).map(([t, r]) => `${t}=#${r.id}`).join(', ')}`);
}

// ── записи: боевой YClients или выдуманные ───────────────────
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
    // Дневной свободный слот у мастера на одну из ближайших дат (не раньше +2 суток: напоминание за 24 ч должно успевать).
    async pickSlot(excludeYmd) {
      const now = Date.now();
      for (let i = 2; i <= 16; i++) {
        const ymd = msk(now + i * 86400000).ymd;
        if (ymd === excludeYmd) continue;
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
      recordIds.push(id);           // сразу: cleanup должен знать о записи, даже если проверка ниже упадёт
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
    async remove(rec) {
      assertOwned(rec.id);
      const url = `${config.YC}/record/${salon.yclients_company_id}/${rec.id}`;
      try {
        await withRateLimitRetry(() => axios.delete(url, { headers: ycHeaders(salon), timeout: 15000 }));
      } catch (e1) {
        await withRateLimitRetry(() => axios.delete(url, { headers: ycHeaders(authSalonFor(salon)), timeout: 15000 }));
      }
      await sleep(700);
      return { ...rec, deleted: true };
    },
    // Запись действительно ушла? (YClients отдаёт удалённую либо 404, либо телом с deleted:true.)
    async isGone(id) {
      try { const r = await fetch(id); return r.deleted === true; } catch (e) { return /404|не найден/i.test(String(e.message) + String(e.status)); }
    },
    async emergencyCancel(rec) {   // если удалить не вышло: хотя бы «клиент не придёт»
      try { await this.put(rec, { attendance: -1 }); return true; } catch (e) { return false; }
    },
  };
}

function syntheticOps() {
  const store = new Map();
  let seq = 0;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  return {
    name: 'синтетика (YClients не трогаем)', live: false,
    async pickSlot(excludeYmd) {
      const day = excludeYmd ? 4 : 3;
      const ymd = msk(Date.now() + day * 86400000).ymd;
      const time = excludeYmd ? '13:00' : '12:00';
      return { ymd, time, datetime: `${ymd}T${time}:00+03:00`, seance_length: 300 };
    },
    async create(slot) {
      seq += 1;
      const id = 9000000000 + (Date.now() % 100000000) * 10 + seq;
      const rec = {
        id, datetime: slot.datetime, date: `${slot.ymd} ${slot.time}:00`, seance_length: slot.seance_length, length: slot.seance_length,
        attendance: 0, deleted: false, sms_before: 0, staff_id: STAFF, staff: { id: STAFF, name: 'Богатырева Татьяна' },
        services: [{ id: SERVICE, title: 'Малая зона (синтетика)', cost: 1000 }],
        client: { id: CLIENT_YC_ID, name: 'Зумрудин', phone: '+79200255591' }, comment: COMMENT, short_link: 'https://example.invalid/r',
      };
      recordIds.push(id);
      store.set(id, rec);
      return clone(rec);
    },
    async put(rec, over) {
      assertOwned(rec.id);
      const cur = store.get(rec.id);
      Object.assign(cur, over);
      if (over.datetime) cur.date = over.datetime.slice(0, 10) + ' ' + over.datetime.slice(11, 19);
      return clone(cur);
    },
    async remove(rec) { assertOwned(rec.id); store.get(rec.id).deleted = true; return clone(store.get(rec.id)); },
    async isGone(id) { const r = store.get(id); return !r || r.deleted === true; },
    async emergencyCancel() { return true; },
  };
}

// ── запросы к БД ─────────────────────────────────────────────
async function jobsOf(recordId) {
  const rows = await db.any(
    `SELECT j.*, (extract(epoch from j.scheduled_at)*1000)::float8 AS sched_ms, (extract(epoch from j.visit_datetime)*1000)::float8 AS visit_ms
       FROM notification_jobs j
      WHERE j.salon_id = $1 AND j.yclients_record_id = $2 AND j.rule_id = ANY($3::int[]) ORDER BY j.id`,
    [SALON, recordId, ruleIds]);
  return rows.map((r) => ({ ...r, id: Number(r.id), sched_ms: Math.round(r.sched_ms), visit_ms: r.visit_ms == null ? null : Math.round(r.visit_ms) }));
}
const ofType = (jobs, type, visitMs) => jobs.filter((j) => j.trigger_type === type && (visitMs == null || j.visit_ms === visitMs));
const fmtJob = (j) => `#${j.id} ${j.trigger_type} ${j.status}${j.decision_reason ? ` «${j.decision_reason}»` : ''} визит=${j.visit_ms ? msk(j.visit_ms).full : '-'} отправка=${msk(j.sched_ms).full}`;
const stateOf = (recordId) => db.oneOrNone(
  `SELECT attendance, deleted, (extract(epoch from visit_datetime)*1000)::float8 AS visit_ms, phone, client_yc_id
     FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = $2`, [SALON, recordId]);

async function feed(status, rec) {
  await enroll.handleRecordEvent(salon, { status, data: rec }, Date.now());
}
async function runJob(job, cfg) {
  const row = await db.oneOrNone('SELECT * FROM notification_jobs WHERE id = $1', [job.id]);
  await worker.processOne(row, cfg);
  return db.oneOrNone('SELECT * FROM notification_jobs WHERE id = $1', [job.id]);
}
const textHasVisit = (text, ms) => text.includes(msk(ms).date) && text.includes(msk(ms).time);

// ── сценарии ─────────────────────────────────────────────────
async function scenarios(ops) {
  let rec;
  let jobs;

  // ── (а) запись на будущее ──
  section('(а) запись на будущее: «Вы записаны» уходит, напоминание стоит на визит − 24 ч');
  const slotA = await ops.pickSlot(null);
  rec = await ops.create(slotA);
  const visitA = Date.parse(rec.datetime);
  console.log(`запись #${rec.id}: ${rec.datetime} (${rec.staff && rec.staff.name}; ${(rec.services || []).map((s) => s.title).join(', ')})`);
  await feed('create', rec);
  jobs = await jobsOf(rec.id);
  const created = ofType(jobs, 'record_created');
  check('(а) record_created поставлен одним pending-заданием', created.length === 1 && created[0].status === 'pending', jobs.map(fmtJob).join('; '));
  check('(а) текст «Вы записаны» подставил дату, время, услугу, мастера, салон и не оставил {плейсхолдеров}',
    created[0] && textHasVisit(created[0].rendered_text, visitA) && created[0].rendered_text.includes(rec.staff.name)
      && created[0].rendered_text.includes(rec.services[0].title) && created[0].rendered_text.includes(salon.name) && !/\{[a-z_]+\}/.test(created[0].rendered_text),
    created[0] && created[0].rendered_text);
  const remA = ofType(jobs, 'visit_reminder', visitA);
  check('(а) visit_reminder pending на визит − hours_before ровно',
    remA.length === 1 && remA[0].status === 'pending' && remA[0].sched_ms === visitA - HOURS_BEFORE * 3600 * 1000,
    remA[0] ? `${msk(remA[0].sched_ms).full} (визит ${msk(visitA).full})` : 'нет задания');
  check('(а) у напоминания стоит просьба подтвердить (meta.askConfirmation)', remA[0] && remA[0].meta && remA[0].meta.askConfirmation === true);
  check('(а) опрос и рекомендации на создании записи не ставятся', ofType(jobs, 'visit_review').length === 0 && ofType(jobs, 'visit_after').length === 0);
  const stA = await stateOf(rec.id);
  check('(а) состояние записи сохранено (визит, attendance 0, не удалена, телефон)',
    stA && Math.round(stA.visit_ms) === visitA && Number(stA.attendance) === 0 && stA.deleted === false && stA.phone === PHONE, JSON.stringify(stA));

  const sentBeforeA = sent.length;
  const doneA = await runJob(created[0], cfgMain);
  const callsA = sent.slice(sentBeforeA);
  check('(а) processOne: заглушка вызвана ровно один раз, на tdlib, с текстом задания',
    callsA.length === 1 && callsA[0].ch === 'tdlib' && callsA[0].payload.text === created[0].rendered_text, callsA.map((c) => `${c.ch}`).join(','));
  check('(а) адресат tdlib: числовой id чата или номер', callsA[0] && (/^\d+$/.test(String(callsA[0].payload.tdlib_user_id || '')) || callsA[0].payload.phone === PHONE),
    callsA[0] && JSON.stringify({ tdlib_user_id: callsA[0].payload.tdlib_user_id, phone: callsA[0].payload.phone }));
  check('(а) строка sent: канал, id доставки, sent_at, шаг каскада sent',
    doneA.status === 'sent' && doneA.channel_used === 'tdlib' && /^e2e-stub-/.test(doneA.delivery_id || '') && doneA.sent_at
      && Array.isArray(doneA.cascade_log) && doneA.cascade_log.length === 1 && doneA.cascade_log[0].res === 'sent',
    `${doneA.status}/${doneA.channel_used}/${doneA.delivery_id}`);

  // ── (б) перенос ──
  section('(б) перенос: старое напоминание погашено, новое стоит, «перенесена» уходит');
  const slotB = await ops.pickSlot(slotA.ymd);
  rec = await ops.put(rec, { datetime: slotB.datetime, seance_length: slotB.seance_length });
  const visitB = Date.parse(rec.datetime);
  console.log(`запись #${rec.id} перенесена: ${msk(visitA).full} → ${msk(visitB).full}`);
  check('(б) YClients действительно отдал новое время', visitB !== visitA && visitB === Date.parse(slotB.datetime), rec.datetime);
  await feed('update', rec);
  jobs = await jobsOf(rec.id);
  const oldRem = ofType(jobs, 'visit_reminder', visitA);
  const newRem = ofType(jobs, 'visit_reminder', visitB);
  const resched = ofType(jobs, 'record_rescheduled', visitB);
  check('(б) старое напоминание (визит A) погашено с причиной «запись перенесена»',
    oldRem.length === 1 && oldRem[0].status === 'cancelled' && oldRem[0].decision_reason === 'запись перенесена', oldRem[0] && fmtJob(oldRem[0]));
  check('(б) новое напоминание (визит B) pending на B − 24 ч',
    newRem.length === 1 && newRem[0].status === 'pending' && newRem[0].sched_ms === visitB - HOURS_BEFORE * 3600 * 1000,
    newRem[0] && fmtJob(newRem[0]));
  check('(б) record_rescheduled pending, текст с НОВЫМИ датой и временем',
    resched.length === 1 && resched[0].status === 'pending' && textHasVisit(resched[0].rendered_text, visitB) && !resched[0].rendered_text.includes(msk(visitA).date + ' в ' + msk(visitA).time),
    resched[0] && resched[0].rendered_text);
  check('(б) «Вы записаны» (record_created) осталось sent и не затронуто', ofType(jobs, 'record_created')[0].status === 'sent');
  const stB = await stateOf(rec.id);
  check('(б) состояние записи обновлено на новое время', stB && Math.round(stB.visit_ms) === visitB, stB && msk(Math.round(stB.visit_ms)).full);
  const sentBeforeB = sent.length;
  const doneB = await runJob(resched[0], cfgMain);
  const callsB = sent.slice(sentBeforeB);
  check('(б) processOne: «перенесена» отправлена заглушкой с текстом задания, строка sent',
    callsB.length === 1 && callsB[0].payload.text === resched[0].rendered_text && doneB.status === 'sent', `${doneB.status}`);

  // ── (в) «клиент не придёт» до визита ──
  section('(в) «клиент не придёт» (attendance −1) до визита: письмо об отмене в очереди, напоминание погашено');
  const sentBeforeC = sent.length;
  rec = await ops.put(rec, { attendance: -1 });
  check('(в) YClients отдал attendance −1, запись не удалена', Number(rec.attendance) === -1 && rec.deleted !== true, `attendance=${rec.attendance} deleted=${rec.deleted}`);
  await feed('update', rec);
  jobs = await jobsOf(rec.id);
  const remAfterNoShow = ofType(jobs, 'visit_reminder', visitB)[0];
  const canc1 = ofType(jobs, 'record_cancelled', visitB);
  check('(в) напоминание погашено с причиной «запись отменена»', remAfterNoShow && remAfterNoShow.status === 'cancelled' && remAfterNoShow.decision_reason === 'запись отменена', remAfterNoShow && fmtJob(remAfterNoShow));
  check('(в) record_cancelled поставлен pending (письмо об отмене), текст про отмену на дату визита',
    canc1.length === 1 && canc1[0].status === 'pending' && textHasVisit(canc1[0].rendered_text, visitB), canc1[0] && fmtJob(canc1[0]));
  check('(в) воркер не счёл письмо об отмене устаревшим, пока запись отменена', canc1[0] && (await worker.staleReason(await db.oneOrNone('SELECT * FROM notification_jobs WHERE id = $1', [canc1[0].id]))) === null);
  const stC = await stateOf(rec.id);
  check('(в) состояние записи: attendance −1', stC && Number(stC.attendance) === -1);
  check('(в) письмо об отмене ещё НЕ отправлено (ждёт в очереди)', sent.length === sentBeforeC);

  // ── (г) возврат attendance 0 ──
  section('(г) возврат (attendance 0): напоминание ожило, не ушедшее письмо об отмене погашено');
  rec = await ops.put(rec, { attendance: 0 });
  check('(г) YClients отдал attendance 0', Number(rec.attendance) === 0, `attendance=${rec.attendance}`);
  await feed('update', rec);
  jobs = await jobsOf(rec.id);
  const remRevived = ofType(jobs, 'visit_reminder', visitB);
  const canc2 = ofType(jobs, 'record_cancelled', visitB);
  check('(г) ровно одно напоминание на визит B — прежняя строка ожила pending на B − 24 ч (id тот же)',
    remRevived.length === 1 && remRevived[0].id === remAfterNoShow.id && remRevived[0].status === 'pending' && remRevived[0].sched_ms === visitB - HOURS_BEFORE * 3600 * 1000,
    remRevived[0] && fmtJob(remRevived[0]));
  check('(г) у ожившего напоминания сброшены следы (attempts 0, нет ошибки/отправки)', remRevived[0] && Number(remRevived[0].attempts) === 0 && !remRevived[0].error && !remRevived[0].sent_at);
  check('(г) pending-письмо об отмене погашено с причиной «запись восстановлена»',
    canc2.length === 1 && canc2[0].status === 'cancelled' && canc2[0].decision_reason === 'запись восстановлена', canc2[0] && fmtJob(canc2[0]));
  check('(г) ничего не отправлялось', sent.length === sentBeforeC);

  // ── (д2)+(е) второе «не придёт» → письмо об отмене уходит каскадом max (422) → tdlib ──
  section('(е) каскад: порядок max → tdlib, max отвечает 422 → cascade_log rejected, sent (письмо об отмене по второму «не придёт»)');
  rec = await ops.put(rec, { attendance: -1 });
  await feed('update', rec);
  jobs = await jobsOf(rec.id);
  const remCancelledAgain = ofType(jobs, 'visit_reminder', visitB)[0];
  const canc3 = ofType(jobs, 'record_cancelled', visitB);
  check('(е) напоминание снова погашено', remCancelledAgain && remCancelledAgain.status === 'cancelled', remCancelledAgain && fmtJob(remCancelledAgain));
  check('(е) письмо об отмене то же (id прежний) и ожило pending со сброшенным каскадом',
    canc3.length === 1 && canc3[0].id === canc2[0].id && canc3[0].status === 'pending' && Number(canc3[0].attempts) === 0
      && Array.isArray(canc3[0].cascade_log) && canc3[0].cascade_log.length === 0 && Number(canc3[0].cascade_pos) === 0,
    canc3[0] && fmtJob(canc3[0]));
  policy.rejectChannels = new Set(['max']);
  const sentBeforeE = sent.length;
  const doneE = await runJob(canc3[0], cfgCascade);
  policy.rejectChannels = new Set();
  const callsE = sent.slice(sentBeforeE);
  check('(е) заглушка вызвана дважды: сначала max (отказ), затем tdlib',
    callsE.length === 2 && callsE[0].ch === 'max' && callsE[0].rejected === true && callsE[1].ch === 'tdlib' && callsE[1].rejected === false,
    callsE.map((c) => `${c.ch}${c.rejected ? '(422)' : ''}`).join(' → '));
  const steps = Array.isArray(doneE.cascade_log) ? doneE.cascade_log : [];
  check('(е) cascade_log = rejected(max), sent(tdlib)',
    steps.length === 2 && steps[0].ch === 'max' && steps[0].res === 'rejected' && steps[1].ch === 'tdlib' && steps[1].res === 'sent',
    steps.map((s) => `${s.ch}:${s.res}`).join(', '));
  check('(е) строка sent через tdlib, позиция каскада 1, routing = [max, tdlib]',
    doneE.status === 'sent' && doneE.channel_used === 'tdlib' && Number(doneE.cascade_pos) === 1
      && Array.isArray(doneE.routing) && doneE.routing.join(',') === 'max,tdlib', `${doneE.status}/${doneE.channel_used}/pos=${doneE.cascade_pos}/${JSON.stringify(doneE.routing)}`);
  check('(в) письмо об отмене отправлено заглушкой (текст задания дошёл до tdlib)', callsE[1] && callsE[1].payload.text === canc3[0].rendered_text);

  // ── (г2) второй возврат ──
  section('(г2) второй возврат: напоминание снова ожило, отправленное письмо об отмене не тронуто');
  rec = await ops.put(rec, { attendance: 0 });
  await feed('update', rec);
  jobs = await jobsOf(rec.id);
  const remRevived2 = ofType(jobs, 'visit_reminder', visitB)[0];
  const cancAfter = ofType(jobs, 'record_cancelled', visitB)[0];
  check('(г2) напоминание снова pending на B − 24 ч', remRevived2 && remRevived2.status === 'pending' && remRevived2.sched_ms === visitB - HOURS_BEFORE * 3600 * 1000, remRevived2 && fmtJob(remRevived2));
  check('(г2) отправленное письмо об отмене осталось sent (не погашено и не возрождено)', cancAfter && cancAfter.status === 'sent', cancAfter && fmtJob(cancAfter));

  // ── (д) удаление записи ──
  section('(д) удаление записи: письма об отмене НЕТ, всё запланированное погашено');
  const sentBeforeD = sent.length;
  const cancelledLettersBefore = ofType(await jobsOf(rec.id), 'record_cancelled').length;
  const gone = await ops.remove(rec);
  await feed('delete', gone);
  jobs = await jobsOf(rec.id);
  const remAfterDelete = ofType(jobs, 'visit_reminder', visitB)[0];
  check('(д) напоминание погашено с причиной «запись отменена»', remAfterDelete && remAfterDelete.status === 'cancelled' && remAfterDelete.decision_reason === 'запись отменена', remAfterDelete && fmtJob(remAfterDelete));
  check('(д) pending-заданий по записи не осталось', jobs.filter((j) => j.status === 'pending').length === 0, jobs.filter((j) => j.status === 'pending').map(fmtJob).join('; '));
  check('(д) нового письма об отмене нет (число record_cancelled прежнее)', ofType(jobs, 'record_cancelled').length === cancelledLettersBefore, `${ofType(jobs, 'record_cancelled').length} шт.`);
  check('(д) ничего не отправлялось', sent.length === sentBeforeD);
  const stD = await stateOf(rec.id);
  check('(д) состояние записи: deleted', stD && stD.deleted === true);

  // ── (ж) first_visit ──
  section('(ж) first_visit клиенту с прошлыми визитами не ставится');
  const past = await db.oneOrNone(
    `SELECT count(*)::int AS n FROM records WHERE salon_id = $1 AND yclients_client_id = $2 AND status IN ('arrived','completed')`, [SALON, CLIENT_YC_ID]);
  check('(ж) у тестового клиента есть состоявшиеся прошлые визиты (иначе проверка ничего не доказывает)', past && past.n > 0, `${past && past.n} шт.`);
  check('(ж) за весь прогон ни одного задания first_visit по записи (ни pending, ни skipped)', ofType(jobs, 'first_visit').length === 0);
  check('(ж) за весь прогон ни одного опроса/рекомендации (никто не «пришёл»)', ofType(jobs, 'visit_review').length === 0 && ofType(jobs, 'visit_after').length === 0);

  console.log('\nпоследний срез заданий по записи:');
  for (const j of jobs) console.log('   ' + fmtJob(j));

  // ── (з) «пришёл»: синтетическое событие ──
  section('(з) «пришёл» (синтетическое событие, YClients не трогаем): опрос и рекомендации после конца визита');
  const LEN = 1800;
  const startMs = Math.floor((Date.now() - 5 * 60 * 1000) / 60000) * 60000;     // визит идёт 5 минут, до конца 25
  const arrivedEvent = (idx) => {
    const id = 9100000000 + (Date.now() % 100000000) * 10 + idx;
    extraRecordIds.push(id);
    const m = msk(startMs);
    return { id, datetime: `${m.ymd}T${m.time}:00+03:00`, date: `${m.ymd} ${m.time}:00`, seance_length: LEN, length: LEN, attendance: 1, deleted: false,
      staff_id: STAFF, staff: { id: STAFF, name: 'Богатырева Татьяна' }, services: [{ id: SERVICE, title: 'Малая зона (синтетика)' }],
      client: { id: CLIENT_YC_ID, name: 'Зумрудин', phone: '+79200255591' }, short_link: 'https://example.invalid/arrived' };
  };
  const arr1 = arrivedEvent(1);
  await feed('update', arr1);
  let jArr = await jobsOf(arr1.id);
  const review1 = ofType(jArr, 'visit_review');
  const after1 = ofType(jArr, 'visit_after');
  check('(з) опрос: одно pending-задание на конец визита + 5 мин',
    review1.length === 1 && review1[0].status === 'pending' && review1[0].sched_ms === startMs + LEN * 1000 + 5 * 60 * 1000,
    review1[0] && fmtJob(review1[0]));
  check('(з) рекомендации: одно pending-задание на конец визита + 7 мин',
    after1.length === 1 && after1[0].status === 'pending' && after1[0].sched_ms === startMs + LEN * 1000 + 7 * 60 * 1000,
    after1[0] && fmtJob(after1[0]));
  check('(з) «пришёл» не порождает ни «записан», ни напоминания, ни отмены',
    ['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'first_visit'].every((t) => ofType(jArr, t).length === 0));
  await feed('update', arr1);
  jArr = await jobsOf(arr1.id);
  check('(з) повтор того же события («пришёл» уже учтён) заданий не добавляет', jArr.length === 2, jArr.map(fmtJob).join('; '));
  const arr2 = arrivedEvent(2);
  await feed('update', arr2);
  jArr = await jobsOf(arr2.id);
  const review2 = ofType(jArr, 'visit_review');
  check('(з) второй визит клиента: опрос пропущен строкой skipped «опрос уже был за 30 дней»',
    review2.length === 1 && review2[0].status === 'skipped' && /опрос уже был за 30 дней/.test(review2[0].decision_reason || ''), review2[0] && fmtJob(review2[0]));
  check('(з) рекомендации по второму визиту встали (повторного запрета у них нет)', ofType(jArr, 'visit_after').length === 1 && ofType(jArr, 'visit_after')[0].status === 'pending');
}

// ── уборка и сверка ──────────────────────────────────────────
async function cleanup(ops) {
  section('уборка');
  for (const id of [...recordIds]) {
    try {
      let gone = await ops.isGone(id).catch(() => false);
      if (!gone) {
        try { await ops.remove({ id }); } catch (e) { console.log(`  запись ${id}: DELETE не прошёл (${e.message})`); }
        gone = await ops.isGone(id).catch(() => false);
      }
      if (!gone) {
        const full = ops.live ? await require('../services/yclients-records').ycGetRecord(salon, id).catch(() => null) : null;
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
  const dbIds = [...recordIds, ...extraRecordIds];
  const delJobs = await db.query(
    'DELETE FROM notification_jobs WHERE salon_id = $1 AND (rule_id = ANY($2::int[]) OR yclients_record_id = ANY($3::bigint[])) RETURNING id', [SALON, ruleIds, dbIds]);
  const delState = await db.query('DELETE FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = ANY($2::bigint[]) RETURNING yclients_record_id', [SALON, dbIds]);
  const delRules = await db.query('DELETE FROM notification_rules WHERE salon_id = $1 AND id = ANY($2::int[]) RETURNING id', [SALON, ruleIds]);
  console.log(`  удалено: заданий ${delJobs.rowCount}, состояний записей ${delState.rowCount}, правил ${delRules.rowCount}`);
}

async function residue(settingsBefore) {
  section('следов в БД нет');
  const q = async (sql, p) => Number((await db.oneOrNone(sql, p)).n);
  check('правил прогона в БД нет', (await q('SELECT count(*)::int AS n FROM notification_rules WHERE salon_id = $1 AND (id = ANY($2::int[]) OR title LIKE $3)', [SALON, ruleIds, 'E2E-живой прогон%'])) === 0);
  const dbIds = [...recordIds, ...extraRecordIds];
  check('заданий по правилам/записям прогона в БД нет', (await q('SELECT count(*)::int AS n FROM notification_jobs WHERE salon_id = $1 AND (rule_id = ANY($2::int[]) OR yclients_record_id = ANY($3::bigint[]))', [SALON, ruleIds, dbIds])) === 0);
  check('состояний записей прогона в БД нет', (await q('SELECT count(*)::int AS n FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = ANY($2::bigint[])', [SALON, dbIds])) === 0);
  const after = await db.oneOrNone('SELECT mode, updated_at FROM notification_settings WHERE salon_id = $1', [SALON]);
  const same = (!settingsBefore && !after) || (settingsBefore && after && settingsBefore.mode === after.mode
    && new Date(settingsBefore.updated_at).getTime() === new Date(after.updated_at).getTime());
  check('notification_settings не изменялась (режим и updated_at прежние)', same, after ? `${after.mode} ${new Date(after.updated_at).toISOString()}` : 'строки нет');
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
  const settingsBefore = await db.oneOrNone('SELECT mode, updated_at FROM notification_settings WHERE salon_id = $1', [SALON]);
  const modeInDb = settingsBefore ? settingsBefore.mode : 'off';
  if (modeInDb !== 'off') {
    console.error(`ОТКАЗ: режим уведомлений салона ${SALON} в БД — «${modeInDb}», а не off. Дев получает настоящие вебхуки клиники; скрипт работает только при off.`);
    process.exit(2);
  }
  const ops = SYNTHETIC ? syntheticOps() : liveOps();
  activeOps = ops;
  console.log(`салон #${salon.id} «${salon.name}», тестовый клиент ${PHONE} (YClients ${CLIENT_YC_ID}); режим в БД: ${modeInDb} (подменён в процессе на live); записи: ${ops.name}`);

  let crashed = null;
  try {
    await createRules();
    await scenarios(ops);
  } catch (e) {
    crashed = e;
    nFail += 1;
    console.log(`  FAIL  сценарий прерван исключением  ← ${e.stack || e.message}`);
  } finally {
    try { await cleanup(ops); } catch (e) { nFail += 1; console.log(`  FAIL  уборка упала  ← ${e.stack || e.message}`); }
    try { await residue(settingsBefore); } catch (e) { nFail += 1; console.log(`  FAIL  сверка следов упала  ← ${e.message}`); }
  }
  console.log(`\nИТОГ: PASS ${nPass} / FAIL ${nFail}${crashed ? ' (сценарий прерван)' : ''}`);
  return nFail === 0 ? 0 : 1;
}

main().then(async (code) => { await pool.end().catch(() => {}); process.exit(code); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
