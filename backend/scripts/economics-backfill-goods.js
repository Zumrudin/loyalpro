#!/usr/bin/env node
'use strict';
// Разовый догон товарных транзакций YClients в goods_transactions помесячно.
//   node scripts/economics-backfill-goods.js --salon=1 --from=2025-10-01 [--to=YYYY-MM-DD] [--write]
// БЕЗ --write — сухой прогон: читает YClients и разбирает строки, в БД не пишет.
// Идемпотентен (UNIQUE salon+yclients_txn_id). Пауза между страницами 400 мс,
// повтор на 429 через 60 с. Нужен ОДИН раз при включении модуля: цены поступлений
// до 21.03.2026 (начало вебхуков) иначе неизвестны. Квота YClients минутная и
// общая с Милой/«Заботой» — длинный период гонять вне ночного окна Милы.
const { db, pool } = require('../db');
const { backfillGoodsTransactions } = require('../services/economics/sync');

const opt = (name) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const salonId = Number(opt('salon') || 1);
const from = opt('from');
const to = opt('to') || undefined;
const write = process.argv.includes('--write');
if (!from) { console.error('нужен --from=YYYY-MM-DD'); process.exit(2); }

(async () => {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1 AND is_active', [salonId]);
  if (!salon) { console.error(`салон ${salonId} не найден`); process.exit(2); }
  console.log(write ? 'РЕЖИМ ЗАПИСИ в goods_transactions' : 'сухой прогон (без --write в БД не пишем)');
  const t0 = Date.now();
  const r = await backfillGoodsTransactions(salon, {
    from, to, dryRun: !write,
    onMonth: m => console.log(`${m.start}..${m.end}: ${m.upserted} строк (приходов ${m.receipts}), ${m.skipped} пропущено, ${m.pages} стр.`),
  });
  console.log(`итого: ${r.months} мес., ${r.upserted} строк, ${r.skipped} пропущено, ${Math.round((Date.now() - t0) / 1000)} с`);
  if (write) {
    const cnt = await db.oneOrNone('SELECT count(*)::int AS n, min(create_date) AS mn, max(create_date) AS mx FROM goods_transactions WHERE salon_id=$1', [salonId]);
    console.log('goods_transactions:', cnt);
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
