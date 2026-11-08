#!/usr/bin/env node
'use strict';
// Пересверка доставки ПРОШЕДШЕЙ рассылки через мессенджеры по текущим статусам провайдера.
// ЗАЧЕМ: до 06.11.2026 сверка читала коды Chatpush по таблице нашего шлюза — «Прочитано» (16) и «адресата нет
// в мессенджере» (55/58) ложились как «доставка неизвестна» (рассылка №3: 23 из 90). Скрипт перечитывает статус
// у провайдера (GET /delivery/:id) и пишет вердикт ТОЙ ЖЕ функцией, что и воркер (worker.deliveryVerdict поверх
// services/messaging/delivery-status.js), — третьей копии правил нет.
//
//   node scripts/broadcast-messengers-recheck.js --id=<broadcastId> [--write]
//
// По умолчанию СУХОЙ ПРОГОН: чтение БД и GET-запросы статуса к провайдеру, сообщений не шлёт. --write — записать.
// Берутся строки status='sent' с delivery_id и delivery_status 'unknown' или 'accepted' (вердикта не было).
// «Доставлено/Прочитано» → delivered; «нет в мессенджере» → undeliverable с текстом отказа в error; «в пути»,
// статус 5 и сбой чтения — строка не трогается (старый статус 5 исход не доказывает). Каскад НЕ продолжается:
// рассылка закончилась, а «не доставлено» попадает в «Новую рассылку по пропущенным». Идущую рассылку
// (pending/in_progress) не трогает — её сверяет воркер. В вывод — только id строк и мессенджеры, без номеров.
const { db, pool } = require('../db');
const transport = require('../services/messaging/transport');
const worker = require('../services/broadcast-messengers/worker');

const args = process.argv.slice(2);
const idArg = args.find((a) => a.startsWith('--id='));
const WRITE = args.includes('--write');
const extra = args.filter((a) => a !== idArg && a !== '--write');
const ID = idArg ? Number(idArg.slice(5)) : NaN;
if (!Number.isInteger(ID) || ID <= 0 || extra.length) {
  console.error('usage: node scripts/broadcast-messengers-recheck.js --id=<broadcastId> [--write]');
  if (extra.length) console.error(`неизвестные аргументы: ${extra.join(' ')}`);
  process.exit(2);
}
const PAUSE_MS = 300; // бережём API провайдера: по одному запросу

const NEW_STATUS = { delivered: 'delivered', not_registered: 'undeliverable', undeliverable: 'undeliverable' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await db.oneOrNone(`SELECT id, salon_id, status FROM broadcasts WHERE id = $1 AND transport = 'messengers'`, [ID]);
  if (!b) throw new Error(`мессенджерной рассылки #${ID} нет`);
  if (['pending', 'in_progress'].includes(b.status)) throw new Error(`рассылка #${ID} ещё идёт (${b.status}) — её сверяет воркер`);

  const rows = await db.any(
    `SELECT id, channel, delivery_id, account_id, delivery_status, sent_at FROM broadcast_recipients
      WHERE broadcast_id = $1 AND status = 'sent' AND delivery_id IS NOT NULL AND delivery_status IN ('unknown','accepted')
      ORDER BY id`, [ID]);
  console.log(`рассылка #${ID} (${b.status}): к пересверке ${rows.length}; режим — ${WRITE ? 'ЗАПИСЬ' : 'сухой прогон'}`);

  const tally = {};
  const changes = [];
  for (const r of rows) {
    let note;
    let next = null;
    let reason = null;
    try {
      const st = await transport.getDeliveryStatus(b.salon_id, r.channel, r.delivery_id, { accountId: r.account_id });
      const ageMs = r.sent_at ? Date.now() - new Date(r.sent_at).getTime() : NaN;
      const verdict = worker.deliveryVerdict(st, ageMs, r.delivery_id);
      next = NEW_STATUS[verdict] || null;
      const desc = (st && st.status && String(st.status.description || '')) || '';
      if (verdict === 'not_registered') reason = desc || null;
      note = st && st.status ? `${st.status.status_id} «${desc}»` : 'статуса нет';
    } catch (e) {
      note = `сбой чтения: ${e.message}`;
    }
    console.log(`  #${r.id} ${r.channel}: ${r.delivery_status} → ${next || 'без изменений'} (${note})`);
    const key = `${r.channel} ${r.delivery_status}→${next || r.delivery_status}`;
    tally[key] = (tally[key] || 0) + 1;
    if (next) changes.push({ r, next, reason });
    await sleep(PAUSE_MS);
  }
  console.log('итог:', Object.entries(tally).map(([k, n]) => `${k}: ${n}`).join('; ') || 'нечего сверять');

  if (!WRITE) {
    if (changes.length) console.log(`сухой прогон: изменится ${changes.length} строк; записать — тем же вызовом с --write`);
    return;
  }
  let written = 0;
  for (const { r, next, reason } of changes) {
    // Условие на прежний delivery_status: строку, которую успели поменять (вручную/воркером), не перетираем.
    const res = await db.query(
      `UPDATE broadcast_recipients SET delivery_status = $3, error = COALESCE($4, error), checked_at = NOW()
        WHERE id = $1 AND broadcast_id = $2 AND status = 'sent' AND delivery_status = $5`,
      [r.id, ID, next, reason, r.delivery_status]);
    written += res.rowCount || 0;
  }
  console.log(`записано: ${written} из ${changes.length}`);
})().then(() => pool.end()).catch(async (e) => {
  console.error('ОШИБКА:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
