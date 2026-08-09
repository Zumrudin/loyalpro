'use strict';
// Живая проверка ОКНА ДОГОНА по базе (кнопка «👁 Выборка» → «Показать выборку»).
//
//   node scripts/reminders-backfill-window-e2e.js
//
// НИЧЕГО НЕ ПИШЕТ в очередь и НИЧЕГО НЕ ОТПРАВЛЯЕТ: дёргается только
// /backfill/preview — ручка сухого прогона. Временное правило создаётся
// ВЫКЛЮЧЕННЫМ и удаляется в finally.
//
// ЗАЧЕМ отдельно от юнит-тестов: инцидент 09.08.2026 (прод) — администратор
// задал 585 дней, чтобы догон взял клиентов с 01.01.2025, а обе ручки молча
// обрезали период до 90 (Math.min(90, …)), и в очередь легли только визиты за
// 3 месяца. Второй, независимый потолок — 25 страниц выдачи YClients (5000
// записей): выдача /records идёт от свежих к старым, поэтому упёршийся в него
// догон терял РОВНО старый хвост. Оба потолка юнит-тестом не проверяются: один
// живёт в маршруте, второй — в реальном объёме боевого каталога записей.
//
// Проверяем на живом сервере:
//   1) days=585 доезжает как есть (clamped=false) — прежний код вернул бы 90;
//   2) записей за период БОЛЬШЕ прежнего потолка 5000 и выдача не обрезана;
//   3) визит эталонного клиента (год с лишним назад) реально попал в выборку;
//   4) запрос сверх потолка обрезается ЯВНО (clamped=true), а не молча.

const jwt = require('jsonwebtoken');
const config = require('../config');
const { db, pool } = require('../db');

const args = process.argv.slice(2);
const val = (n, def) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : def; };

const DAYS = Number(val('--days', 585));
// Эталон: пациентка с ботулинотерапией 09.09.2025 — та самая, из-за которой
// вскрылось обрезание окна. Год с лишним назад, в старое окно не попадала.
const REF_PHONE = val('--phone', '79165000564');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';

// Услуги ботулинотерапии боевого каталога PERI (условия правила #2 прода).
const BOTOX_IDS = [9536676, 9536677, 9536678, 15394043, 15394044, 15394045, 15394046,
  15394047, 15394048, 15394050, 15394051, 15394052, 15394053, 15394054, 15394056,
  25013124, 17987378, 17987379, 17987380, 17987381, 17987382, 17987383, 17987384,
  17987386, 17987385, 17987387, 17987388, 17987389, 17987390, 17987391, 15394018];

let failures = 0;
function check(name, ok, extra) {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

(async () => {
  const salon = await db.oneOrNone(
    `SELECT id, name FROM salons WHERE yclients_company_id IS NOT NULL ORDER BY id LIMIT 1`);
  if (!salon) throw new Error('нет салона с настроенным YClients');
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE salon_id=$1 AND role IN ('owner','admin') ORDER BY id LIMIT 1`,
    [salon.id]);
  if (!user) throw new Error('нет owner/admin в салоне');

  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '1h' });
  // routes/index.js сверяет токен ещё и с таблицей sessions — без строки 401.
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1,$2,'127.0.0.1','e2e', NOW() + interval '1 hour')`, [user.id, token]);

  const rule = await db.oneOrNone(
    `INSERT INTO reminder_rules
       (salon_id, title, is_enabled, conditions, delay_days, send_time, text_mode, text,
        attribution_days, bonus_enabled, bonus_tiers, backfill_max_per_day)
     VALUES ($1, 'E2E окно догона', FALSE, $2::jsonb, 180, '12:00', 'strict',
             '{first_name}, пора повторить!', 14, FALSE, '[]'::jsonb, 30)
     RETURNING id`,
    [salon.id, JSON.stringify({ logic: 'and', items: [{ type: 'service', ids: BOTOX_IDS }] })]);

  console.log(`салон #${salon.id} «${salon.name}», временное правило #${rule.id}, окно ${DAYS} дн.`);

  const preview = (days) => fetch(`${BASE}/api/reminders/rules/${rule.id}/backfill/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ days }),
  }).then(async r => ({ code: r.status, body: await r.json().catch(() => null) }));

  try {
    const t = Date.now();
    const wide = await preview(DAYS);
    const secs = Math.round((Date.now() - t) / 1000);
    if (wide.code !== 200) throw new Error(`превью вернуло ${wide.code}: ${JSON.stringify(wide.body)}`);
    const d = wide.body;
    console.log(`превью за ${secs} c: записей ${d.totals.records}, под условия ${d.totals.matched}, ` +
                `уйдёт ${d.totals.willSend}, клиентов ${d.totals.clients}, с ${d.startDate}`);

    check('период не обрезан', d.days === DAYS && d.clamped === false, `days=${d.days}`);
    check('записей больше прежнего потолка 5000', d.totals.records > 5000, `${d.totals.records}`);
    check('выдача YClients не обрезана', d.truncated === false,
      d.truncated ? `самая старая доставшаяся запись ${d.oldestFetched}` : `с ${d.oldestFetched}`);

    const ref = d.rows.filter(r => r.phone === REF_PHONE);
    check(`эталонный клиент ${REF_PHONE} есть в выборке`, ref.length > 0,
      ref.map(r => `${String(r.visitAt).slice(0, 10)} → ${r.skipReason || 'уйдёт'}`).join('; '));
    check('его визит старше прежнего окна в 90 дней',
      ref.some(r => Date.parse(r.visitAt) < Date.now() - 90 * 86400000));

    // Одна строка на клиента — инвариант дедупликации (иначе живой человек
    // получит два напоминания). Проверяем на ВСЕЙ выборке, а не на эталоне.
    const sendable = d.rows.filter(r => !r.skipReason).map(r => r.phone);
    check('на клиента не больше одной строки к отправке',
      new Set(sendable).size === sendable.length,
      `${sendable.length} строк / ${new Set(sendable).size} телефонов`);

    const over = await preview(100000);
    check('запрос сверх потолка обрезан ЯВНО',
      over.code === 200 && over.body.clamped === true && over.body.days === over.body.maxDays,
      `days=${over.body && over.body.days}, clamped=${over.body && over.body.clamped}`);
  } finally {
    await db.query(`DELETE FROM reminder_rules WHERE id=$1`, [rule.id]);
    await db.query(`DELETE FROM sessions WHERE token=$1`, [token]);
  }

  console.log(failures ? `\n❌ провалов: ${failures}` : '\n✅ всё сошлось');
  await pool.end();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
