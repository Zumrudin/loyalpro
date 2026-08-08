'use strict';
// Живая проверка ТЕСТОВОЙ ОТПРАВКИ напоминания (кнопка «🧪 Тест» в карточке
// правила).
//
//   node scripts/reminders-test-send-e2e.js [--phone 79200255591] [--send] [--accrue]
//
// Без флагов НИЧЕГО НЕ ОТПРАВЛЯЕТ и НИЧЕГО НЕ НАЧИСЛЯЕТ:
//   1) проверяет HTTP-обвязку ручки на живом сервере (401/404/400 — ни одна
//      из этих веток не шлёт сообщение);
//   2) прогоняет боевой путь IN-PROCESS: настоящая строка очереди, настоящий
//      worker.processTestRow, настоящий якорь из YClients — застаблена только
//      сама отправка.
// С --send делает полный круг через HTTP живого сервера, и на указанный номер
// РЕАЛЬНО уходит сообщение. С --accrue бонусы начисляются по-настоящему
// (необратимо).
//
// В отличие от scripts/reminders-e2e.js останавливать pm2 НЕ НУЖНО: тестовая
// строка ставится в БУДУЩЕЕ (test-send.js TEST_LEAD_MS), а боевой тик арендует
// только scheduled_at <= NOW() — перехватить её он не может. Скрипт это
// проверяет явно.

const jwt = require('jsonwebtoken');
const config = require('../config');
const { db, pool } = require('../db');
const worker = require('../services/reminders/worker');
const { buildTestRow, TEST_LEAD_MS } = require('../services/reminders/test-send');
const identity = require('../services/agent/identity');
const routes = require('../routes/reminders');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, def) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : def; };

const PHONE = val('--phone', '79200255591');
const REAL_SEND = flag('--send');
const REAL_ACCRUE = flag('--accrue');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';

let failures = 0;
function check(name, ok, extra) {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

(async () => {
  const salon = await db.oneOrNone(`SELECT id, name FROM salons WHERE is_active = TRUE ORDER BY id LIMIT 1`);
  if (!salon) throw new Error('нет активного салона');
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE salon_id=$1 AND role IN ('owner','admin') ORDER BY id LIMIT 1`,
    [salon.id]);
  if (!user) throw new Error('нет owner/admin в салоне');
  console.log(`салон #${salon.id} «${salon.name}», телефон ${PHONE}, отправка: ${REAL_SEND ? 'РЕАЛЬНАЯ' : 'застаблена'}`);

  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '1h' });
  // routes/index.js сверяет токен ещё и с таблицей sessions — без строки 401.
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1,$2,'127.0.0.1','e2e', NOW() + interval '1 hour')`, [user.id, token]);

  const call = (path, body, useToken = true) => fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(useToken ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body || {}),
  }).then(async r => ({ code: r.status, body: await r.json().catch(() => null) }));

  // Правило создаём ВЫКЛЮЧЕННЫМ — именно так его и тестируют перед запуском.
  const rule = await db.oneOrNone(
    `INSERT INTO reminder_rules
       (salon_id, title, is_enabled, conditions, delay_days, send_time, text_mode, text,
        attribution_days, bonus_enabled, bonus_tiers, backfill_max_per_day)
     VALUES ($1, 'E2E тестовая отправка', FALSE, '{"logic":"and","items":[]}'::jsonb, 30, '11:00',
             'strict', '{first_name}, прошло {дней} дн. после «{услуга}» — пора повторить!',
             30, TRUE,
             '[{"up_to":null,"action":"accrue","amount":1,"text":"{first_name}, начислили {бонусы} бонусов, ждём вас!"}]'::jsonb,
             30)
     RETURNING *`, [salon.id]);
  console.log(`правило #${rule.id} создано (выключено, бонусы включены)`);

  try {
    // ── 1. HTTP-обвязка: ни одна ветка ниже не шлёт сообщение ──
    const noAuth = await call(`/api/reminders/rules/${rule.id}/test`, { phone: PHONE }, false);
    check('без токена → 401', noAuth.code === 401, `код ${noAuth.code}`);

    const noPhone = await call(`/api/reminders/rules/${rule.id}/test`, {});
    check('без телефона → 400', noPhone.code === 400, `${noPhone.code} ${noPhone.body && noPhone.body.error}`);

    const noRule = await call(`/api/reminders/rules/999999999/test`, { phone: PHONE });
    check('чужое/несуществующее правило → 404', noRule.code === 404, `код ${noRule.code}`);

    if (REAL_SEND) {
      // ── 2а. Полный круг через HTTP: сообщение уйдёт по-настоящему ──
      const r = await call(`/api/reminders/rules/${rule.id}/test`, { phone: PHONE, accrue: REAL_ACCRUE });
      check('POST /test → 200', r.code === 200, `код ${r.code}`);
      console.log(JSON.stringify(r.body, null, 2));
      check('строка отправлена', r.body && r.body.status === 'sent', r.body && r.body.reason);
      check('текст отрендерен', !!(r.body && r.body.text));
      if (!REAL_ACCRUE) {
        check('сухой прогон бонусов', !!(r.body && r.body.bonus && r.body.bonus.dryRun));
        check('транзакции не было', !(r.body && r.body.bonus && r.body.bonus.txnOk));
      }
    } else {
      // ── 2б. Боевой путь in-process, застаблена только отправка ──
      // Резолверы берём ИЗ САМОЙ РУЧКИ — иначе скрипт проверял бы свою копию
      // правил поиска карточки и якоря, а не то, что делает сервер.
      const client = await routes.resolveTestClient(salon.id, PHONE);
      check('карточка клиента найдена по номеру', !!client,
        client ? `#${client.id} «${client.name}»` : 'нет карточки — {first_name} будет пустым');
      const ycClientId = (client && client.yclients_client_id)
        || await identity.resolveYclientsClientId(salon.id, PHONE).catch(() => null);
      check('id клиента YClients известен (иначе бонусы недоступны)', !!ycClientId, String(ycClientId));

      let anchor = null;
      try { anchor = await routes.loadTestAnchor(salon.id, ycClientId); }
      catch (e) { console.warn(`якорь из YClients недоступен: ${e.message}`); }
      console.log('якорь:', anchor
        ? `${anchor.visitAt.toISOString()} ${anchor.staffName || ''} ${(anchor.services || []).map(x => x.title).join(', ')}`
        : 'состоявшихся визитов нет — дата из задержки правила');

      const v = buildTestRow({ rule, client, phone: PHONE, anchor, ycClientId });
      const row = await db.oneOrNone(
        `INSERT INTO reminder_queue
           (salon_id, rule_id, rule_title, client_id, phone, yclients_client_id,
            anchor_record_id, anchor_visit_at, anchor_staff_name, anchor_services,
            scheduled_at, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING id, scheduled_at`,
        [v.salon_id, v.rule_id, v.rule_title, v.client_id, v.phone, v.yclients_client_id,
         v.anchor_record_id, v.anchor_visit_at, v.anchor_staff_name,
         JSON.stringify(v.anchor_services), v.scheduled_at, v.source]);

      // Ключевой инвариант: боевой тик (scheduled_at <= NOW()) эту строку не
      // видит — поэтому pm2 останавливать не нужно.
      const due = await db.oneOrNone(
        `SELECT 1 AS x FROM reminder_queue
          WHERE id=$1 AND status='scheduled' AND scheduled_at <= NOW()`, [row.id]);
      check('строка недосягаема для боевого тика', !due,
        `scheduled_at через ${Math.round(TEST_LEAD_MS / 60000)} мин`);

      let sent = null;
      await worker.processTestRow(row.id, { accrue: REAL_ACCRUE }, {
        // Гейт Милы тестовая отправка НЕ обходит (это проверено юнит-тестом
        // «гейт Милы тест не обходит»), но на деве агент выключен в настройках
        // салона, и живой гейт оборвал бы прогон раньше рендера текста и
        // бонусов — ровно того, ради чего скрипт и нужен. Включать агента на
        // деве по-настоящему нельзя: дев подключён к тому же инстансу
        // Chatpush, и Мила начала бы отвечать живым клиентам.
        isAllowed: async () => ({ allow: true, reason: 'e2e-stub' }),
        sendMessage: async (p) => { sent = p; return { id: 'stub', channel: 'telegram' }; },
        rememberPending: async () => {},
        persistWhatsapp: async () => {},
      });

      const after = await db.oneOrNone(
        `SELECT status, decision_reason, rendered_text, balance_before, bonus_tier,
                bonus_accrued, bonus_txn_ok FROM reminder_queue WHERE id=$1`, [row.id]);
      console.log('итог строки:', after);
      check('строка отправлена', after && after.status === 'sent', after && after.decision_reason);
      check('текст ушёл в отправку', !!(sent && sent.text), sent && sent.text);
      if (!REAL_ACCRUE) {
        check('бонусы не начислялись (сухой прогон)', after && after.bonus_txn_ok === null,
          `ступень ${after && after.bonus_tier}, сумма ${after && after.bonus_accrued}`);
        check('в причине видно сухой прогон', /сухой прогон/i.test((after && after.decision_reason) || ''));
      }
      // Анти-повтор — главное, чего тест не должен оставлять после себя.
      const mute = await db.oneOrNone(
        `SELECT muted FROM reminder_suppressions WHERE rule_id=$1 AND phone=$2`, [rule.id, PHONE]);
      check('анти-повтор не выставлен', !mute, mute ? 'строка есть!' : '');
    }
  } finally {
    await db.query(`DELETE FROM reminder_queue WHERE rule_id=$1`, [rule.id]);
    await db.query(`DELETE FROM reminder_suppressions WHERE rule_id=$1`, [rule.id]);
    await db.query(`DELETE FROM reminder_rules WHERE id=$1`, [rule.id]);
    await db.query(`DELETE FROM sessions WHERE token=$1`, [token]).catch(() => {});
    console.log('прибрано');
  }
  console.log(failures ? `\n${failures} проверок упало` : '\nвсе проверки прошли');
  await pool.end();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
