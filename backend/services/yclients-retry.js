'use strict';

// ── Повтор write-запроса в YClients при лимите запросов (429) ────────────────
//
// ЗАЧЕМ. Инцидент 2026-09-19 (79651442032): два reschedule_booking за один ход
// упали с «Превышен лимит запросов, попробуйте повторить запрос через 0 секунд»
// — и ни один не был повторён: ретрай 429 жил только в синке каталога товаров
// (yclients-goods-catalog) и в loyalty, а путь записи/переноса/отмены его не
// имел. Лимит YClients срабатывает на БЁРСТ (перед write в том же ходу уже
// ушли list_client_bookings, identity, каталог), и секундной паузы хватает.
//
// Ошибку YClients ДВЕ формы: ycError (services/yclients.js) сохраняет
// err.status, а ycUpdateRecord (yclients-records.js) бросает голый Error с
// текстом meta.message — поэтому признак двойной: статус ИЛИ текст.
// Повторяем ТОЛЬКО лимит: «время недоступно», 422 по полям и прочие отказы —
// факты, и повтор их не изменит.

const RATE_LIMIT_RE = /превышен\s+лимит\s+запросов|too\s+many\s+requests/i;

function isRateLimitError(err) {
  if (!err || typeof err !== 'object') return false;
  if (Number(err.status) === 429) return true;
  return RATE_LIMIT_RE.test(String(err.message || ''));
}

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {() => Promise<any>} fn запрос
 * @param {{retries?: number, delayMs?: number, sleep?: (ms:number)=>Promise<void>}} opts
 *   retries — сколько ПОВТОРОВ сверх первой попытки (дефолт 2), delayMs — пауза
 *   перед каждым повтором (дефолт 1000), sleep — инжектируется тестами.
 */
async function withRateLimitRetry(fn, opts = {}) {
  const retries = Number.isInteger(opts.retries) ? opts.retries : 2;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 1000;
  const sleep = opts.sleep || defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimitError(e) || attempt >= retries) throw e;
      attempt += 1;
      await sleep(delayMs);
    }
  }
}

module.exports = { withRateLimitRetry, isRateLimitError, RATE_LIMIT_RE };
