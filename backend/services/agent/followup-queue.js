'use strict';
// ============================================================
// Очередь ожидания ответа клиента — тонкие обёртки над SQL.
//
// ВСЁ здесь BEST-EFFORT: сбой БД не имеет права уронить ход диалога или
// обработку вебхука. Не поставили строку — пациент просто не получит
// напоминания; бросили бы исключение — остались бы без ответа вовсе.
//
// Юнит-тесты: agent-followup-queue.test.js
// ============================================================

const { db: realDb } = require('../../db');
const { resolveDelays, nextAtFor } = require('./followup-schedule');
const { createLogger } = require('../../logger');

const log = createLogger('Followup');

// Терминальные статусы. Держим списком, а не свободной строкой: опечатка в
// имени статуса иначе молча создала бы строку, которую не видит ни чип, ни
// аренда.
const CLOSE_STATUSES = new Set(['answered', 'cancelled', 'expired', 'done', 'failed']);

/**
 * Завести (или перезавести) ожидание ответа после реплики Милы.
 * ON CONFLICT сбрасывает якорь и стадию: свежая реплика начинает отсчёт
 * заново — предыдущее ожидание этим же ответом и закрыто по смыслу.
 * @returns {Promise<boolean>} поставлена ли строка
 */
async function schedule(salonId, dialogKey, meta = {}, settings = {}, opts = {}) {
  const db = opts.db || realDb;
  if (!salonId || !dialogKey) return false;
  const { enabled, delay1, delay2 } = resolveDelays(settings);
  if (!enabled) return false;
  const anchor = opts.now ? new Date(opts.now) : new Date();
  const next = nextAtFor({ anchorAt: anchor, stage: 0, delay1Min: delay1, delay2Min: delay2 });
  if (!next) return false;
  try {
    await db.query(
      `INSERT INTO agent_followups
         (salon_id, dialog_key, phone, channel, chat_id, anchor_at, next_at,
          stage, status, close_reason, attempts, last_attempt_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,'scheduled',NULL,0,NULL,now())
       ON CONFLICT (salon_id, dialog_key) WHERE status='scheduled'
       DO UPDATE SET phone=$3, channel=$4, chat_id=$5, anchor_at=$6, next_at=$7,
                     stage=0, close_reason=NULL, attempts=0, last_attempt_at=NULL,
                     -- Перезавод — НОВЫЙ цикл ожидания, а не продолжение старого.
                     -- Гашение строки — best-effort (см. close) и при сбое БД
                     -- могло не пройти, оставив живую строку со stage=1 и
                     -- заполненным nudge1_at из ПРОШЛОГО цикла; если тут сбросить
                     -- только stage, строка станет самопротиворечивой: stage=0
                     -- («в этом цикле ещё ничего не отправляли»), а nudge1_at
                     -- держит время отправки из прошлого цикла. Журнал
                     -- незавершённого цикла потерять дешевле, чем оставить
                     -- разбору инцидента противоречивое состояние — история
                     -- завершённых циклов и так живёт в терминальных строках
                     -- (в этом и смысл частичного уникального индекса).
                     nudge1_at=NULL, final_at=NULL, rendered_text=NULL, error=NULL,
                     updated_at=now()`,
      [salonId, dialogKey, meta.phone || null, meta.channel || null, meta.chatId || null,
       anchor, next]);
    return true;
  } catch (e) {
    log.warn(`dialog ${dialogKey}: не поставить ожидание ответа (${e.message})`);
    return false;
  }
}

/**
 * Погасить живую строку диалога.
 * @param {string} status один из CLOSE_STATUSES
 * @param {string} reason машинная причина (client_replied, operator, …) —
 *   НЕ валидируется, в отличие от status: status участвует в SQL-условиях
 *   (частичный индекс, аренда) и в логике чипа списка диалогов, а reason —
 *   только человекочитаемое объяснение для разбора инцидентов; жёсткий
 *   список причин пришлось бы держать синхронным с каждым вызывающим
 *   местом (воркер, вебхук, ручная пауза), а цена рассинхрона тут — просто
 *   менее удобная строка в логе, а не сломанная логика.
 * @returns {Promise<boolean>} была ли строка (false и при сбое БД)
 */
async function close(salonId, dialogKey, status, reason, opts = {}) {
  const db = opts.db || realDb;
  if (!CLOSE_STATUSES.has(status)) {
    const e = new Error(`bad status: ${status}`);
    e.code = 'BAD_STATUS';
    throw e;
  }
  if (!salonId || !dialogKey) return false;
  try {
    const r = await db.query(
      `UPDATE agent_followups
          SET status = $3, close_reason = $4, updated_at = now()
        WHERE salon_id = $1 AND dialog_key = $2 AND status = 'scheduled'`,
      [salonId, dialogKey, status, reason || null]);
    return !!(r && r.rowCount);
  } catch (e) {
    log.warn(`dialog ${dialogKey}: не погасить ожидание ответа (${e.message})`);
    return false;
  }
}

module.exports = { schedule, close, CLOSE_STATUSES };
