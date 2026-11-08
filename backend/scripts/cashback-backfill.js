#!/usr/bin/env node
'use strict';
// Доначисление кэшбэка за оплаченные визиты, которые боевой путь не начислил.
//
// Когда нужен: пока `loyalty_settings.bonuses_enabled=false`, вебхук по оплаченному визиту
// оставляет в finances_log строку processed=FALSE, cashback_amount=0 («bonuses DISABLED —
// logged only»), и после включения флага повторный вебхук по этой записи уходит в
// «duplicate» — сам визит не доначислится никогда. Плюс визиты, вебхук по которым не дошёл
// вовсе (строки в finances_log нет). Применялся на проде (Selectel) 04.11.2026 за 02–04.11
// (13 визитов, 33 249 ₽) и 08.11.2026 за 03–08.11 (14 визитов, 25 985 ₽).
//
// Запуск (прод, из каталога релиза, под пользователем loyalpro, TZ мск):
//   node scripts/cashback-backfill.js --from 2026-11-03 --to 2026-11-08            (сухой прогон)
//   node scripts/cashback-backfill.js --from … --to … --journal <файл.jsonl> --write  (начисление)
//   --only <id,id>            только эти записи YClients
//   --read-journals <a,b>     журналы прошлых прогонов (по умолчанию — два прогона 2026 года)
//   --enabled-at <ISO>        момент включения bonuses_enabled (по умолчанию — момент запуска)
//   --levels '<json>'         уровни вместо loyalty_settings.levels
//
// Правила начисления строже боевого кода: paid_full=1 и attendance 1|2; ни одной услуги со
// скидкой (discount>0 или cost_to_pay<cost); цена ниже прайса (first_cost>cost) — в ручной
// разбор (решение владельца 04.11); оплата бонусами по YClients /visit/details
// (is_loyalty_withdraw) — отказ; только карта типа салона; уровень — по тратам ДО визита.
// Комментарий транзакции — как у боевого начисления: «Кэшбэк N% за визит #<record>».
//
// Защита от двойного начисления:
//  - записи с окончательным решением в finances_log (processed=TRUE, в т.ч. замки
//    lock_before_20261103 и начисленные) не пересматриваются;
//  - запись ЗАХВАТЫВАЕТСЯ в finances_log ДО вызова YClients (event_status='backfill_claim',
//    processed=TRUE): вебхук по той же записи во время прогона уйдёт в «duplicate»;
//  - журнал намерений пишется ДО вызова YClients; запись с intent без accrued и сбой
//    начисления не повторяются никогда — такие разбираются руками по карте клиента.
const path = require('path');
const B = path.resolve(__dirname, '..');
process.chdir(B);
require('dotenv').config({ path: path.join(B, '.env') });
const fs = require('fs');
const { db } = require('../db');
const yc = require('../services/yclients');
const { getLevel, upsertRecordFromYc } = require('../services/loyalty');
const { upsertClientFromYc } = require('../services/client-upsert');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FROM = arg('--from', null);
const TO = arg('--to', null);
const WRITE = args.includes('--write');
const ONLY = arg('--only', '') ? new Set(arg('--only').split(',').map(String)) : null;
const JOURNAL = arg('--journal', null);
const DEFAULT_OLD_JOURNALS = [
  '/srv/loyalpro/restore/cashback-backfill-20261104.jsonl',
  '/srv/loyalpro/restore/cashback-backfill-20261108.jsonl',
].join(',');
const READ_JOURNALS = [JOURNAL, ...arg('--read-journals', DEFAULT_OLD_JOURNALS).split(',')]
  .map(s => (s || '').trim()).filter(Boolean);
// Строка finances_log processed=FALSE, cashback 0, созданная РАНЬШЕ этого момента, — след
// «bonuses DISABLED»: боевой путь её больше не трогает (повторный вебхук уходит в duplicate).
// Живая заявка боевого пути выглядит иначе (cashback_amount=-1) и не трогается никогда.
const ENABLED_AT = arg('--enabled-at', new Date().toISOString());

if (!FROM || !TO) { console.error('нужны --from YYYY-MM-DD и --to YYYY-MM-DD'); process.exit(2); }
if (WRITE && !JOURNAL) { console.error('для --write нужен --journal <файл.jsonl>'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

function readJournals() {
  const m = new Map();
  for (const file of READ_JOURNALS) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const j = JSON.parse(line);
      if (!m.has(String(j.record))) m.set(String(j.record), new Set());
      m.get(String(j.record)).add(j.stage);
    }
  }
  return m;
}
function journal(o) { fs.appendFileSync(JOURNAL, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n'); }

async function fetchRecords(salon) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const part = await yc.ycGet(salon, `/records/${salon.yclients_company_id}`,
      { start_date: FROM, end_date: TO, count: 200, page });
    out.push(...part);
    if (part.length < 200) break;
    await sleep(400);
  }
  return out;
}

function evalServices(services) {
  let paid = 0; const flags = [];
  for (const s of services) {
    const cost = num(s.cost), pay = num(s.cost_to_pay ?? s.cost), disc = num(s.discount), first = num(s.first_cost);
    if (disc > 0 || pay < cost) flags.push(`discount svc ${s.id} (d${disc}, ${pay}<${cost})`);
    else if (first > cost + 0.009) flags.push(`price_below_list svc ${s.id} (${cost}<${first})`);
    paid += pay;
  }
  return { paid, flags };
}

(async () => {
  const salon = await db.one('SELECT * FROM salons WHERE id=1');
  const ls = await db.oneOrNone('SELECT levels FROM loyalty_settings WHERE salon_id=$1', [salon.id]);
  let LEVELS = typeof ls?.levels === 'string' ? JSON.parse(ls.levels) : ls?.levels;
  if (arg('--levels')) LEVELS = JSON.parse(arg('--levels'));
  if (!Array.isArray(LEVELS) || !LEVELS.length) throw new Error('уровни не настроены');
  console.log('УРОВНИ', LEVELS.map(l => `${l.key} от ${l.minSpent} → ${l.cashback}%`).join('; '));
  console.log('ПЕРИОД', FROM, '…', TO, WRITE ? '(WRITE)' : '(сухой прогон)', ONLY ? `only=${[...ONLY].join(',')}` : '',
    'enabled_at', ENABLED_AT);

  const done = readJournals();
  const recs = await fetchRecords(salon);
  const rows = [];
  // Все оплаты клиента внутри окна (и начисляемые, и отклонённые) — уровень по тратам ДО визита.
  const paidByClient = new Map();

  for (const r of recs) {
    const inScope = !ONLY || ONLY.has(String(r.id));
    if (r.deleted) { if (inScope) rows.push({ record: r.id, date: r.date, verdict: 'skip_deleted' }); continue; }
    const paidOk = r.paid_full === 1 && (r.attendance === 1 || r.attendance === 2);
    if (!paidOk) {
      if (inScope) rows.push({ record: r.id, date: r.date, phone: r.client?.phone, name: r.client?.name,
        verdict: 'skip_not_paid', note: `paid_full=${r.paid_full} attendance=${r.attendance}` });
      continue;
    }
    let services = r.services || [];
    if (!services.length) { services = (await yc.ycGet(salon, `/record/${salon.yclients_company_id}/${r.id}`)).services || []; await sleep(300); }
    const { paid, flags } = evalServices(services);
    if (paid > 0) {
      const k = String(r.client?.id);
      paidByClient.set(k, [...(paidByClient.get(k) || []), { date: r.date, paid, id: r.id }]);
    }
    if (!inScope) continue;

    const row = { record: r.id, date: r.date, client_yc: r.client?.id, phone: r.client?.phone, name: r.client?.name, paid };
    rows.push(row);

    const fl = await db.oneOrNone(
      `SELECT event_status, processed, cashback_amount::float8 AS cb, created_at FROM finances_log WHERE yclients_record_id=$1`, [r.id]);
    row.fl = fl ? `${fl.event_status}/${fl.processed ? 'done' : 'open'}/${fl.cb}` : 'нет строки';
    if (fl && fl.cb > 0) { row.verdict = 'skip_already_in_db'; continue; }
    if (fl && fl.processed) { row.verdict = 'skip_decided'; row.note = `решение уже принято: ${fl.event_status}`; continue; }
    if (fl && fl.cb < 0) { row.verdict = 'MANUAL_live_claim'; continue; }
    if (fl && new Date(fl.created_at) >= new Date(ENABLED_AT)) { row.verdict = 'MANUAL_after_enable'; continue; }
    row.claim = fl ? 'pending' : 'insert';
    const st = done.get(String(r.id));
    if (st?.has('accrued')) { row.verdict = 'skip_already_accrued'; continue; }
    if (st?.has('intent')) { row.verdict = 'MANUAL_intent_without_result'; continue; }

    if (flags.some(f => f.startsWith('discount'))) { row.verdict = 'deny_discount'; row.note = flags.join('; '); continue; }
    if (paid <= 0) { row.verdict = 'deny_zero_paid'; continue; }
    if (flags.length) { row.verdict = 'deny_price_below_list'; row.note = flags.join('; '); continue; }

    if (!r.visit_id) throw new Error(`visit_id нет у записи ${r.id}`);
    const det = await yc.ycGet(salon, `/visit/details/${salon.yclients_company_id}/${r.id}/${r.visit_id}`);
    await sleep(300);
    const withdraw = (det?.loyalty_transactions || []).filter(t => t.is_loyalty_withdraw === true);
    if (withdraw.length) { row.verdict = 'deny_paid_with_bonuses'; row.note = withdraw.map(t => t.amount).join(','); continue; }

    const cards = await yc.ycGetClientCardsStrict(salon, r.client.id);
    await sleep(300);
    const card = cards.find(c => String(c.type?.id) === String(salon.yclients_card_type_id));
    if (!card) { row.verdict = 'skip_no_card'; row.note = `cards: ${cards.map(c => c.type?.title).join(',') || 'нет'}`; continue; }
    row.card_id = card.id; row.card_number = card.number; row.card_balance_before = num(card.balance);

    const ycClient = await yc.ycGet(salon, `/client/${salon.yclients_company_id}/${r.client.id}`);
    await sleep(300);
    row.ycClient = ycClient;
    row.spent_now = num(ycClient.spent ?? ycClient.paid);
    row.verdict = 'accrue';
  }

  // Уровень — по тратам ДО визита: из текущих трат вычитаем этот и более поздние оплаты окна.
  for (const row of rows.filter(x => x.verdict === 'accrue')) {
    const later = (paidByClient.get(String(row.client_yc)) || []).filter(v => v.date >= row.date);
    row.spent_before = Math.max(0, row.spent_now - later.reduce((s, v) => s + v.paid, 0));
    const lvlNow = getLevel(row.spent_now, LEVELS), lvl = getLevel(row.spent_before, LEVELS);
    row.pct = lvl.cashback; row.level = lvl.key;
    if (lvlNow.key !== lvl.key) row.note = `уровень сменился этим визитом: ${lvl.key}→${lvlNow.key}`;
    row.cashback = Math.floor(row.paid * row.pct / 100);
  }

  let total = 0;
  for (const row of rows) {
    console.log([row.record, row.date, row.verdict, row.phone || '', row.name || '', row.paid ?? '',
      row.pct ? row.pct + '%' : '', row.cashback ?? '', row.card_number ? `карта ${row.card_number}` : '',
      row.spent_before != null ? `spent_before=${row.spent_before}` : '', row.fl || '', row.note || ''].join(' | '));
    if (row.verdict === 'accrue') total += row.cashback;
  }
  const counts = rows.reduce((m, r) => (m[r.verdict] = (m[r.verdict] || 0) + 1, m), {});
  console.log('ИТОГО', JSON.stringify(counts), 'к начислению', total, '₽', WRITE ? '(WRITE)' : '(сухой прогон)');
  if (!WRITE) process.exit(0);

  const settings = await db.oneOrNone('SELECT levels FROM loyalty_settings WHERE salon_id=$1', [salon.id]);
  for (const row of rows.filter(x => x.verdict === 'accrue' && x.cashback > 0)) {
    // Захват записи ДО вызова YClients.
    const claimed = row.claim === 'pending'
      ? await db.oneOrNone(
          `UPDATE finances_log SET event_status='backfill_claim', processed=TRUE
            WHERE yclients_record_id=$1 AND processed=FALSE AND cashback_amount=0 AND created_at < $2::timestamptz
            RETURNING id`, [row.record, ENABLED_AT])
      : await db.oneOrNone(
          `INSERT INTO finances_log (salon_id,yclients_record_id,client_id,event_status,processed,cashback_amount)
           VALUES ($1,$2,(SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$3),'backfill_claim',TRUE,0)
           ON CONFLICT (yclients_record_id) DO NOTHING RETURNING id`, [salon.id, row.record, row.client_yc]);
    if (!claimed) {
      journal({ record: row.record, stage: 'claim_lost' });
      console.log('ПРОПУСК', row.record, '— строка finances_log изменилась после сухого прогона, не начисляю');
      continue;
    }
    const title = `Кэшбэк ${row.pct}% за визит #${row.record}`;
    journal({ record: row.record, stage: 'intent', card: row.card_id, amount: row.cashback, title });
    try {
      const res = await yc.ycAccrueCard(salon, row.card_id, row.cashback, title);
      journal({ record: row.record, stage: 'accrued', card: row.card_id, amount: row.cashback, res });
    } catch (e) {
      journal({ record: row.record, stage: 'error', error: e.message });
      console.log('ОШИБКА начисления', row.record, e.message, '— захват оставлен, проверить карту вручную');
      continue;
    }
    await sleep(400);
    try {
      const client = await upsertClientFromYc(salon.id, row.ycClient, settings);
      const cards = await yc.ycGetClientCardsStrict(salon, row.client_yc);
      const card = cards.find(c => String(c.id) === String(row.card_id));
      const bal = card ? num(card.balance) : row.card_balance_before + row.cashback;
      await db.query(
        `UPDATE clients SET yclients_card_id=$1, yclients_card_number=COALESCE($2, yclients_card_number),
           yclients_card_balance=$3::numeric, bonus_balance=$3::numeric, last_visit_at=GREATEST(last_visit_at,$4::timestamptz), updated_at=NOW()
         WHERE id=$5`,
        [row.card_id, card?.number || null, bal, row.date, client.id]);
      const rec = await upsertRecordFromYc(salon.id, recs.find(r => r.id === row.record), client.id, 'backfill');
      await db.query('UPDATE records SET bonus_processed=TRUE, bonus_accrued=$1, cashback_pct=$2 WHERE id=$3',
        [row.cashback, row.pct, rec.id]);
      await db.query(
        `INSERT INTO loyalty_card_transactions (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,record_id,txn_date,created_at)
         VALUES ($1,$2,$3,'accrual',$4::numeric,$5::numeric,$6,$7,NOW(),NOW())`,
        [salon.id, client.id, row.card_id, row.cashback, bal, title, rec.id]);
      await db.query(
        `INSERT INTO finances_log (salon_id,yclients_record_id,client_id,event_status,paid_amount,cashback_pct,card_id,processed,cashback_amount)
         VALUES ($1,$2,$3,'backfill',$4::numeric,$5::numeric,$6,TRUE,$7::numeric)
         ON CONFLICT (yclients_record_id) DO UPDATE SET event_status='backfill', client_id=EXCLUDED.client_id,
           paid_amount=EXCLUDED.paid_amount, cashback_pct=EXCLUDED.cashback_pct, card_id=EXCLUDED.card_id,
           processed=TRUE, cashback_amount=EXCLUDED.cashback_amount`,
        [salon.id, row.record, client.id, row.paid, row.pct, row.card_id, row.cashback]);
      journal({ record: row.record, stage: 'db_written', client_id: client.id, balance: bal });
      console.log('OK', row.record, row.cashback, '→ карта', row.card_number, 'баланс', bal);
    } catch (e) {
      journal({ record: row.record, stage: 'db_error', error: e.message });
      console.log('ОШИБКА записи в БД', row.record, e.message, '(в YClients начислено!)');
    }
  }

  // Отказы по открытым строкам — окончательное решение (как ставит боевой путь), чтобы
  // будущий вебхук по этим записям их не пересчитывал. Закрытые строки не трогаем.
  for (const row of rows.filter(x => /^(deny_|skip_no_card)/.test(x.verdict))) {
    const c = await db.oneOrNone('SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salon.id, row.client_yc]);
    await db.query(
      `INSERT INTO finances_log (salon_id,yclients_record_id,client_id,event_status,paid_amount,processed,cashback_amount)
       VALUES ($1,$2,$3,'backfill_deny',$4::numeric,TRUE,0)
       ON CONFLICT (yclients_record_id) DO UPDATE SET event_status='backfill_deny', processed=TRUE, cashback_amount=0
       WHERE finances_log.cashback_amount = 0 AND finances_log.processed = FALSE`,
      [salon.id, row.record, c?.id || null, row.paid || 0]);
  }
  console.log('Готово');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
