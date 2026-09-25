'use strict';
// ── Ночная сверка с YClients ─────────────────────────────────────────────────
//
// ЗАЧЕМ. До 25.09.2026 актуальность clients/records держал полный runSync
// (services/loyalty.js): 730 дней записей + карточка и карта КАЖДОГО из 4 300
// клиентов, ≈8 800 запросов и 45 минут, 8 раз в сутки. С 26.06 он падал на
// лимите YClients в каждом прогоне, а в успешные месяцы поставлял 0–11 записей:
// записи, клиенты, карта при начислении и баланс при finances_operation давно
// приходят вебхуками, а траты/визиты/раздельное ФИО несёт client-вебхук
// (services/client-upsert.js). Полный обход ради данных, 99 % которых не
// менялись, выедал общую квоту YClients у «Заботы» (лимит ежедневно в 12:00) и
// живых вызовов Милы. Полный синк остаётся ручным (кнопка «Синхронизировать»).
//
// ЧТО ДЕЛАЕТ (спека docs/superpowers/specs/2026-09-25-yclients-sync-replacement-design.md):
//   1. /records?changed_after=<сегодня−RECONCILE_DAYS> постранично → upsert в records
//      (страховка от потерянного вебхука). Кэшбэк отсюда НЕ начисляется — деньги
//      решает только вебхук-путь; оплаченный состоявшийся визит без строки
//      finances_log даёт WARN «вебхук потерян» вместо тихого второго пути
//      начисления с теми же дефектами (docs/2026-09-25-cashback-accrual-bugs.md, п. 3–6).
//   2. Клиенты из этих записей (на проде ≈55 в сутки): /client/{id} → общий
//      upsertClientFromYc; карта не привязана → linkClientCard (та же функция, что
//      в начислении); привязана → баланс из ycGetClientCards. Ошибка по одному
//      клиенту — лог и дальше.
//   3. last_visit_at из records и привязка record_id к транзакциям карты — те же
//      функции, что в хвосте runSync.
//   4. Строка sync_logs (sync_type='daily') — дашборд «Синхр.: N ч назад» и
//      GET /api/sync/logs работают без правок фронта.
//
// Лимит YClients: страница /records повторяется через 60 с (лимит минутный,
// сообщение «через 0 секунд» врёт — 47 падений runSync подряд это доказали).
const { db } = require('../db');
const { ycGet, ycGetClientCards } = require('./yclients');
const loyalty = require('./loyalty');
const { upsertClientFromYc } = require('./client-upsert');
const { withRateLimitRetry } = require('./yclients-retry');
const { createLogger } = require('../logger');
const logger = createLogger('Reconcile');

const RECONCILE_DAYS = 2;
const PAGE = 200;
const RECORDS_RETRY = { retries: 2, delayMs: 60_000 };
const CLIENT_PAUSE_MS = 500;
const PAGE_PAUSE_MS = 300;
const REPEATED_FAILURES = 3;

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Дата по Москве минус N дней, 'YYYY-MM-DD' — значение для changed_after. */
function changedAfterDate(now = new Date(), days = RECONCILE_DAYS) {
  const d = new Date(now.getTime() - days * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
}

async function fetchChangedRecords(salon, changedAfter, sleep) {
  const all = [];
  for (let page = 1; ; page++) {
    const chunk = await withRateLimitRetry(
      () => ycGet(salon, `/records/${salon.yclients_company_id}`, { changed_after: changedAfter, page, count: PAGE }),
      RECORDS_RETRY
    );
    if (!Array.isArray(chunk) || !chunk.length) break;
    all.push(...chunk);
    if (chunk.length < PAGE) break;
    await sleep(PAGE_PAUSE_MS);
  }
  return all;
}

function isPaidCompleted(ycr) {
  return Number(ycr.attendance) === 1 && Number(ycr.paid_full) === 1
    && !ycr.deleted && loyalty.getRecordCost(ycr) > 0;
}

async function reconcileRecords(salon, records) {
  const clientYcIds = new Set();
  const lost = [];
  let upserted = 0;
  for (const ycr of records) {
    const ycClientId = ycr.client?.id || null;
    let dbClient = null;
    if (ycClientId) {
      dbClient = await db.oneOrNone(
        'SELECT id, yclients_card_id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
        [salon.id, ycClientId]
      );
      clientYcIds.add(ycClientId);
    }
    const up = await loyalty.upsertRecordFromYc(salon.id, ycr, dbClient?.id || null, 'reconcile');
    if (up) upserted++;
    if (isPaidCompleted(ycr)) {
      const fin = await db.oneOrNone('SELECT id FROM finances_log WHERE yclients_record_id=$1', [ycr.id]);
      if (!fin) {
        lost.push(ycr.id);
        logger.warn(`salon=${salon.id}: вебхук по записи ${ycr.id} потерян — визит оплачен и состоялся ` +
          `(${ycr.date}, клиент yc=${ycClientId}), а finances_log пуст; начисление кэшбэка не делалось`);
      }
    }
  }
  return { upserted, clientYcIds, lost };
}

async function reconcileClient(salon, ycClientId, settings) {
  const yc = await ycGet(salon, `/client/${salon.yclients_company_id}/${ycClientId}`);
  if (!yc) return null;
  const row = await upsertClientFromYc(salon.id, yc, settings);
  if (!row) return null;
  if (salon.yclients_card_type_id) {
    if (!row.yclients_card_id) {
      await loyalty.linkClientCard(salon, row, settings);
    } else {
      const cards = await ycGetClientCards(salon, ycClientId);
      const card = cards.find(c => String(c.type?.id) === String(salon.yclients_card_type_id));
      if (card) {
        await db.query(
          'UPDATE clients SET yclients_card_balance=$1, bonus_balance=$1, updated_at=NOW() WHERE id=$2',
          [parseFloat(card.balance || 0), row.id]
        );
      }
    }
  }
  await loyalty.linkCardTransactionsToRecords(row.id);
  return row;
}

/**
 * Один ночной прогон по салону. Бросает при фатальном сбое (страницы /records
 * не прочитались) — крон логирует; ошибки по отдельным клиентам не фатальны.
 * @param {{sleep?: (ms:number)=>Promise<void>, now?: Date}} opts
 */
async function reconcileDaily(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const log = await db.one(
    `INSERT INTO sync_logs (salon_id,sync_type,status,initiated_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [salon.id, 'daily', 'running', null]
  );
  const t0 = Date.now();
  try {
    const settings = await loyalty.getLoyaltySettings(salon.id);
    const changedAfter = changedAfterDate(opts.now || new Date());
    const records = await fetchChangedRecords(salon, changedAfter, sleep);
    logger.info(`salon=${salon.id}: записей с changed_after=${changedAfter}: ${records.length}`);

    const { upserted, clientYcIds, lost } = await reconcileRecords(salon, records);

    let clients = 0, clientErrors = 0;
    for (const ycClientId of clientYcIds) {
      try {
        if (await reconcileClient(salon, ycClientId, settings)) clients++;
      } catch (e) {
        clientErrors++;
        logger.warn(`salon=${salon.id}: клиент yc=${ycClientId} не сверен: ${e.message}`);
      }
      await sleep(CLIENT_PAUSE_MS);
    }

    await loyalty.refreshLastVisitAt(salon.id);

    await db.query(
      `UPDATE sync_logs SET status='success',clients_synced=$1,records_synced=$2,
       bonuses_accrued=$3,new_clients=$4,finished_at=NOW() WHERE id=$5`,
      [clients, upserted, 0, 0, log.id]
    );
    const summary = { ok: true, records: upserted, clients, clientErrors, lost, ms: Date.now() - t0 };
    logger.info(`salon=${salon.id}: ✓ records=${upserted} clients=${clients} errors=${clientErrors} ` +
      `lost_webhooks=${lost.length} ${summary.ms}ms`);
    return summary;
  } catch (e) {
    await db.query(`UPDATE sync_logs SET status='error',error_message=$1,finished_at=NOW() WHERE id=$2`,
      [e.message, log.id]).catch(() => {});
    await warnIfRepeatedFailures(salon.id).catch(() => {});
    throw e;
  }
}

/** Три подряд error у daily → WARN (три месяца молчания красного runSync — урок п. 1). */
async function warnIfRepeatedFailures(salonId) {
  const rows = await db.any(
    `SELECT status FROM sync_logs WHERE salon_id=$1 AND sync_type='daily'
     ORDER BY started_at DESC LIMIT $2`, [salonId, REPEATED_FAILURES]);
  const allFailed = rows.length >= REPEATED_FAILURES && rows.every(r => r.status === 'error');
  if (allFailed) {
    logger.warn(`salon=${salonId}: ночная сверка с YClients падает ${REPEATED_FAILURES} подряд — ` +
      `clients/records не обновляются, смотри sync_logs`);
  }
  return allFailed;
}

/** При старте процесса: прогон, оборванный рестартом, не должен висеть running вечно. */
async function closeStaleSyncRuns() {
  const r = await db.query(
    `UPDATE sync_logs SET status='error', error_message='процесс перезапущен во время прогона',
     finished_at=NOW() WHERE status='running'`);
  return r?.rowCount || 0;
}

module.exports = {
  RECONCILE_DAYS, changedAfterDate, reconcileDaily, warnIfRepeatedFailures, closeStaleSyncRuns,
  // для тестов/скриптов
  fetchChangedRecords, reconcileRecords, reconcileClient,
};
