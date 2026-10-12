'use strict';

// ── Кто написал исходящее сообщение: мы или живой администратор ──────────────
//
// ЗАЧЕМ. Всё, что уходит клиенту, возвращается в chatpush_messages ОДИНАКОВЫМ
// эхом Chatpush с direction='outgoing' — и реплика Милы, и автоуведомление, и
// сообщение, которое администратор набрал руками в приложении MAX/Telegram.
// Отсюда два боевых дефекта (инцидент 2026-08-04, диалог 79253209302):
//   1. Мила читала реплики администратора как СВОИ (транскрипт строит роль по
//      direction) — сработало правило «ВЫБОР ВАРИАНТА = СОГЛАСИЕ», и она
//      оформила запись, «согласованную» не ею, выдумав услугу;
//   2. пауза «отвечает оператор» ставилась только при отправке ЧЕРЕЗ АДМИНКУ
//      (routes/chat.js), а салон отвечает прямо из приложения — Мила входила в
//      диалог, который четвёртые сутки вёл человек.
//
// КАК. Каждую СВОЮ отправку мы записываем в журнал outgoing_authored (текст —
// хэшем, без PII). Пришло эхо: текст есть в журнале → это мы; нет → писал
// человек. Сверка по хэшу текста, а не по id сообщения: id эха назначает
// Chatpush, и с нашим delivery_id он совпадает только в WhatsApp.
//
// Сверяем в пределах САЛОНА, без привязки к диалогу: ключ диалога у отправителя
// (телефон) и у эха (может быть chat_id) не всегда один и тот же, а совпадение
// текста между двумя диалогами одного салона означает лишь, что обоим ушёл один
// и тот же наш шаблон — вывод «это мы» от этого не портится.
//
// FAIL-OPEN: сбой БД → null («не знаем»), и вызывающая сторона ведёт себя как
// раньше. Ответить «operator» на упавшем запросе значило бы глушить Милу на её
// собственном эхе.

const crypto = require('crypto');
const { db } = require('../db');

// Сколько живёт запись журнала. Эхо Chatpush приходит с задержкой (наблюдали
// 19 минут), суток хватает с запасом; старое чистится при записи.
const KEEP_HOURS = 72;

/** Ключ текста: схлопнутые пробелы + sha256. null, если текста нет. */
function textKey(text) {
  const norm = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  return crypto.createHash('sha256').update(norm).digest('hex');
}

/**
 * Запомнить СВОЮ отправку. Строго best-effort: сообщение уже ушло клиенту,
 * исключение отсюда не имеет права ломать вызывающий код.
 * @param {'agent'|'system'|'operator'} author 'agent' — Мила, 'system' —
 *   автоуведомление/касание заботы, 'operator' — ответ человека из админки.
 */
async function remember(salonId, dialogKey, text, author) {
  const key = textKey(text);
  if (!salonId || !key) return;
  try {
    await db.query(
      `INSERT INTO outgoing_authored (salon_id, dialog_key, text_hash, author)
       VALUES ($1,$2,$3,$4)`,
      [salonId, String(dialogKey || ''), key, author]);
  } catch (e) { /* журнал авторства — не критичный путь */ }
}

/**
 * Кто автор исходящего текста.
 *
 * Журнал знает только НАШИ отправки, а через один инстанс Chatpush пишет не
 * только LoyalPro: автоуведомления YClients («Вы записаны на прием…»,
 * «Напоминаем о записи…», «Ваша запись перенесена») уходят клиенту тем же
 * каналом и возвращаются таким же эхом. Инцидент 2026-08-04 (79200255591):
 * такое уведомление о записи, ТОЛЬКО ЧТО созданной Милой, считалось ответом
 * живого администратора и ставило диалог на паузу — Мила замолкала ровно на
 * своём успехе. На проде так помечались все записи дня, а не только тестовая.
 *
 * Различает источники delivery_id из вебхука: он есть у всего, что ушло через
 * API Chatpush (мы или чужая интеграция), и его НЕТ у текста, который человек
 * набрал руками в приложении Telegram/MAX/WhatsApp — а пауза нужна ровно там.
 * Проверено на боевых payload'ах: у всех автоуведомлений и реплик Милы
 * delivery_id заполнен, у живых сообщений администраторов — пуст.
 *
 * СВОЙ ШЛЮЗ (provider='gateway', с 12.10.2026): у эха шлюза delivery_id есть
 * ТОЛЬКО у того, что отправил сам шлюз. Автоуведомления YClients по-прежнему
 * уходят через Chatpush (его Telegram-сессия живёт параллельно нашей), TDLib
 * показывает их нам как обычное исходящее С ДРУГОЙ СЕССИИ — без delivery_id и
 * неотличимо от текста, набранного администратором в приложении. Инцидент
 * 2026-10-12 (79296135814, первый час после переключения Telegram прода на
 * шлюз): «Спасибо что посетили… оцените» и «Рекомендации после процедуры»
 * легли как 'operator', диалог встал на паузу, оценка «5» пришла уже на
 * паузу — ровно класс инцидента 2026-08-04, ~19 таких уведомлений в день.
 * Структурного признака у чужой сессии в TDLib нет, поэтому для шлюза
 * включается ВТОРОЙ источник — ШАБЛОНЫ, которым САЛОН уже учился: тексты,
 * ранее пришедшие эхом Chatpush с delivery_id и не из нашего журнала (то есть
 * API-отправки сторонней интеграции). Сверка по НОРМАЛИЗОВАННОМУ тексту
 * (числа → #, ссылки → <url>, пробелы схлопнуты): дата/время/телефон в шаблоне
 * меняются, остальное дословно. Учимся только у Chatpush-эха (provider <>
 * 'gateway'): новый шаблон YClients после ухода из Chatpush узнан не будет и
 * пойдёт как 'operator' — прежняя, безопасная сторона (лишняя пауза, а не
 * Мила поверх живого человека). Риск «администратор набрал руками тот же
 * многострочный шаблон с датой и ссылками» принят как пренебрежимый.
 *
 * @param {{viaApi?: boolean, provider?: string}} opts viaApi — сообщение ушло
 *   через API с delivery_id (см. chatpush.parseMessageEvent().deliveryId);
 *   provider — 'chatpush' | 'gateway', источник эха. По умолчанию оба пусты —
 *   консервативно, как до появления признаков.
 * @returns {Promise<'agent'|'system'|'operator'|null>} null — текста нет или БД недоступна.
 */
async function classify(salonId, text, opts = {}) {
  const key = textKey(text);
  if (!salonId || !key) return null;
  try {
    const row = await db.oneOrNone(
      `SELECT author FROM outgoing_authored
        WHERE salon_id = $1 AND text_hash = $2
          AND created_at > NOW() - INTERVAL '${KEEP_HOURS} hours'
        ORDER BY id DESC LIMIT 1`,
      [salonId, key]);
    // Журнал главнее признака доставки: наша отправка из админки тоже идёт через
    // API, но она — именно ответ оператора, и пауза после неё обязательна.
    if (row) return row.author;
    if (opts.viaApi) return 'system';
    if (opts.provider === 'gateway' && await isKnownNotificationTemplate(salonId, text)) return 'system';
    return 'operator';
  } catch (e) {
    return null;
  }
}

// Нормализация текста для сверки с шаблоном — ОДНО выражение на обе стороны
// сравнения (колонка и параметр), чтобы копии не разъехались: числа → #,
// ссылки → <url>, пробелы схлопнуты, края обрезаны. Горизонт обучения —
// TEMPLATE_LOOKBACK_DAYS: шаблоны YClients живут месяцами, а старые записи
// до выката журнала авторства (05.08.2026) помечены 'system' неточно.
const TEMPLATE_LOOKBACK_DAYS = 180;
// Дешёвый префильтр ДО регэкспов: живой EXPLAIN на дев-БД — 4 000 исходящих
// 'system' за полгода, три regexp_replace на каждой строке давали ~100 мс на
// КАЖДЫЙ промах (а промах — это каждый ответ администратора из приложения,
// ~30 в день). PG упорядочивает условия по стоимости, равенство префикса
// отсекает чужие шаблоны до регэкспов. ДОПУЩЕНИЕ: первые символы шаблона не
// содержат переменных чисел — у всех 10 шаблонов прода так; иначе шаблон
// не узнаётся и уходит как 'operator' (безопасная сторона).
const TEMPLATE_PREFIX_LEN = 12;
const normSql = (expr) =>
  `btrim(regexp_replace(regexp_replace(regexp_replace(${expr}, 'https?://\\S+', '<url>', 'g'), '[0-9]+', '#', 'g'), '\\s+', ' ', 'g'))`;

/**
 * Приходил ли этому салону ТАКОЙ ЖЕ (с точностью до чисел и ссылок) текст эхом
 * Chatpush как автоуведомление (authored_by='system', не из нашего журнала —
 * см. classify). FAIL-CLOSED в сторону 'operator': сбой БД → false, то есть
 * прежнее поведение (пауза), а не молчаливое «это автоуведомление».
 */
async function isKnownNotificationTemplate(salonId, text) {
  try {
    const row = await db.oneOrNone(
      `SELECT 1 AS ok FROM chatpush_messages
        WHERE salon_id = $1 AND direction = 'outgoing' AND authored_by = 'system'
          AND provider IS DISTINCT FROM 'gateway'
          AND created_at > NOW() - INTERVAL '${TEMPLATE_LOOKBACK_DAYS} days'
          AND left(text, ${TEMPLATE_PREFIX_LEN}) = left($2::text, ${TEMPLATE_PREFIX_LEN})
          AND ${normSql('text')} = ${normSql('$2::text')}
        LIMIT 1`,
      [salonId, String(text)]);
    return !!row;
  } catch (e) {
    return false;
  }
}

/** Удалить протухшие строки журнала (зовётся кроном вместе с прочей уборкой). */
async function cleanup() {
  try {
    await db.query(
      `DELETE FROM outgoing_authored WHERE created_at < NOW() - INTERVAL '${KEEP_HOURS} hours'`);
  } catch (e) { /* уборка не критична */ }
}

module.exports = { textKey, remember, classify, cleanup, isKnownNotificationTemplate, KEEP_HOURS, TEMPLATE_LOOKBACK_DAYS, TEMPLATE_PREFIX_LEN };
