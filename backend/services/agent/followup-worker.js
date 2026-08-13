'use strict';
// ============================================================
// Воркер напоминаний Милы о себе («ожидание ответа клиента»).
//
// Пациенту ответила Мила, он замолчал. Через followup_delay1_min минут от
// ЯКОРЯ (момента доставки её реплики) уходит напоминание — текст пишет LLM
// одним проходом БЕЗ инструментов; через followup_delay2_min от ТОГО ЖЕ якоря
// уходит финальный шаблон салона, и строка закрывается.
//
// Аренда due-строк — как в care- и reminders-воркерах (FOR UPDATE SKIP LOCKED
// + attempts при аренде), затем на каждую строку: гейты от дешёвых к дорогим →
// текст → ЗАХВАТ строки → отправка → персист.
//
// Доставка AT-MOST-ONCE: пропущенное напоминание дешевле дубля живому
// пациенту. Отсюда захват (mark-before-send) вплотную перед sendMessage и
// запрет откатывать статус после него (см. catch в processOne).
//
// Все внешние зависимости инжектируются — юнит-тесты без БД и сети.
// Юнит-тесты: agent-followup-worker.test.js
// ============================================================

const config = require('../../config');
const { db: realDb } = require('../../db');
const chatpush = require('../chatpush');
const { persistWhatsappOutgoing } = require('../chat-persist');
const agentSettings = require('../agent-settings');
const { getProvider } = require('./providers');
const history = require('./history');
const pendingReplies = require('./pending-replies');
const replyGuard = require('./reply-guard');
const chatEvents = require('../chat-events');
const authorship = require('../outgoing-authorship');
const notifications = require('../notifications');
const salonNames = require('../../utils/salon-names');
const { DIALOG_KEY_SQL, recipientParams } = require('../chat');
const { stripAllStamps } = require('./transcript-time');
const { parseCareDecision } = require('../care/decision');
const { buildFollowupPrompt } = require('./followup-prompt');
const { hasInventedTime } = require('./followup-guard');
const { resolveDelays, nextAtFor, isTooLate } = require('./followup-schedule');
const { CLOSE_STATUSES } = require('./followup-queue');
const { resolveSalonName } = require('./system-prompt');
const { createLogger } = require('../../logger');

const log = createLogger('FollowupWorker');

const WORKER_TICK_MS = 60000;
const LEASE_LIMIT = 20;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_S = 180;
// Таймаут LLM-прохода: зависший провайдер не должен держать строку
// 'scheduled' вечно. Строго МЕНЬШЕ backoff аренды (тот же запас, что в
// care-/reminders-воркерах) — иначе таймаут-ретрай пересечётся с ещё живым
// прошлым вызовом в окне аренды. Инвариант закреплён тестом, обе константы
// экспортируются ровно ради него.
const LLM_TIMEOUT_MS = 90000;

// На сколько откладывается строка, когда отвечать сейчас НЕЛЬЗЯ, но запрет
// пройдёт сам (аварийный рычаг процесса). Минуты, а не сутки как в «Заботе»:
// вся лестница напоминания измеряется минутами, а суточный сдвиг сделал бы из
// него другой продукт. Терминальный skip тут запрещён — у at-most-once второго
// шанса нет, и рычаг сжигал бы очередь молча.
const DEFER_MINUTES = 15;

// Минимальный зазор между напоминанием и финалом. Оба срока считаются от
// ЯКОРЯ, и момент финала может оказаться уже прошедшим (или почти прошедшим) к
// тому времени, как ушло напоминание — тогда следующий же тик отправил бы
// второе сообщение через минуту после первого. Финал сдвигается вперёд, а не
// отменяется: он короткий и закрывающий, но подряд с напоминанием он выглядит
// спамом.
//
// ЧЕСТНО О ГРАНИЦАХ: это НЕ только про простой процесса (pm2 restart,
// откладывание рычагом). Зажим срабатывает при ЛЮБОЙ конфигурации, где
// delay2 - delay1 < MIN_FINAL_GAP_MIN, а валидация настроек требует лишь
// delay2 > delay1 — то есть законная пара «15 и 17» в штатном прогоне без
// единого сбоя даст финал на ~20-й минуте вместо настроенной 17-й. Салон
// настройку задал, поэтому молча её переопределять нельзя: каждый реальный
// сдвиг пишется в лог (см. место применения).
const MIN_FINAL_GAP_MIN = 5;

// Запасной финальный текст, если салон свой не задал (колонка пустая — это
// штатное состояние: дефолт схемы NULL). Ничего не обещает и никуда не зовёт:
// это точка в разговоре, а не ещё одна попытка продать.
const DEFAULT_FINAL_TEXT =
  'Если появятся вопросы — напишите, будем рады помочь. Хорошего дня!';

const defaultDeps = {
  db: realDb,
  // Аварийные рычаги: env-флаг фичи И глобальный kill-switch агента. Оба
  // означают «сейчас нельзя», а не «этому пациенту нельзя», поэтому строка
  // ОТКЛАДЫВАЕТСЯ (см. DEFER_MINUTES), а не гасится.
  followupEnabled: () => config.AGENT_FOLLOWUP,
  agentGloballyEnabled: () => !!config.CHATPUSH.agentEnabled,
  // БЕЗ ignoreSchedule, и это ОСОЗНАННОЕ расхождение с «Заботой» и плановыми
  // напоминаниями (там ignoreSchedule: true): у них время касания задаёт САМ
  // салон в настройках программы, а здесь его задаёт ход живого разговора.
  // У PERI окно ночное (22:00–09:30): разговор, закончившийся в 09:20, дал бы
  // напоминание в 09:35 — поверх живого администратора, уже вышедшего на смену.
  isAllowed: (salonId, phone) => agentSettings.isAllowed(salonId, phone),
  dialogStatus: async (salonId, dialogKey) => {
    const r = await realDb.oneOrNone(
      `SELECT status FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [salonId, dialogKey]);
    return r ? r.status : null;
  },
  // ФИНАЛЬНЫЙ рубеж гонки «клиент ответил ровно в момент отправки»: вебхук
  // гасит строку сам, но между его UPDATE и нашим захватом есть окно.
  //
  // Ключ диалога строится КАНОНИЧЕСКИМ DIALOG_KEY_SQL из services/chat.js —
  // тем же выражением, что в индексе idx_chatpush_messages_dialogkey2 и в
  // routes/chat.js. Своя копия «COALESCE(phone, chat_id)» была бы двойной
  // ошибкой: планировщик не взял бы индекс, а сообщение УЧАСТНИКА группы (в
  // группе Chatpush присылает его личный номер) считалось бы ответом клиента
  // в личном диалоге — ветка 'g:' в каноническом выражении ровно это и
  // разводит.
  //
  // Время сообщения: msg_ts — BIGINT (unix-секунды) и NULLABLE, такие строки
  // на базе есть. COALESCE на created_at повторяет MSG_TS_SQL из history.js:
  // created_at — timestamp WITHOUT time zone, куда NOW() кладёт МОСКОВСКОЕ
  // стенное время, поэтому без AT TIME ZONE сравнение уехало бы на 3 часа.
  // Ошибка в эту сторону («сообщение свежее, чем на самом деле») безопасна:
  // напоминание просто не уйдёт.
  hasIncomingAfter: async (salonId, dialogKey, anchorAt) => {
    const r = await realDb.oneOrNone(
      `SELECT 1 FROM chatpush_messages
        WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2 AND direction = 'incoming'
          AND COALESCE(to_timestamp(msg_ts), created_at AT TIME ZONE 'Europe/Moscow') > $3
        LIMIT 1`,
      [salonId, dialogKey, anchorAt]);
    return !!r;
  },
  loadTranscript: (salonId, key, opts) => history.loadTranscript(salonId, key, opts),
  loadNameDictionary: (salonId) => salonNames.load(salonId).catch(() => null),
  createMessage: (req, opts) => getProvider().createMessage(req, opts),
  lintReply: replyGuard.lintReply,
  hardViolations: replyGuard.hardViolations,
  sendMessage: (payload) => chatpush.sendMessage(config.CHATPUSH.instanceToken, payload),
  lastIncomingChannel: notifications.lastIncomingChannel,
  // Тот же путь, что у реплики диспетчера (services/agent/dispatcher.js send):
  //  • pendingReplies — иначе следующий ход Милы не увидит собственное
  //    напоминание (эхо tdlib/MAX запаздывает на минуты, WhatsApp не шлёт
  //    вовсе) и ответит поверх него заново;
  //  • журнал авторства с 'agent' — иначе собственное эхо прочитается как
  //    ответ живого администратора и поставит диалог на паузу (инцидент
  //    2026-08-04). Здесь именно 'agent', а не 'system' как у плановых
  //    напоминаний: это реплика Милы, а не служебное уведомление.
  rememberPending: async (salonId, key, text) => {
    pendingReplies.remember(salonId, key, text);
    await authorship.remember(salonId, key, text, 'agent');
  },
  persistWhatsapp: (salonId, { delivery, phone, chatId, text }) =>
    persistWhatsappOutgoing(salonId, {
      delivery, phone, chatId, text, msgType: 'text', authoredBy: 'agent',
    }),
  emitStatus: (salonId, key, status, stage) =>
    chatEvents.emitFollowupStatus(salonId, key, status, stage),
  log,
};

// Сторож доставки (services/agent/delivery-watchdog.js) сюда НЕ подключён, и
// это осознанный размен: он умеет ровно два хода — повторить отправку и
// перевести диалог на администратора. Повторять «напоминаю о себе» вдвойне
// навязчиво, а переводить на человека диалог, который клиент просто
// игнорирует, значит создавать салону ложную работу. Потерянное напоминание
// остаётся потерянным; факт виден в логе отправки ниже (delivery=...).

function safeEmit(d, row, status, stage) {
  try { d.emitStatus(row.salon_id, row.dialog_key, status, stage); }
  catch (e) { d.log.warn(`followup #${row.id}: SSE-событие не ушло (${e.message})`); }
}

/**
 * Терминально погасить строку. Статус валидируется по ОБЩЕМУ списку из
 * followup-queue.js: опечатка иначе молча создала бы строку, которую не видит
 * ни чип в «Чате», ни аренда.
 * `AND status='scheduled'` — строку могли погасить вебхуком/оператором прямо
 * во время прогона: воскресить её этот UPDATE не мог бы, но затёр бы чужую
 * причину своей.
 */
async function closeRow(d, row, status, reason) {
  if (!CLOSE_STATUSES.has(status)) throw new Error(`bad status: ${status}`);
  await d.db.query(
    `UPDATE agent_followups SET status=$2, close_reason=$3, updated_at=now()
      WHERE id=$1 AND status='scheduled'`,
    [row.id, status, reason ? String(reason).slice(0, 300) : null]);
  safeEmit(d, row, status, Number(row.stage) || 0);
}

/**
 * Отложить строку. НЕ терминально: строка остаётся scheduled и видна в «Чате».
 * attempts откатывается РОВНО на инкремент аренды (обнуление стирало бы
 * настоящие провалы отправки, а «не трогать» сжигало бы бюджет попыток на
 * откладываниях — тот же расчёт, что в deferRowMinutes воркера напоминаний).
 */
async function deferRow(d, row, minutes, reason) {
  await d.db.query(
    `UPDATE agent_followups
        SET next_at = NOW() + make_interval(mins => $2),
            attempts = GREATEST(attempts - 1, 0), last_attempt_at = NULL,
            close_reason = $3, updated_at = now()
      WHERE id = $1 AND status = 'scheduled'`,
    [row.id, Math.max(1, Math.ceil(Number(minutes) || 1)), reason || null]);
  d.log.info(`followup #${row.id}: отложено на ${minutes} мин (${reason})`);
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms);
      if (t.unref) t.unref();
    }),
  ]);
}

/**
 * Прошлые реплики САМОЙ МИЛЫ одной строкой — единственный источник
 * РАЗРЕШЁННЫХ времён для followup-guard.
 *
 * Строки с OPERATOR_MARK выбрасываются ЦЕЛИКОМ (а не «очищаются» от маркера),
 * и это принципиально: реплика администратора склеена loadTranscript'ом с
 * соседними в ОДИН assistant-блок, поэтому режем ПОСТРОЧНО — выбросить блок
 * целиком значило бы потерять собственные реплики Милы из той же серии.
 * Сообщения клиента (role='user') не попадают сюда по построению. Пусти сюда
 * чужой текст — и время, названное самим пациентом или администратором,
 * легализует что угодно: guard молча станет пустышкой (см. шапку
 * followup-guard.js).
 *
 * stripAllStamps — на случай, если транскрипт когда-нибудь позовут с
 * withTime: метка «[дд.мм чч:мм]» сама содержит HH:MM и разрешала бы время
 * ОТПРАВКИ сообщения (та же чистка, что в оркестраторе).
 */
function ownAssistantText(messages) {
  return stripAllStamps((messages || [])
    .filter((m) => m && m.role === 'assistant')
    .map((m) => String(m.content || '').split('\n')
      .filter((line) => !line.includes(history.OPERATOR_MARK)).join('\n'))
    .join('\n'));
}

/**
 * Текст напоминания (stage 0) через LLM.
 * @returns {{text:string}|{skip:true, reason:string}}
 */
async function buildNudgeText(d, row, messages) {
  const { system, user } = buildFollowupPrompt({
    // Тот же резолвер, что у системного промпта Милы: собственный дефолт
    // разъехался бы с тем, как она называет клинику (готча greeting.js).
    salonName: resolveSalonName(row.salon_name),
    clientName: row.client_name,
    nameDictionary: await d.loadNameDictionary(row.salon_id).catch(() => null),
    // OPERATOR_MARK срезает сам промпт (общий stripOperatorMark) — сюда текст
    // идёт как есть.
    transcript: messages.map((m) => ({
      direction: m.role === 'user' ? 'incoming' : 'outgoing',
      text: m.content,
    })),
  });
  const raw = await withTimeout(
    d.createMessage({ system, messages: [{ role: 'user', content: user }] }, {}),
    LLM_TIMEOUT_MS, 'followup LLM');
  const decision = parseCareDecision(raw && raw.text);
  if (decision.action !== 'send') {
    // Промпт предлагает модели только send/skip, но parseCareDecision — общий
    // разборщик и знает ещё escalate/stop_program. Оба тут означают одно:
    // напоминание не отправляем. Эскалацию по такому ответу НЕ делаем — в
    // диалоге ничего нового не произошло (пациент молчит), а перевод на
    // человека создал бы салону ложную работу.
    if (decision.action === 'escalate' || decision.action === 'stop_program') {
      d.log.warn(`followup #${row.id}: модель вернула ${decision.action} вне контракта промпта (он предлагает только send/skip) — просто молчим`);
    }
    return { skip: true, reason: `llm_skip: ${decision.reason || decision.action}` };
  }
  // Инструментов у прохода нет — ни слотов, ни каталога модель не видела,
  // значит время в тексте она могла только СОЧИНИТЬ (класс инцидента
  // 2026-08-10, alien_time_attribution). Вырезать подстроку нельзя: фраза
  // рвётся и пациент получает огрызок — молчим целиком.
  if (hasInventedTime(decision.text, ownAssistantText(messages))) {
    d.log.warn(`followup #${row.id}: в напоминании время, которого Мила не называла — не отправляем`);
    return { skip: true, reason: 'invented_time' };
  }
  const viol = d.hardViolations(d.lintReply(decision.text, {}));
  if (viol.length) return { skip: true, reason: `reply-guard: ${viol.map((v) => v.type).join(',')}` };
  return { text: decision.text };
}

/**
 * Куда слать. Канал берётся СНИМКОМ из строки (он же был у реплики Милы), а
 * адресация — каноническим recipientParams из services/chat.js: у tdlib без
 * номера получатель адресуется tdlib_user_id, у MAX дублируется max_user_id.
 * Голый `{phone}` (как в автоуведомлениях) для таких диалогов означал бы
 * отправку в никуда. null — слать некуда.
 */
async function resolveRecipient(d, row) {
  const channel = row.channel || await d.lastIncomingChannel(row.salon_id, row.phone).catch(() => null);
  if (!channel) return null;
  return recipientParams(channel, { phone: row.phone, chat_id: row.chat_id });
}

/**
 * Обработать одну арендованную строку. Гейты идут от дешёвых к дорогим:
 * платный LLM-проход стоит ПОСЛЕДНИМ, уже после всех отказных веток.
 */
async function processOne(row, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  let delivered = false;   // сообщение реально ушло клиенту
  let captured = false;    // строка захвачена: откатывать статус нельзя
  let terminal = false;    // терминальный статус уже записан

  const finish = async (status, reason) => {
    await closeRow(d, row, status, reason);
    terminal = true;
  };

  try {
    // ── 1. Аварийные рычаги процесса: откладываем, НЕ гасим ────
    if (!d.followupEnabled()) {
      await deferRow(d, row, DEFER_MINUTES, 'отложено: AGENT_FOLLOWUP выключен');
      return;
    }
    if (!d.agentGloballyEnabled()) {
      await deferRow(d, row, DEFER_MINUTES, 'отложено: агент выключен (env)');
      return;
    }

    // ── 2. Интервалы салона ────────────────────────────────────
    // Строка при нулевом интервале и не заводится вовсе (followup-queue.schedule) —
    // гейт страхует строки, поставленные ДО того, как настройку выключили.
    // Отсутствующая строка agent_settings приходит сюда как NULL-интервалы и
    // даёт ровно тот же исход: «в этом салоне не напоминаем».
    const { enabled, delay1, delay2 } = resolveDelays({
      followupDelay1Min: row.followup_delay1_min,
      followupDelay2Min: row.followup_delay2_min,
    });
    if (!enabled) return finish('cancelled', 'disabled');

    // ── 3. Гейт Милы (окно расписания ДЕЙСТВУЕТ, см. defaultDeps.isAllowed) ──
    // Выпавшее СГОРАЕТ, а не откладывается: напоминание «о себе» через 12
    // часов — это уже другой продукт (для него есть «Забота» и плановые
    // напоминания), а разрыв ≥6 ч включит блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ».
    // Строка остаётся видна администратору в «Чате» — днём диалог подхватит
    // живой человек.
    const gate = await d.isAllowed(row.salon_id, row.phone);
    if (!gate || !gate.allow) {
      const why = gate && gate.reason === 'outside-schedule'
        ? 'outside_window' : `gate_${(gate && gate.reason) || 'unknown'}`;
      return finish('expired', why);
    }

    // ── 4. Верхняя граница суток из настроек салона ────────────
    if (isTooLate(new Date(), row.followup_latest_time)) {
      return finish('expired', 'too_late');
    }

    // ── 5. Диалог ведёт человек ────────────────────────────────
    if (await d.dialogStatus(row.salon_id, row.dialog_key) === 'escalated') {
      return finish('cancelled', 'operator');
    }

    // ── 6. Клиент ответил после якоря ──────────────────────────
    if (await d.hasIncomingAfter(row.salon_id, row.dialog_key, row.anchor_at)) {
      return finish('answered', 'client_replied');
    }

    // Слать некуда (канал не сохранился, у tdlib нет ни номера, ни chat_id) —
    // проверяем ДО платного прохода: исход всё равно предрешён.
    const recipient = await resolveRecipient(d, row);
    if (!recipient) return finish('cancelled', 'no_recipient');

    const isFinal = Number(row.stage) >= 1;
    let text;

    if (isFinal) {
      // Финал — ШАБЛОН салона, без LLM. Дело не в экономии: к 60-й минуте гейт
      // свежести памяти (30 мин) уже погасил показанные времена, и живой
      // проход пересказывал бы то, чего не видит.
      text = String(row.followup_final_text || '').trim() || DEFAULT_FINAL_TEXT;
      // {first_name} — общий рендер шаблонов (одна копия разбора ФИО на весь
      // проект: в карточке лежит «Фамилия Имя Отчество», и без него пациентке
      // ушло бы «Вихарева, …»).
      text = notifications.renderTemplate(text, {
        name: row.client_name,
        nameDictionary: await d.loadNameDictionary(row.salon_id).catch(() => null),
        salon: row.salon_name,
      });
    } else {
      // ── 7. Платный проход — последним ────────────────────────
      // keepTrailingAssistant: транскрипт ОБЯЗАН кончаться репликой Милы — в
      // этом вся посылка напоминания (клиент на неё не ответил). Без флага
      // loadTranscript переносит хвостовой assistant-блок перед последний
      // user-блок (правка для оркестратора — там задержанное эхо читается как
      // ответ на предыдущее сообщение), и модель либо не видит Милину реплику
      // вовсе (leadingClinic), либо читает клиента как уже отвеченного — оба
      // исхода дают systematic skip (см. комментарий у флага в history.js).
      const transcript = await d.loadTranscript(row.salon_id, row.dialog_key,
        { limit: 15, keepTrailingAssistant: true });
      const built = await buildNudgeText(d, row, (transcript && transcript.messages) || []);
      if (built.skip) return finish('cancelled', built.reason);
      text = built.text;
    }

    // ── 8. Захват строки: последний гейт перед side-effect'ом ──
    // Строку могли погасить (клиент ответил, оператор взял диалог) уже после
    // гейтов выше — условие status/stage это ловит. Стадия и срок финала
    // записываются ДО отправки: падение процесса между захватом и sendMessage
    // означает потерянное сообщение, а не дубль.
    let marked;
    if (isFinal) {
      marked = await d.db.query(
        `UPDATE agent_followups
            SET status='done', close_reason='final_sent', final_at=NOW(),
                rendered_text=$2, error=NULL, updated_at=now()
          WHERE id=$1 AND status='scheduled' AND stage>=1`,
        [row.id, text]);
    } else {
      const due = nextAtFor({ anchorAt: row.anchor_at, stage: 1, delay1Min: delay1, delay2Min: delay2 });
      const floor = new Date(Date.now() + MIN_FINAL_GAP_MIN * 60000);
      const clamped = !due || due < floor;
      const finalAt = clamped ? floor : due;
      // Настройку салона (delay2) мы сейчас переопределили — молча этого делать
      // нельзя: при тесной паре интервалов (delay2 - delay1 < 5 мин) сдвиг
      // происходит в КАЖДОМ штатном прогоне, и без лога он не виден нигде.
      if (clamped) {
        const late = due ? Math.round((floor - due) / 60000) : null;
        d.log.info(`followup #${row.id}: финал по настройкам салона пришёлся бы вплотную к напоминанию — сдвинут на ${MIN_FINAL_GAP_MIN} мин вперёд${late === null ? '' : ` (+${late} мин к сроку)`}`);
      }
      marked = await d.db.query(
        `UPDATE agent_followups
            SET stage=1, nudge1_at=NOW(), next_at=$2, rendered_text=$3,
                close_reason=NULL, error=NULL, attempts=0, last_attempt_at=NULL,
                updated_at=now()
          WHERE id=$1 AND status='scheduled' AND stage=0`,
        [row.id, finalAt, text]);
    }
    if (!marked || !marked.rowCount) {
      d.log.info(`followup #${row.id}: строка перехвачена другим исходом — не отправляем`);
      return;
    }
    captured = true;

    // ── 9. Отправка ────────────────────────────────────────────
    const delivery = await d.sendMessage({ text, ...recipient });
    delivered = true;
    // delivery.id в логе ОБЯЗАТЕЛЕН: meta.status=success означает лишь
    // «принято в очередь», и единственный способ узнать судьбу сообщения
    // постфактум — GET /api/v1/delivery/:id (инцидент 2026-08-09). Сторожа
    // доставки у напоминания нет намеренно (см. комментарий выше), поэтому
    // лог здесь — единственный след.
    d.log.info(`followup #${row.id} ${isFinal ? 'final' : 'nudge'} принято в доставку (delivery=${delivery && delivery.id != null ? delivery.id : 'n/a'}): ${String(text).slice(0, 80)}`);

    // Колонок channel_used/delivery_id в agent_followups нет — журнал доставки
    // для напоминаний не заводился (сторожа доставки у них тоже нет, см. выше),
    // и единственный след delivery_id — строка лога выше.
    const channelUsed = (delivery && (delivery.channel || delivery.messenger))
      || (recipient.dispatchRouting || [])[0] || null;

    await d.rememberPending(row.salon_id, row.dialog_key, text)
      .catch((e) => d.log.error(`followup #${row.id}: pending/авторство не записаны (${e.message})`));
    if (channelUsed === 'whatsapp') {
      await d.persistWhatsapp(row.salon_id,
        { delivery, phone: row.phone, chatId: row.chat_id, text })
        .catch((e) => d.log.error(`followup #${row.id}: своя реплика не легла в «Чат» (${e.message})`));
    }
    // Чип в списке диалогов: «⏳ Напомнили» после первого касания, терминальный
    // «done» после финала. Без события он обновился бы только по F5.
    safeEmit(d, row, isFinal ? 'done' : 'scheduled', isFinal ? 2 : 1);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    // Текст исключения идёт в ОТДЕЛЬНУЮ колонку error, а не в close_reason:
    // там машинные коды причин, и смешивать их с произвольным текстом ошибки
    // значит потерять разбор инцидентов — ровно то, ради чего очередь и
    // заведена отдельной таблицей.
    const writeError = () => d.db.query(
      `UPDATE agent_followups SET error=$2, updated_at=now() WHERE id=$1`, [row.id, msg])
      .catch(() => {});

    if (delivered) {
      // Доставлено клиенту — статус НЕ откатываем НИКОГДА: ретрай = дубль.
      d.log.error(`followup #${row.id}: доставлено, но пост-обработка упала: ${msg}`);
      await writeError();
      return;
    }
    if (captured) {
      // Захват был, отправка упала — но упасть она могла и ПОСЛЕ приёма
      // сообщения в очередь Chatpush (сеть рвётся в обе стороны). Откат вернул
      // бы строку под повторную отправку, то есть возможный дубль живому
      // пациенту; at-most-once выбирает потерю. Строка остаётся там, куда её
      // поставил захват: у напоминания это ожидание финала, у финала — done.
      d.log.error(`followup #${row.id}: захват состоялся, отправка упала (${msg}) — не переотправляем (at-most-once)`);
      await writeError();
      return;
    }
    if (terminal) {
      d.log.error(`followup #${row.id}: терминальный статус записан, хвост упал: ${msg}`);
      return;
    }
    // Side-effect'ов не было — строку можно честно вернуть в очередь.
    // Бюджет попыток исчерпан → failed (иначе строка с мёртвым провайдером
    // крутилась бы вечно, каждый круг оплачивая LLM-проход).
    const final = Number(row.attempts) >= MAX_ATTEMPTS;
    await d.db.query(
      `UPDATE agent_followups
          SET status=${final ? `'failed'` : 'status'}, error=$2, updated_at=now()
        WHERE id=$1 AND status='scheduled'`,
      [row.id, msg]).catch(() => {});
    if (final) safeEmit(d, row, 'failed', Number(row.stage) || 0);
    d.log.warn(`followup #${row.id} attempt ${row.attempts}/${MAX_ATTEMPTS} failed: ${msg}`);
  }
}

// Аренда. КРИТИЧНО: на алиас цели UPDATE нельзя ссылаться из ON-условий
// джойнов во FROM — PG отвечает «invalid reference to FROM-clause entry».
// Здесь FROM нет вовсе: настройки салона, его название и имя клиента берутся
// СКАЛЯРНЫМИ подзапросами в RETURNING (ссылка на f там легальна).
//
// Скалярные подзапросы, а не JOIN на agent_settings, ещё и по второй причине:
// join сузил бы выборку, и строка салона БЕЗ записи в agent_settings не
// арендовалась бы НИКОГДА — она висела бы 'scheduled' вечно, показывая в
// «Чате» вечное «ждём ответа». С подзапросами такая строка приходит с
// NULL-интервалами и штатно гаснет как cancelled('disabled').
//
// Имя клиента — суффиксным LIKE, ровно как identity.resolveClient и
// resolveTestClient: точное сравнение с каноничным ключом (79200255591)
// промахивается, в базе номера лежат в разных формах ('+79200255591'), и
// напоминание уходило бы без обращения по имени. Защита от совпадения с
// хвостом ЧУЖОГО номера та же — только полный номер (10+ цифр).
//
// Юнит-моки db.any валидность SQL не проверяют — после правок обязателен
// живой EXPLAIN на дев-БД, SQL экспортируется именно для этого.
const LEASE_SQL = `
  UPDATE agent_followups f
     SET attempts = f.attempts + 1, last_attempt_at = NOW()
   WHERE f.id IN (
     SELECT id FROM agent_followups
      WHERE status = 'scheduled' AND next_at <= NOW()
        AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
      ORDER BY next_at ASC, id ASC
      LIMIT ${LEASE_LIMIT}
      FOR UPDATE SKIP LOCKED)
  RETURNING f.*,
    (SELECT s.followup_delay1_min  FROM agent_settings s WHERE s.salon_id = f.salon_id) AS followup_delay1_min,
    (SELECT s.followup_delay2_min  FROM agent_settings s WHERE s.salon_id = f.salon_id) AS followup_delay2_min,
    (SELECT s.followup_final_text  FROM agent_settings s WHERE s.salon_id = f.salon_id) AS followup_final_text,
    (SELECT s.followup_latest_time FROM agent_settings s WHERE s.salon_id = f.salon_id) AS followup_latest_time,
    (SELECT sal.name FROM salons sal WHERE sal.id = f.salon_id) AS salon_name,
    (SELECT cl.name FROM clients cl
      WHERE cl.salon_id = f.salon_id AND length(f.phone) >= 10
        AND cl.phone LIKE '%' || f.phone
      ORDER BY cl.id LIMIT 1) AS client_name`;

let _tickInFlight = false;

/**
 * Один тик: аренда до LEASE_LIMIT просроченных строк и последовательная
 * обработка. Guard от наслоения тиков — как в «Заботе» и напоминаниях:
 * медленный прогон (LLM до 90 с на строку) не пускает следующий.
 */
async function processTick(deps = defaultDeps) {
  if (_tickInFlight) return;
  _tickInFlight = true;
  try {
    const d = { ...defaultDeps, ...deps };
    const rows = await d.db.any(LEASE_SQL, [RETRY_BACKOFF_S]);
    for (const row of rows) await processOne(row, d);
  } finally {
    _tickInFlight = false;
  }
}

let _running = false;
function startFollowupWorker() {
  if (_running) return;
  _running = true;
  if (!config.CHATPUSH.instanceToken) {
    log.warn('CHATPUSH_INSTANCE_TOKEN is not set — followup worker disabled');
    return;
  }
  // Аварийный рычаг гасит РОВНО отправки: строки очереди пишутся всегда, иначе
  // у инцидента не будет журнала.
  if (!config.AGENT_FOLLOWUP) {
    log.warn('AGENT_FOLLOWUP=false — воркер напоминаний о себе не запущен');
    return;
  }
  setInterval(() => { processTick().catch((e) => log.error(`tick: ${e.message}`)); }, WORKER_TICK_MS);
  log.info(`Followup worker started (tick=${WORKER_TICK_MS}ms)`);
}

module.exports = {
  processOne, processTick, startFollowupWorker, defaultDeps,
  LEASE_SQL, DEFAULT_FINAL_TEXT, DEFER_MINUTES, MIN_FINAL_GAP_MIN, MAX_ATTEMPTS,
  // Экспорт ради инварианта в тестах: таймаут строго меньше backoff аренды.
  LLM_TIMEOUT_MS, RETRY_BACKOFF_S,
};
