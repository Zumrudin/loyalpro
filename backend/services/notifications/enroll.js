'use strict';
// ============================================================
// handleRecordEvent(salon, payload, nowMs) — зовётся из routes/webhook.js на
// КАЖДОМ record-событии YClients. Обновляет notification_record_state, по
// разнице со старым состоянием классифицирует событие и ставит job'ы по
// совпавшим правилам. Пропуски (нет телефона, ЧС, недоступный каталог) — строки
// skipped с причиной: «почему не пришло» разбирается по журналу. Запись, созданную
// Милой, пропуском НЕ является: «Вы записаны» уходит и по ней (решение владельца
// 14.10.2026). Режим off (и любой неизвестный — 'Live', 'on', пусто) → только
// состояние: нужно, чтобы при включении shadow/live перенос и «пришёл» распознавались
// сразу, а не с первого события после включения. Режим — строка в БД, и опечатка
// не должна молча включать боевую отправку: сверка идёт с 'shadow' и 'live' целиком.
// В режиме off не читаются даже правила, а каталог услуг YClients не запрашивается вовсе
// (внешний HTTP под общим лимитом YClients, сбой не кэшируется): он нужен только в shadow/live
// и только если среди включённых правил есть условие по категории и у записи есть услуги.
// Настройки (кэш 30 с) и правила читаются ДО замка — по ним решается, нужен ли каталог.
//
// ПОЗДНИЙ create. create при уже известном состоянии записи — это либо update, опередивший
// create (3 записи из 1 363, на 14–411 мс), либо поздний дубль, и его снимок несёт данные момента
// создания. Состояние по нему НЕ перезаписывается, а из видов события остаётся только created
// (events.isLateCreate): «Вы записаны» и напоминание ставятся (дубли режет ключ job'а), а то, что
// случилось с записью после создания — отмена, перенос, приход, — остаётся в состоянии, и воркер,
// сверяющийся именно с ним, гасит устаревшие job'ы. Иначе дубль возвращал бы из отмены, гасил
// неушедшее письмо об отмене и откатывал состояние на «живая» — а воркеру сверяться стало бы не с чем.
//
// БЛОКИРОВКА ПО КЛИЕНТУ. YClients отмечает «пришёл» по всем записям визита за
// миллисекунды; без сериализации два вебхука одного клиента одновременно проходят
// проверки «опрос/приглашение уже были» (оба видят пусто) и оба ставят строку.
// Работа с записью идёт под pg_advisory_lock на ВЫДЕЛЕННОМ соединении пула (замок
// сессионный, как в loyalty.withRecordLock). Ключ — (салон, клиент YClients || телефон);
// пространство отдельное — двухкличевая форма (NOTIFY_LOCK_NS, hashtext(ключ)), а замки
// кэшбэка однокличевые, пересечься не могут. Ни id, ни телефона — без блокировки.
// Не удалось ВЗЯТЬ замок — обрабатываем без него (потерянное «Вы записаны» хуже редкого
// дубля, а ключ job'а дубли тоже режет); не удалось ОТПУСТИТЬ — соединение уничтожается,
// вместе с ним уходит и замок. «Замок = соединение пула» даёт три следствия, от которых защищаемся:
//  • внешний HTTP (каталог услуг YClients, таймаут 30 с без повторов) выполняется ДО замка, а не под
//    ним — иначе при лимите YClients вебхуки держали бы соединения по полминуты;
//  • одновременно под замками не больше LOCK_SLOTS вебхуков: каждому нужно соединение под замок и ещё
//    одно для запросов, и пачка вебхуков РАЗНЫХ клиентов (массовый перенос записей) без предела заняла бы
//    все 10 соединений пула замками — работать было бы нечем, встало бы и остальное приложение. Ожидание
//    места не дольше SLOT_WAIT_MS (30 с), дальше — обработка без замка и WARN;
//  • ожидающий замка вебхук держит соединение, а держатель может застрять: перед pg_advisory_lock на
//    выделенном соединении выставляется SET lock_timeout = '15s' (на advisory lock он распространяется),
//    после взятия замка — RESET (соединение вернётся в общий пул). Тайм-аут (55P03) → обработка без
//    замка и WARN, соединение отдаётся пулу сразу, до работы.
//
// ПАРИТЕТ С YCLIENTS/CHATPUSH (классификатор сверен с 8 634 реальными вебхуками и
// тем, что Chatpush реально отправил). Отступать от этих правил — значит слать
// клиентам письма, которых раньше не было:
//  • Мгновенные record_created / record_rescheduled / record_cancelled — только про
//    БУДУЩИЙ визит (visitAt > now). Запись задним числом и после начала визита
//    Chatpush не уведомляет (администратор вносит уже состоявшееся).
//  • record_cancelled шлётся ТОЛЬКО на отметку «клиент не придёт» (attendance -1) до
//    начала визита. on_no_show = «слать, когда поставили «клиент не придёт» до начала
//    визита; удаление не уведомляет — как YClients» (у Chatpush 0 писем «отменена» на
//    58 удалений). Запланированное (pending) гасится при ЛЮБОЙ отмене, письмо или нет;
//    возврат записи (restored) гасит ещё и не ушедшее письмо об отмене («не придёт» и
//    возврат через 5 с иначе оставляли его в очереди).
//  • Возврат из отмены (restored) и перенос туда-обратно (A→B→A) возвращают
//    напоминание: ключ job'а (правило, запись, момент визита) у A уже занят погашенной
//    строкой, и insertJob её ОЖИВЛЯЕТ (ON CONFLICT … DO UPDATE … WHERE status='cancelled').
//    Строки в другом статусе (sent/pending/shadow/…) не трогаются — дубля не будет.
//  • visit_review — не чаще раза в 30 дней на телефон (иначе несколько записей одного
//    дня дают несколько опросов): повтор ложится строкой skipped с причиной.
//  • visit_review и visit_after — только про СВЕЖИЙ визит: «пришёл», внесённый задним числом
//    (прошло больше 12 ч после конца визита), опроса не порождает — на retro-«пришёл» Chatpush
//    не ответил ни разу.
//  • first_visit — приглашение в лояльность — ставится при СОЗДАНИИ записи клиенту без прошлых
//    визитов, а не на «пришёл». Данные: Chatpush шлёт его через секунды после create (85 из 92
//    за 2 минуты) клиенту без визитов и не шлёт клиентам с визитами (0 из 776). Привязка к
//    «пришёл» (как было в плане) опаздывала бы на часы и дни и не доходила бы до записавшихся,
//    которые так и не пришли. Это промо, не транзакционное письмо: ночью (тихие часы) не шлём.
//    Не чаще раза на телефон: повтор ложится строкой skipped.
//
// ДОГОН (backfillReminders, разово: scripts/notifications-backfill-reminders.js). visit_reminder ставится на
// create/перенос/возврат, а записи в клинике делают на недели вперёд: без догона визиты, записанные ДО включения
// модуля, остались бы без нашего напоминания после ухода Chatpush. Правила те же, что у вебхука, — но без
// «пропущенных» строк в журнале (их были бы сотни): только visit_reminder; визит в будущем; не отменён (attendance -1 /
// deleted) и не подтверждён (attendance 2 — по подтверждённым напоминаний нет, воркер всё равно погасил бы такую
// строку); момент — reminderAt (hours_before правила, sms_before записи игнорируется, тихие часы); условия правила и
// чёрный список как у enroll. Три отличия от вебхука, и все про то, что выгрузка /records — не событие:
//  • состояние записи пишется ТОЛЬКО если строки ещё нет (DO NOTHING): выгрузка снята в какой-то момент, вебхуки идут
//    непрерывно, и перезапись откатила бы более свежее состояние. Писать его всё же нужно — без него перенос записи,
//    созданной до выката, не распознался бы (prev = null) и клиент остался бы без напоминания на новое время;
//  • погашенный job НЕ оживляется (reviveCancelled:false): «добавить недостающее», а не «восстановить» — иначе повторный
//    запуск вернул бы напоминание, отменённое администратором;
//  • каталог категорий недоступен, а у правила условие по категории → исключение ДО записи: вебхук в этом случае пишет
//    skipped с причиной, а для пачки это были бы сотни запертых ключей (повторный запуск их уже не поставит).
// ============================================================
const { db, pool } = require('../../db');
const { createLogger } = require('../../logger');
const settingsSvc = require('./settings');
const ev = require('./events');
const { evaluateRule, getServiceCategoryMap } = require('./rules');
const { renderTemplate, buildRenderCtx } = require('./render');
const salonNames = require('../../utils/salon-names');

const log = createLogger('NotifyEnroll');

// Опрос и рекомендации — не позже этого срока после КОНЦА визита (начало + длительность).
const AFTER_VISIT_MAX_AGE_MS = 12 * 3600 * 1000;
// Первый ключ двухкличевого advisory lock ('NOTF'). Не salon_id (agent/booking.js берёт пару
// (salon_id, хэш диалога)) и не ключ миграции вердиктов (1280266064).
const NOTIFY_LOCK_NS = 1313821766;
// Предел одновременных обработчиков под замком (3 замка + до 3 рабочих соединений из 10 в пуле).
const LOCK_SLOTS = 3;
let slotsBusy = 0;
const slotQueue = [];
// Сколько ждать места под замок; не дождались — работаем без замка (WARN).
const SLOT_WAIT_MS = 30 * 1000;
// Сколько ждать сам замок на выделенном соединении (SET lock_timeout); не дождались — работаем без замка (WARN).
const LOCK_TIMEOUT_MS = 15 * 1000;
const LOCK_NOT_AVAILABLE = '55P03';   // SQLSTATE lock_not_available — «canceling statement due to lock timeout»

const STALE_VISIT_REASON = 'визит завершился более 12 ч назад (внесён задним числом)';
const REVIEW_REPEAT_REASON = 'опрос уже был за 30 дней';
const INVITE_REPEAT_REASON = 'приглашение уже отправлялось';
const CATALOG_REASON = 'каталог услуг YClients недоступен';

async function loadState(salonId, recordId) {
  const row = await db.oneOrNone(
    'SELECT * FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = $2', [salonId, recordId]);
  if (!row) return null;
  return { ...row, visitAt: row.visit_datetime ? new Date(row.visit_datetime).getTime() : null };
}

const STATE_OVERWRITE_SQL = `DO UPDATE SET visit_datetime=EXCLUDED.visit_datetime,
        seance_length=EXCLUDED.seance_length, attendance=EXCLUDED.attendance, deleted=EXCLUDED.deleted,
        services=EXCLUDED.services, staff_id=EXCLUDED.staff_id, client_yc_id=EXCLUDED.client_yc_id,
        phone=COALESCE(EXCLUDED.phone, notification_record_state.phone), created_user_id=EXCLUDED.created_user_id, updated_at=NOW()`;

/**
 * Состояние записи. onlyIfAbsent — для догона (backfillReminders): строка, которая уже есть, НЕ трогается.
 * Выгрузка /records снята в какой-то момент, а вебхуки идут непрерывно; перезапись из неё откатила бы более
 * свежее состояние (перенос, «не придёт»), и воркер, сверяющийся именно с состоянием, ничего бы уже не поймал.
 * Вебхук, наоборот, всегда перезаписывает: его снимок и есть самое свежее.
 */
async function saveState(salonId, snap, { onlyIfAbsent = false } = {}) {
  await db.query(
    `INSERT INTO notification_record_state (salon_id, yclients_record_id, visit_datetime, seance_length, attendance, deleted,
        services, staff_id, client_yc_id, phone, created_user_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,NOW())
     ON CONFLICT (salon_id, yclients_record_id) ${onlyIfAbsent ? 'DO NOTHING' : STATE_OVERWRITE_SQL}`,
    [salonId, snap.recordId, snap.visitAt != null ? new Date(snap.visitAt) : null, snap.seanceLength, snap.attendance,
     snap.deleted, JSON.stringify(snap.services), snap.staffId, snap.clientYcId, snap.phone, snap.createdUserId]);
}

async function cancelPending(salonId, recordId, reason, onlyTypes = null) {
  const res = await db.query(
    `UPDATE notification_jobs SET status='cancelled', decision_reason=$3
      WHERE salon_id=$1 AND yclients_record_id=$2 AND status='pending'
        AND ($4::text[] IS NULL OR trigger_type = ANY($4::text[]))`,
    [salonId, recordId, reason, onlyTypes]);
  return res.rowCount || 0;
}

const REVIVE_CANCELLED_SQL = `DO UPDATE SET status=EXCLUDED.status, scheduled_at=EXCLUDED.scheduled_at, rendered_text=EXCLUDED.rendered_text,
        meta=EXCLUDED.meta, decision_reason=EXCLUDED.decision_reason, phone=EXCLUDED.phone,
        rule_title=EXCLUDED.rule_title, client_id=EXCLUDED.client_id, attachment_url=EXCLUDED.attachment_url,
        attempts=0, error=NULL, last_attempt_at=NULL, routing=NULL, cascade_pos=0, cascade_log='[]'::jsonb,
        sent_at=NULL, channel_used=NULL, delivery_id=NULL, account_id=NULL, check_at=NULL, confirmed_at=NULL,
        created_at=NOW()
     WHERE notification_jobs.status='cancelled'`;

/**
 * Один job на (правило, запись, момент визита). Повтор вебхука — тот же ключ: если строка в
 * работе или уже обработана, ничего не меняется; если она ПОГАШЕНА (перенос, отмена «не придёт»
 * и возврат), её оживляем свежими значениями — иначе перенос A→B→A оставил бы визит A без
 * напоминания (ключ A занят погашенной строкой). Сбрасываем аренду, каскад, счётчики попыток и
 * следы отправки/сверки: оживший job не должен выглядеть отправленным или уже сверенным.
 * Порядок параметров — контракт с тестами и backfillReminders.
 * extra.reviveCancelled === false (догон) — погашенную строку НЕ оживлять: ключ занят — значит ничего не делаем.
 * Догон — «добавить недостающее», а не «восстановить»; оживление погашенного там вернуло бы напоминание,
 * которое администратор отменил руками («отменено администратором»), при повторном запуске скрипта.
 */
async function insertJob(salonId, rule, snap, client, scheduledMs, text, extra = {}) {
  const res = await db.query(
    `INSERT INTO notification_jobs (salon_id, rule_id, trigger_type, rule_title, yclients_record_id, visit_datetime, scheduled_at,
        client_id, rendered_text, status, phone, attachment_url, meta, decision_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     ON CONFLICT (rule_id, yclients_record_id, COALESCE(visit_datetime, 'epoch'::timestamptz))
     ${extra.reviveCancelled === false ? 'DO NOTHING' : REVIVE_CANCELLED_SQL}`,
    [salonId, rule.id, rule.trigger_type, rule.title, snap.recordId,
     snap.visitAt != null ? new Date(snap.visitAt) : null, new Date(scheduledMs),
     client ? client.id : null, text, extra.status || 'pending', snap.phone, rule.attachment_url || null,
     JSON.stringify({ askConfirmation: !!rule.ask_confirmation, ...(extra.meta || {}) }),
     extra.reason || null]);
  if (res.rowCount) log.info(`job ${rule.trigger_type} rule=${rule.id} record=${snap.recordId} → ${extra.status || 'pending'}${extra.reason ? ': ' + extra.reason : ''}`);
  return res.rowCount || 0;
}

/**
 * Сколько состоявшихся визитов у клиента YClients (arrived/completed — 'completed' это status_id 4,
 * как в refreshLastVisitAt), не считая самой записи. Клиент берётся из вебхука, а не из нашей
 * таблицы clients: у новичка строки там может ещё не быть, а у постоянного — не хватать из-за сбоя
 * синка, и по clients.id приглашение ушло бы не тому. Индекс — idx_records_salon_yc_client.
 * Нет id клиента → истории не узнать, считаем 0 (повтор ограничит «раз на телефон»).
 */
async function pastVisitsCount(salonId, clientYcId, recordId) {
  if (clientYcId == null) return 0;
  const row = await db.oneOrNone(
    `SELECT count(*)::int AS n FROM records
      WHERE salon_id = $1 AND yclients_client_id = $2 AND status IN ('arrived','completed')
        AND yclients_record_id <> $3`,
    [salonId, clientYcId, recordId]);
  return row ? Number(row.n) : 0;
}

/** Был ли этому телефону опрос (в работе, отправленный или теневой) за последние 30 дней. */
async function recentReviewExists(salonId, phone) {
  const row = await db.oneOrNone(
    `SELECT 1 AS hit FROM notification_jobs
      WHERE salon_id = $1 AND phone = $2 AND trigger_type = 'visit_review'
        AND status IN ('pending','sent','shadow')
        AND created_at > NOW() - INTERVAL '30 days'
      LIMIT 1`,
    [salonId, phone]);
  return !!row;
}

/** Приглашали ли этот телефон в программу лояльности (в работе, отправлено или теневое) — без срока давности. */
async function inviteAlreadySent(salonId, phone) {
  const row = await db.oneOrNone(
    `SELECT 1 AS hit FROM notification_jobs
      WHERE salon_id = $1 AND phone = $2 AND trigger_type = 'first_visit'
        AND status IN ('pending','sent','shadow')
      LIMIT 1`,
    [salonId, phone]);
  return !!row;
}

// 0 — законное значение (валидация правила 0..1440), поэтому `|| 5` нельзя: он превращал 0 в 5.
const delayOf = (rule, dflt) => (rule.delay_minutes == null ? dflt : rule.delay_minutes);

// ── условия правила при возможно недоступном каталоге услуг ──
// Категорий в вебхуке нет, их даёт каталог YClients (rules.getServiceCategoryMap). При сбое он отдаёт ПУСТУЮ
// карту (и не кэширует её), и «категория не совпала» становится неотличимой от «каталога нет». Поэтому
// правило оценивается дважды: как есть (категория без каталога — ложь) и с обезвреженными категориями
// (ids: [] не ограничивает). Истина в первом — правило подходит при любом каталоге; ложь во втором — не
// подходит при любом; между ними исход зависит от каталога, и это skipped с причиной, а не молчание.
const YES = 'yes';
const NO = 'no';
const NEEDS_CATALOG = 'catalog';
const hasCategoryCondition = (c) => !!c && Array.isArray(c.items)
  && c.items.some((it) => it && it.type === 'category' && Array.isArray(it.ids) && it.ids.length > 0);
const neutralizeCategories = (c) => ({ ...c, items: c.items.map((it) => (it && it.type === 'category' ? { ...it, ids: [] } : it)) });

// Ожидание места под замок: true — место получено (его надо вернуть freeSlot), false — не дождались за SLOT_WAIT_MS
// и в очереди не остались (место ушедшему не передаётся, учёт мест не страдает).
function takeSlot() {
  if (slotsBusy < LOCK_SLOTS) { slotsBusy += 1; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const waiter = {};
    waiter.grant = () => { clearTimeout(waiter.timer); resolve(true); };   // место передаётся целиком (slotsBusy не меняется)
    waiter.timer = setTimeout(() => {
      const i = slotQueue.indexOf(waiter);
      if (i !== -1) slotQueue.splice(i, 1);
      resolve(false);
    }, SLOT_WAIT_MS);
    if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
    slotQueue.push(waiter);
  });
}
function freeSlot() {
  const next = slotQueue.shift();
  if (next) next.grant(); else slotsBusy -= 1;
}

// Настройки и правила нужны ДО замка, поэтому «режим включён» проверяется в двух местах одним предикатом.
const isActiveMode = (cfg) => !!cfg && (cfg.mode === 'shadow' || cfg.mode === 'live');

/**
 * Каталог услуг YClients для оценки условий по категориям: { map, down }. Запрашивается ДО замка и только
 * по нужде: среди включённых правил есть условие по категории И у записи есть услуги (в режиме off правила
 * не читаются вовсе, и каталога нет). Пустая карта — сбой (rules.getServiceCategoryMap при ошибке YClients
 * отдаёт пустую и не кэширует её), а не «категорий нет»; бросок трактуется так же.
 */
async function loadCatalog(salon, snap, rules) {
  if (!snap.services.length || !rules.some((r) => hasCategoryCondition(r.conditions))) return { map: new Map(), down: false };
  try {
    const map = await getServiceCategoryMap(salon);
    if (map instanceof Map && map.size > 0) return { map, down: false };
  } catch (e) { log.warn(`каталог услуг: ${e.message}`); }
  return { map: new Map(), down: true };
}

/**
 * Выполняет fn под сессионным advisory lock клиента. who === null → без блокировки.
 * Замок держит ВЫДЕЛЕННОЕ соединение: через db.query (пул) он отпустился бы вместе с соединением
 * ещё до начала работы. Места под замок и сам замок ждём ограниченно, не дождались — fn без замка.
 */
async function withClientLock(salonId, who, fn) {
  if (!who) return fn();
  if (!(await takeSlot())) {
    log.warn(`блокировка клиента ${salonId}:${who}: нет места под замок за ${SLOT_WAIT_MS / 1000} с — обрабатываем без неё`);
    return fn();
  }
  try {
    return await lockedRun(salonId, who, fn);
  } finally {
    freeSlot();
  }
}

async function lockedRun(salonId, who, fn) {
  const args = [NOTIFY_LOCK_NS, `${salonId}:${who}`];
  let lockClient = null;
  let held = false;
  let destroy = false;
  try {
    lockClient = await pool.connect();
    // Ожидание замка ограничено на самом выделенном соединении: застрявший держатель не должен держать пул
    // (ожидающий вебхук занимает соединение). lock_timeout распространяется и на advisory lock.
    await lockClient.query(`SET lock_timeout = '${LOCK_TIMEOUT_MS / 1000}s'`);
    await lockClient.query('SELECT pg_advisory_lock($1, hashtext($2))', args);
    held = true;
  } catch (e) {
    if (e && e.code === LOCK_NOT_AVAILABLE) {
      log.warn(`блокировка клиента ${args[1]} не получена за ${LOCK_TIMEOUT_MS / 1000} с — обрабатываем без неё`);
    } else {
      destroy = true;     // состояние соединения неизвестно (запрос на замок мог остаться висеть на сервере)
      log.warn(`блокировка клиента ${args[1]} не взята (${e && e.message}) — обрабатываем без неё`);
    }
  }
  if (lockClient) {
    // Сброс — ВСЕГДА, и при успехе, и при тайм-ауте: соединение вернётся в общий пул, и чужие запросы
    // не должны унаследовать наш лимит. Не удалось сбросить — соединение выбрасываем.
    try {
      await lockClient.query('RESET lock_timeout');
    } catch (e) {
      destroy = true;
      log.warn(`сброс lock_timeout не удался (${e && e.message}) — соединение закрываем`);
    }
  }
  if (!held) {
    // Замка нет — соединение ни к чему: отдаём пулу ДО работы, обработке оно нужнее держателя-неудачника.
    if (lockClient) lockClient.release(destroy ? new Error('advisory lock failed') : undefined);
    return fn();
  }
  try {
    return await fn();
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2))', args);
    } catch (e) {
      destroy = true; // замок сессионный: закрытие соединения снимает его на стороне сервера
      log.warn(`блокировка клиента ${args[1]} не отпущена (${e && e.message}) — соединение закрываем`);
    }
    lockClient.release(destroy ? new Error('advisory lock cleanup failed') : undefined);
  }
}

async function handleRecordEvent(salon, payload, nowMs) {
  const snap = ev.recordSnapshot(payload);
  if (!Number.isInteger(snap.recordId)) return;
  const salonId = salon.id;
  const who = snap.clientYcId != null ? `c${snap.clientYcId}` : (snap.phone ? `p${snap.phone}` : null);
  // ДО замка: настройки (кэш 30 с), правила и каталог услуг — внешний HTTP не должен держать соединение пула,
  // а в режиме off не нужны ни правила, ни каталог.
  const cfg = await settingsSvc.getSettings(salonId);
  const rules = isActiveMode(cfg)
    ? await db.any('SELECT * FROM notification_rules WHERE salon_id = $1 AND is_enabled = TRUE', [salonId])
    : [];
  const catalog = await loadCatalog(salon, snap, rules);
  // «Сейчас» берём уже ПОД замком: ожидание очереди могло занять время.
  return withClientLock(salonId, who, () => enrollEvent(salon, snap, Number.isFinite(nowMs) ? nowMs : Date.now(), { cfg, rules, catalog }));
}

async function enrollEvent(salon, snap, now, { cfg, rules, catalog }) {
  const salonId = salon.id;
  const prev = await loadState(salonId, snap.recordId);
  const kinds = ev.classifyRecordEvent(prev, snap);
  // Поздний create (состояние уже есть) несёт старые данные — состояние по нему не перезаписываем.
  if (!ev.isLateCreate(prev, snap)) await saveState(salonId, snap);

  if (!isActiveMode(cfg)) return;

  // Отмена/перенос гасят запланированное ВСЕГДА, даже без правил на эти события и даже когда
  // письма об отмене не будет (удаление записи). При переносе гасится только напоминание: приглашение
  // новому клиенту привязано к созданию записи, а не ко времени визита.
  if (kinds.cancelled) await cancelPending(salonId, snap.recordId, 'запись отменена');
  if (kinds.rescheduled) await cancelPending(salonId, snap.recordId, 'запись перенесена', ['visit_reminder']);
  if (kinds.restored) await cancelPending(salonId, snap.recordId, 'запись восстановлена', ['record_cancelled']);

  if (!rules.length) return;

  const catalogDown = catalog.down;
  const serviceIds = snap.services.map((s) => s.id);
  const ctx = { staffId: snap.staffId, serviceIds,
    categoryIds: [...new Set(serviceIds.map((id) => catalog.map.get(String(id))).filter(Boolean))] };
  const judge = (rule) => {
    try {
      if (evaluateRule(rule.conditions, ctx)) return YES;
      if (catalogDown && hasCategoryCondition(rule.conditions) && evaluateRule(neutralizeCategories(rule.conditions), ctx)) return NEEDS_CATALOG;
      return NO;
    } catch (e) { log.warn(`rule #${rule.id}: ${e.message}`); return NO; }
  };

  const client = snap.clientYcId ? await db.oneOrNone(
    'SELECT id, name, is_blacklisted FROM clients WHERE salon_id = $1 AND yclients_client_id = $2', [salonId, snap.clientYcId]) : null;
  const renderCtx = buildRenderCtx(snap, salon, client, { nameDictionary: await salonNames.load(salonId).catch(() => null) });

  // Мгновенные письма — только про будущий визит (паритет с Chatpush, см. шапку).
  const visitAhead = snap.visitAt != null && snap.visitAt > now;
  // Опрос и рекомендации — только про свежий визит. Момент визита не разобран → свежесть не проверить,
  // ставим как раньше.
  const visitEnd = snap.visitAt != null ? snap.visitAt + snap.seanceLength * 1000 : null;
  const visitStale = visitEnd != null && now - visitEnd > AFTER_VISIT_MAX_AGE_MS;
  const baseSkipReason = !snap.phone ? 'нет телефона клиента'
    : (client && client.is_blacklisted ? 'клиент в чёрном списке' : null);

  /**
   * Ставит job по правилу. when — момент отправки (мс) или функция (вызывается ПОСЛЕ проверки условий,
   * null → ставить нечего). gate — тихий отсев без строки (false → строки нет вовсе). reason — ленивая
   * причина skipped, спрашивается только если строка ещё не помечена пропуском: дешёвое раньше дорогого
   * (запрос в БД) — чёрный список, каталог, затем специфика типа.
   */
  const fire = async (rule, when, { gate, reason } = {}) => {
    const verdict = judge(rule);
    if (verdict === NO) return;
    const atMs = typeof when === 'function' ? when() : when;
    if (atMs == null) return;
    if (gate && !(await gate())) return;
    const skip = baseSkipReason || (verdict === NEEDS_CATALOG ? CATALOG_REASON : null) || (reason ? await reason() : null);
    const text = renderTemplate(rule.message_template, renderCtx);
    await insertJob(salonId, rule, snap, client, atMs, text, skip ? { status: 'skipped', reason: skip } : {});
  };

  const applyRule = async (rule) => {
    switch (rule.trigger_type) {
      case 'record_created':
        if (kinds.created && visitAhead) await fire(rule, now);
        break;
      case 'record_rescheduled':
        if (kinds.rescheduled && visitAhead) await fire(rule, now);
        break;
      case 'record_cancelled':
        // Удаление записи не уведомляет: noShow = отметка «не придёт» БЕЗ удаления (events.classifyRecordEvent).
        if (kinds.noShow && visitAhead && rule.on_no_show !== false) await fire(rule, now);
        break;
      case 'visit_reminder':
        if (!(kinds.created || kinds.rescheduled || kinds.restored)) break;
        await fire(rule, () => {
          const at = ev.reminderAt(snap, rule, cfg, now);
          if (at == null) log.info(`reminder rule=${rule.id} record=${snap.recordId}: момент уже прошёл — не ставим`);
          return at;
        });
        break;
      case 'visit_review':
        if (!kinds.arrived) break;
        await fire(rule, () => ev.applyQuietHours(ev.afterVisitAt(snap, delayOf(rule, 5), now), cfg), {
          reason: async () => {
            if (visitStale) return STALE_VISIT_REASON;
            return (await recentReviewExists(salonId, snap.phone)) ? REVIEW_REPEAT_REASON : null;
          },
        });
        break;
      case 'visit_after':
        if (!kinds.arrived) break;
        await fire(rule, () => ev.applyQuietHours(ev.afterVisitAt(snap, delayOf(rule, 7), now), cfg), {
          reason: async () => (visitStale ? STALE_VISIT_REASON : null),
        });
        break;
      case 'first_visit':
        if (!(kinds.created && visitAhead)) break;
        await fire(rule, () => ev.applyQuietHours(now, cfg), {
          gate: async () => {
            const n = await pastVisitsCount(salonId, snap.clientYcId, snap.recordId);
            if (n > 0) log.info(`first_visit rule=${rule.id} record=${snap.recordId}: у клиента уже ${n} визит(ов) — приглашения нет`);
            return n === 0;
          },
          reason: async () => ((await inviteAlreadySent(salonId, snap.phone)) ? INVITE_REPEAT_REASON : null),
        });
        break;
      default:
        break;
    }
  };

  // Сбой одного правила (шаблон, БД) не должен лишать остальные правила этого же события:
  // состояние записи уже сохранено, и повторно это событие не придёт.
  for (const rule of rules) {
    try {
      await applyRule(rule);
    } catch (e) {
      log.error(`rule #${rule.id} (${rule.trigger_type}) record=${snap.recordId}: ${e.message}`);
    }
  }
}

/**
 * Догон напоминаний (см. шапку): records — записи YClients в форме элемента GET /records/{cid} (она совпадает с
 * data вебхука). Возвращает счётчики { scanned, eligible, queued, rules, skipped }: rules — сколько включённых правил
 * visit_reminder у салона (0 → догонять нечего, записи даже не разбираются, skipped пуст), eligible — пар «запись × правило»,
 * которым нашлось место в очереди, queued — сколько строк реально легло (повтор даёт 0: ключ занят), skipped — по записям,
 * с причиной (past — визит уже начался/момент не разобран, cancelled, confirmed, noPhone, blacklisted, noRule — условия
 * ни одного правила не совпали, tooSoon — момент напоминания уже прошёл). dryRun ничего не пишет (только читает).
 * Бросает, если каталог категорий нужен и недоступен, и при сбое БД: частично выполненный догон безопасно повторить.
 */
async function backfillReminders(salon, records, nowMs = Date.now(), { dryRun = false } = {}) {
  const salonId = salon.id;
  const list = Array.isArray(records) ? records : [];
  const skipped = { past: 0, cancelled: 0, confirmed: 0, noPhone: 0, blacklisted: 0, noRule: 0, tooSoon: 0 };
  const out = { scanned: list.length, eligible: 0, queued: 0, rules: 0, skipped };
  const cfg = await settingsSvc.getSettings(salonId);
  const rules = await db.any(
    `SELECT * FROM notification_rules WHERE salon_id = $1 AND is_enabled = TRUE AND trigger_type = 'visit_reminder'`, [salonId]);
  out.rules = rules.length;
  if (!rules.length) return out;

  // Каталог категорий — только если он нужен какому-то правилу. Один раз на весь догон (вебхуку он нужен на каждое
  // событие, здесь — на пачку). Недоступный каталог (getServiceCategoryMap отдаёт пустую карту, а не бросает) — стоп.
  let catMap = new Map();
  if (rules.some((r) => hasCategoryCondition(r.conditions))) {
    try { catMap = await getServiceCategoryMap(salon); } catch (e) { log.warn(`каталог услуг: ${e.message}`); }
    if (!(catMap instanceof Map) || catMap.size === 0) {
      throw new Error(`${CATALOG_REASON}: условия правил по категории не проверить, догон остановлен — повторите позже`);
    }
  }
  const nameDictionary = await salonNames.load(salonId).catch(() => null);
  const clients = new Map();   // карточка клиента — один раз на клиента YClients (записей у одного клиента много)

  for (const rec of list) {
    const snap = ev.recordSnapshot({ status: 'update', data: rec });
    if (!Number.isInteger(snap.recordId)) continue;
    if (snap.deleted || snap.attendance === -1) { skipped.cancelled += 1; continue; }
    if (snap.visitAt == null || snap.visitAt <= nowMs) { skipped.past += 1; continue; }
    // Состояние — для ВСЕХ будущих живых записей, и для тех, кому напоминание не положено: перенос такой записи
    // обязан распознаться вебхуком. Строка уже есть — не трогаем (см. шапку).
    if (!dryRun) await saveState(salonId, snap, { onlyIfAbsent: true });
    if (snap.attendance === 2) { skipped.confirmed += 1; continue; }
    if (!snap.phone) { skipped.noPhone += 1; continue; }

    let client = null;
    if (snap.clientYcId != null) {
      if (!clients.has(snap.clientYcId)) {
        clients.set(snap.clientYcId, await db.oneOrNone(
          'SELECT id, name, is_blacklisted FROM clients WHERE salon_id = $1 AND yclients_client_id = $2', [salonId, snap.clientYcId]));
      }
      client = clients.get(snap.clientYcId);
    }
    if (client && client.is_blacklisted) { skipped.blacklisted += 1; continue; }

    const serviceIds = snap.services.map((s) => s.id);
    const ctx = { staffId: snap.staffId, serviceIds,
      categoryIds: [...new Set(serviceIds.map((id) => catMap.get(String(id))).filter(Boolean))] };
    const matched = rules.filter((rule) => {
      try { return evaluateRule(rule.conditions, ctx); } catch (e) { log.warn(`rule #${rule.id}: ${e.message}`); return false; }
    });
    if (!matched.length) { skipped.noRule += 1; continue; }

    const renderCtx = buildRenderCtx(snap, salon, client, { nameDictionary });
    let planned = 0;
    for (const rule of matched) {
      const at = ev.reminderAt(snap, rule, cfg, nowMs);
      if (at == null) continue;
      planned += 1;
      out.eligible += 1;
      if (!dryRun) {
        out.queued += await insertJob(salonId, rule, snap, client, at, renderTemplate(rule.message_template, renderCtx),
          { meta: { backfill: true }, reviveCancelled: false });
      }
    }
    if (!planned) skipped.tooSoon += 1;
  }
  log.info(`догон напоминаний salon=${salonId}${dryRun ? ' (сухой прогон)' : ''}: записей ${out.scanned}, подходят ${out.eligible}, `
    + `поставлено ${out.queued}, пропущено ${JSON.stringify(skipped)}`);
  return out;
}

module.exports = {
  handleRecordEvent, backfillReminders, cancelPending, _loadState: loadState,
  AFTER_VISIT_MAX_AGE_MS, NOTIFY_LOCK_NS, LOCK_SLOTS, SLOT_WAIT_MS, LOCK_TIMEOUT_MS,
};
