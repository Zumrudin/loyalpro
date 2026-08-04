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
 * @returns {Promise<'agent'|'system'|'operator'|null>} null — текста нет или БД недоступна.
 */
async function classify(salonId, text) {
  const key = textKey(text);
  if (!salonId || !key) return null;
  try {
    const row = await db.oneOrNone(
      `SELECT author FROM outgoing_authored
        WHERE salon_id = $1 AND text_hash = $2
          AND created_at > NOW() - INTERVAL '${KEEP_HOURS} hours'
        ORDER BY id DESC LIMIT 1`,
      [salonId, key]);
    return row ? row.author : 'operator';
  } catch (e) {
    return null;
  }
}

/** Удалить протухшие строки журнала (зовётся кроном вместе с прочей уборкой). */
async function cleanup() {
  try {
    await db.query(
      `DELETE FROM outgoing_authored WHERE created_at < NOW() - INTERVAL '${KEEP_HOURS} hours'`);
  } catch (e) { /* уборка не критична */ }
}

module.exports = { textKey, remember, classify, cleanup, KEEP_HOURS };
