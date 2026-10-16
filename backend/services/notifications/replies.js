'use strict';
// ============================================================
// Ответы пациентов на НАШИ уведомления — без LLM и ДО Милы:
//  • чистое подтверждение («Подтверждаю», «+», «Буду») после напоминания → в YClients «Подтвердил»
//    (attendance=2) ПОЛНЫМ PUT через booking-modify.confirmBookingRecord (голый {attendance} YClients
//    отвергает, 422) + отбивка;
//  • чистая цифра 2–5 после опроса → visit_ratings + текст по полосе (5 / 4 / 2–3);
//    2–3 → диалог на администратора ТЕМ ЖЕ инструментом escalate_to_operator, что у Милы
//    (agent_dialogs + каскад «Заботы» + agent_events + SSE + гашение напоминания Милы о себе) —
//    КРОМЕ диалога, который уже на операторе: инструмент затёр бы прежнюю причину (complication…).
//
// Перехватываем ТОЛЬКО ответ на наше письмо, а не любое «Да» после напоминания. Условие из трёх частей:
//  1. последнее исходящее диалога — авторства system и по тексту напоминание/опрос (как в
//     visit-rating.js: одного автора мало — под 'system' идут и «Вы записаны…», и касания «Заботы»);
//  2. СТРОГАЯ СВЯЗЬ: текст этого исходящего совпадает с текстом нашего sent-job (rendered_text) после
//     схлопывания пробелов и переводов строк. Не совпал — ответ не на это письмо: другое напоминание
//     (две записи), письмо тестовой отправки, чужой текст похожего вида;
//  3. КОНТЕКСТ ЖИВОГО ДИАЛОГА: «Да» может адресоваться Миле или администратору, спросившим «Перенести на
//     пт 15:00?» до нашего письма. Не перехватываем, если (а) в pending-replies есть чужая реплика,
//     отправленная после письма (её эхо ещё не легло в БД), или (б) для подтверждения — в chatpush_messages
//     есть исходящее Милы/администратора за LIVE_DIALOG_WINDOW_MIN до письма или после него. Для оценки
//     окно «до письма» не применяется: цифра 2–5 после опроса однозначна, и Мила отвечает на неё так же
//     (ветка visit-rating оркестратора), только без записи оценки.
// Иначе → { handled:false }, ход уходит Миле как раньше.
//
// Работает ТОЛЬКО в режиме live: в shadow/off ответы ведёт Chatpush, и наша отбивка легла бы
// поверх его отбивки. Неизвестное значение режима — НЕ live (fail-closed). Салон без строки
// notification_settings получает дефолты (режим off), поэтому на деве, куда приходят настоящие
// сообщения пациентов, модуль ничего не делает, пока режим не включён вручную.
//
// ИДЕМПОТЕНТНОСТЬ. Пациент может прислать «5» или «Подтверждаю» дважды подряд, а два вебхука —
// идти параллельно. Поэтому job СНАЧАЛА захватывается атомарно (UPDATE … SET confirmed_at = NOW()
// WHERE id = $1 AND confirmed_at IS NULL), и отвечает только захвативший: остальные получают
// { handled:true, kind:'duplicate' } — молча, без отправки и без Милы (две отбивки подряд хуже
// тишины). По той же причине поиск job'а НЕ фильтрует confirmed_at: иначе повтор после первого
// ответа не нашёл бы job и ушёл Миле. Наши же отбивки в pending-replies живым диалогом не считаются
// (иначе повтор в окне, пока эхо отбивки не пришло, ушёл бы Миле и ответили бы дважды).
//  • Подтверждение: захват → confirmBookingRecord. {ok:false} (YClients отказал, запись отменена/уже
//    «Пришёл»/не своя) → захват СНЯТ (следующее «Подтверждаю» попробует снова), ход Миле: она умеет
//    свериться с записью и ответить.
//  • Оценка: захват → visit_ratings → отбивка → перевод на администратора при 2–3. Не записалась
//    оценка → захват снят, ход Миле (её детерминированная ветка ответит на цифру сама).
//  • Отбивка — последний шаг: после неё ничего не бросает (запись в YClients/БД уже сделана,
//    исключение отдало бы ход Миле, и пациент получил бы второй ответ).
// ============================================================
const { db } = require('../../db');
const { createLogger } = require('../../logger');
const settingsSvc = require('./settings');
const history = require('../agent/history');
const { isPureConfirmation, isReminder } = require('../agent/visit-confirmation');
const { parseRating, isRatingSurvey } = require('../agent/visit-rating');
const { confirmBookingRecord } = require('../agent/booking-modify');
const transport = require('../messaging/transport');
const { recipientParams, DIALOG_KEY_SQL } = require('../chat');
const { normalizePhoneKey } = require('../agent-gate');
const pendingReplies = require('../agent/pending-replies');
const authorship = require('../outgoing-authorship');
const { persistWhatsappOutgoing } = require('../chat-persist');
const dialogState = require('../agent/dialog-state');
const escalateTool = require('../agent/tools/escalate-to-operator');
const groupChat = require('../agent/group-chat');

const log = createLogger('NotifyReplies');
const TEXT_TYPES = new Set(['text', 'formattedText']);
const CONFIRM_WINDOW_H = 48;        // напоминание старше двух суток подтверждением не считается
const RATING_WINDOW_H = 7 * 24;     // на опрос отвечают и через несколько дней
const LOW_RATING_REASON = 'low_rating';
// Окно «живого диалога» вокруг письма: исходящее Милы/администратора за столько минут ДО отправки
// письма (и любое после неё) — повод считать «Да» ответом им, а не нашему напоминанию.
const LIVE_DIALOG_WINDOW_MIN = 60;
// Время сообщения — то же выражение, что в history.js и visit-confirmation.js (msg_ts, иначе created_at по Москве).
const MSG_TS_SQL = `COALESCE(msg_ts, EXTRACT(EPOCH FROM (created_at AT TIME ZONE 'Europe/Moscow'))::bigint)`;
const NOT_HANDLED = Object.freeze({ handled: false });
const DUPLICATE = Object.freeze({ handled: true, kind: 'duplicate' });

// Ключ диалога — как у вебхука и диспетчера: сырой номер, иначе chat_id.
function dialogKeyOf(msg) {
  return (msg.phone && String(msg.phone).trim()) || msg.chatId || null;
}

// Сравнение текстов письма: эхо мессенджера может отличаться пробелами и переводами строк.
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Строгая связь: последнее исходящее диалога — это ТЕКСТ нашего job'а. Пустой текст связи не доказывает.
function isOurLetter(last, job) {
  const text = norm(job.rendered_text);
  return text !== '' && text === norm(last && last.text);
}

// Тексты, которые в диалоге пишем мы сами: само письмо и отбивки на ответы (настройки салона).
function ownTexts(job, cfg) {
  return new Set([job.rendered_text, cfg.confirm_reply_text, cfg.rating_high_text, cfg.rating_mid_text, cfg.rating_low_text]
    .map(norm).filter(Boolean));
}

// Чужая реплика (не письмо и не наша отбивка), отправленная ПОСЛЕ письма и ещё не легшая в БД. Смотрим оба
// ключа: Мила запоминает реплики под ключом диалога из вебхука, воркер уведомлений — под каноном номера.
function foreignPendingReply(salonId, msg, phoneKey, sentSec, own) {
  const keys = [...new Set([dialogKeyOf(msg), phoneKey].filter(Boolean))];
  return keys.some((key) => pendingReplies.peek(salonId, key)
    .some((e) => e.ts >= sentSec && !own.has(norm(e.text))));
}

// Писали ли в диалог Мила или администратор за LIVE_DIALOG_WINDOW_MIN до письма или после него.
// Верхней границы у окна нет намеренно. authored_by NULL (классификация упала / до выката журнала) не считается.
async function humanOrAgentWroteNearby(salonId, msg, sentSec) {
  const row = await db.oneOrNone(
    `SELECT 1 AS hit FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2 AND direction = 'outgoing'
        AND authored_by IN ('agent', 'operator')
        AND ${MSG_TS_SQL} >= $3
      LIMIT 1`,
    [salonId, dialogKeyOf(msg), sentSec - LIVE_DIALOG_WINDOW_MIN * 60]);
  return !!row;
}

/**
 * Живой диалог вокруг письма → причина (строка), по которой «Да»/цифру нельзя считать ответом на письмо,
 * иначе null. withHistory: подтверждение смотрит ещё и БД (окно вокруг письма), оценка — только pending.
 */
async function liveDialogReason(salonId, msg, job, cfg, phoneKey, { withHistory }) {
  const sentMs = job.sent_at ? new Date(job.sent_at).getTime() : NaN;
  if (!Number.isFinite(sentMs)) return 'момент отправки письма неизвестен';
  const sentSec = Math.floor(sentMs / 1000);
  if (foreignPendingReply(salonId, msg, phoneKey, sentSec, ownTexts(job, cfg))) {
    return 'после письма уже ушла другая реплика (её эхо ещё не в БД)';
  }
  if (withHistory && await humanOrAgentWroteNearby(salonId, msg, sentSec)) {
    return `рядом с письмом писали Мила или администратор (окно ${LIVE_DIALOG_WINDOW_MIN} мин)`;
  }
  return null;
}

// В notification_jobs.phone лежит канон 7XXXXXXXXXX, а msg.phone приходит в форме мессенджера
// ('89200255591', '+7…'): ищем по канону, а сырой номер оставляем адресату и ключу диалога.
// Тестовые отправки правила (yclients_record_id = 0) не ищем: подтверждать в YClients нечего, а в
// visit_ratings легла бы «оценка записи 0».
async function lastJob(salonId, phoneKey, type, hours) {
  return db.oneOrNone(
    `SELECT id, yclients_record_id, client_id, visit_datetime, meta, rendered_text, sent_at FROM notification_jobs
      WHERE salon_id = $1 AND phone = $2 AND trigger_type = $3 AND status = 'sent'
        AND yclients_record_id > 0
        AND sent_at > NOW() - make_interval(hours => $4)
      ORDER BY sent_at DESC LIMIT 1`,
    [salonId, phoneKey, type, hours]);
}

/** Атомарный захват job'а. true — этот ответ первый; false — job уже обработан (повтор/параллельный вебхук). */
async function claim(salonId, jobId) {
  const r = await db.query(
    'UPDATE notification_jobs SET confirmed_at = NOW() WHERE id = $1 AND salon_id = $2 AND confirmed_at IS NULL RETURNING id',
    [jobId, salonId]);
  return !!(r && r.rowCount > 0);
}

/** Снять свой захват: ответ не удалось обработать, job снова свободен для следующего. Не бросает. */
async function unclaim(salonId, jobId) {
  try {
    await db.query('UPDATE notification_jobs SET confirmed_at = NULL WHERE id = $1 AND salon_id = $2', [jobId, salonId]);
  } catch (e) {
    log.error(`job ${jobId}: захват не снят (${e.message}) — следующий ответ пациента будет считаться повтором`);
  }
}

/**
 * Отбивка пациенту — в ТОТ мессенджер, где он написал, без каскада: адресат известен точно.
 * Не бросает (см. шапку): сбой отправки уходит в лог.
 */
async function sendReply(salonId, msg, text) {
  if (!text || !String(text).trim()) return;
  const key = dialogKeyOf(msg);
  try {
    const rp = recipientParams(msg.channel, { phone: msg.phone, chat_id: msg.chatId });
    if (!rp) throw new Error('нет адресата для ответа');
    // Журнал авторства — ДО отправки: эхо шлюза может прийти раньше, чем вернётся sendMessage, и без
    // записи выглядело бы ответом живого администратора (пауза Милы, инцидент 04.08).
    try { await authorship.remember(salonId, key, text, 'system'); }
    catch (e) { log.error(`authorship ${key}: ${e.message}`); }
    const delivery = await transport.sendMessage(salonId, { ...rp, text, replyToMessageId: msg.messageId });
    // Сообщение УЖЕ ушло: всё ниже best-effort и ничего не бросает.
    try { pendingReplies.remember(salonId, key, text); }
    catch (e) { log.error(`pending ${key}: ${e.message}`); }
    if (msg.channel === 'whatsapp') {   // WhatsApp эха не шлёт — кладём в «Чат» сами
      try {
        await persistWhatsappOutgoing(salonId, { delivery, phone: msg.phone, chatId: msg.chatId, text, msgType: 'text', authoredBy: 'system' });
      } catch (e) { log.error(`persist wa ${key}: ${e.message}`); }
    }
  } catch (e) {
    log.error(`отбивка не ушла (${msg.channel}, ${key}): ${e.message}`);
  }
}

/** Низкая оценка → диалог на администратора. Не бросает. */
async function escalateToAdmin(salonId, key) {
  try {
    // Строка agent_dialogs нужна UPDATE'у инструмента (по несуществующей он ничего не меняет), а её статус —
    // чтобы не затереть причину: диалог, уже переданный человеку (complication, operator_reply…), остаётся как есть.
    const dlg = await dialogState.getOrCreate(salonId, key);
    if (dlg && dlg.status === 'escalated') {
      log.info(`диалог ${key}: уже на операторе (${dlg.escalated_reason || 'причина не указана'}) — перевод по низкой оценке не повторяем, прежнюю причину не затираем`);
      return;
    }
    await escalateTool.run(salonId, { reason: LOW_RATING_REASON }, { dialogKey: key });
  } catch (e) {
    log.error(`диалог ${key}: низкая оценка не переведена на администратора (${e.message})`);
  }
}

/**
 * Напоминание могло устареть, пока пациент собирался ответить. «Подтверждаю» на такое не должно ни
 * подтверждать СТАРОЕ время, ни откатывать в YClients «Пришёл» до «Подтвердил»: отвечает Мила, у
 * неё есть блок актуальных записей. Данных нет (момент визита не разобран, состояния записи нет —
 * создана до выката) → не мешаем, «устарело» не выдумываем.
 */
async function staleReminder(salonId, job) {
  const visitMs = job.visit_datetime ? new Date(job.visit_datetime).getTime() : NaN;
  if (visitMs <= Date.now()) return 'визит уже начался';
  const st = await db.oneOrNone(
    'SELECT visit_datetime, attendance, deleted FROM notification_record_state WHERE salon_id = $1 AND yclients_record_id = $2',
    [salonId, job.yclients_record_id]);
  if (!st) return null;
  if (st.deleted || Number(st.attendance) === -1) return 'запись отменена';
  if (Number(st.attendance) === 1) return 'пациент уже отмечен как пришедший';
  if (Number.isFinite(visitMs) && st.visit_datetime && new Date(st.visit_datetime).getTime() !== visitMs) return 'запись перенесена';
  return null;
}

async function handleConfirmation(salonId, msg, cfg, phoneKey, last) {
  const job = await lastJob(salonId, phoneKey, 'visit_reminder', CONFIRM_WINDOW_H);
  if (!job || !(job.meta && job.meta.askConfirmation)) return NOT_HANDLED;
  if (!isOurLetter(last, job)) {
    log.info(`record ${job.yclients_record_id}: последнее исходящее — не наше письмо (job #${job.id}) — ход Миле`);
    return NOT_HANDLED;
  }
  const live = await liveDialogReason(salonId, msg, job, cfg, phoneKey, { withHistory: true });
  if (live) {
    log.info(`record ${job.yclients_record_id}: живой диалог — ${live} — ход Миле`);
    return NOT_HANDLED;
  }
  const stale = await staleReminder(salonId, job);
  if (stale) {
    log.info(`record ${job.yclients_record_id}: подтверждение на устаревшее напоминание (${stale}) — ход Миле`);
    return NOT_HANDLED;
  }
  if (!(await claim(salonId, job.id))) {
    log.info(`record ${job.yclients_record_id}: повторное подтверждение (${msg.channel}) — уже обработано, молчим`);
    return DUPLICATE;
  }
  let res;
  try {
    res = await confirmBookingRecord(salonId, Number(job.yclients_record_id), { expectedPhone: phoneKey });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  if (!res || !res.ok) {
    await unclaim(salonId, job.id);
    log.warn(`record ${job.yclients_record_id}: подтверждение не принято (${(res && res.error) || 'без причины'}) — ход Миле`);
    return NOT_HANDLED;
  }
  log.info(`record ${job.yclients_record_id} ${res.already ? 'уже была подтверждена, повторный PUT не нужен' : 'подтверждён пациентом'} (${msg.channel})`);
  await sendReply(salonId, msg, cfg.confirm_reply_text);
  return { handled: true, kind: 'confirmed' };
}

async function handleRating(salonId, msg, rating, cfg, phoneKey, last) {
  const job = await lastJob(salonId, phoneKey, 'visit_review', RATING_WINDOW_H);
  if (!job) return NOT_HANDLED;
  if (!isOurLetter(last, job)) {
    log.info(`record ${job.yclients_record_id}: последнее исходящее — не наше письмо (job #${job.id}) — ход Миле`);
    return NOT_HANDLED;
  }
  const live = await liveDialogReason(salonId, msg, job, cfg, phoneKey, { withHistory: false });
  if (live) {
    log.info(`record ${job.yclients_record_id}: живой диалог — ${live} — ход Миле`);
    return NOT_HANDLED;
  }
  if (!(await claim(salonId, job.id))) {
    log.info(`record ${job.yclients_record_id}: повторная оценка ${rating} (${msg.channel}) — уже обработано, молчим`);
    return DUPLICATE;
  }
  try {
    await db.query(
      `INSERT INTO visit_ratings (salon_id, yclients_record_id, client_id, phone, rating, source_job_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (salon_id, yclients_record_id)
       DO UPDATE SET rating = EXCLUDED.rating, source_job_id = EXCLUDED.source_job_id, created_at = NOW()`,
      [salonId, Number(job.yclients_record_id), job.client_id || null, phoneKey, rating, job.id]);
  } catch (e) {
    await unclaim(salonId, job.id);
    log.error(`record ${job.yclients_record_id}: оценка ${rating} не записалась (${e.message}) — ход Миле`);
    return NOT_HANDLED;
  }
  // Полосы утверждены владельцем 14.10.2026: 5 — благодарность (со ссылками на отзывы),
  // 4 — «что улучшить» без перевода, 2–3 — «что не устроило» и перевод на администратора.
  const low = rating <= 3;
  const escalating = low && !!cfg.rating_escalate_low;
  const text = rating === 5 ? cfg.rating_high_text : rating === 4 ? cfg.rating_mid_text : cfg.rating_low_text;
  log.info(`record ${job.yclients_record_id}: оценка ${rating}${low ? ` (низкая${escalating ? ' → администратор' : ''})` : ''}`);
  await sendReply(salonId, msg, text);
  if (escalating) await escalateToAdmin(salonId, dialogKeyOf(msg));
  return { handled: true, kind: 'rating', rating };
}

/**
 * msg — объект входящего из routes/chatpush-webhook.js (chatpush.parseMessageEvent).
 * @returns {Promise<{handled:boolean, kind?:string, rating?:number}>} handled:true — ответ обработан
 *   здесь, Милу ставить в очередь НЕ нужно; handled:false — ход Миле как обычно. Не бросает.
 */
async function handleIncoming(salonId, msg) {
  try {
    if (!salonId || !msg || msg.direction !== 'incoming' || !TEXT_TYPES.has(msg.type)) return NOT_HANDLED;
    if (groupChat.isGroupMessage(msg)) return NOT_HANDLED;
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    const phoneKey = normalizePhoneKey(msg.phone);
    if (!text || !phoneKey) return NOT_HANDLED;
    // Дешёвые чистые проверки — ДО любого обращения к БД: сюда попадает КАЖДОЕ входящее салона, а
    // подтверждением или оценкой бывают единицы.
    const confirming = isPureConfirmation(text);
    const rating = confirming ? null : parseRating(text);
    if (!confirming && rating == null) return NOT_HANDLED;
    const cfg = await settingsSvc.getSettings(salonId);
    // live — все; shadow — только пилотные номера (им письма реально уходят, см. worker.js); off — никто.
    const live = !!cfg && (cfg.mode === 'live' || (cfg.mode === 'shadow' && settingsSvc.isPilotPhone(cfg, phoneKey)));
    if (!live) return NOT_HANDLED;
    const last = await history.lastOutgoing(salonId, dialogKeyOf(msg));
    if (!last || last.author !== 'system') return NOT_HANDLED;
    if (confirming) {
      return isReminder(last.text) ? await handleConfirmation(salonId, msg, cfg, phoneKey, last) : NOT_HANDLED;
    }
    return isRatingSurvey(last.text) ? await handleRating(salonId, msg, rating, cfg, phoneKey, last) : NOT_HANDLED;
  } catch (e) {
    log.error(`handleIncoming: ${e.message}`);   // fail-open: ход уходит Миле
    return NOT_HANDLED;
  }
}

module.exports = { handleIncoming, LIVE_DIALOG_WINDOW_MIN };
