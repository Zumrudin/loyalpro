'use strict';
// ============================================================
// Живая сквозная проверка своего WhatsApp-шлюза (gateway/, Baileys) на деве.
// ВНИМАНИЕ: шлёт ОДНО РЕАЛЬНОЕ WhatsApp-сообщение на указанный номер с
// подключённого аккаунта салона. Ничего не стабит. Запускать только с владельцем.
//   node scripts/gateway-whatsapp-e2e.js --phone 79250177778 [--salon 1]
// Без --phone скрипт отказывается работать (чтобы не написать случайному номеру).
// Предусловия: у салона активная строка messenger_accounts provider='gateway'
// channel='whatsapp' с auth_state='ready', процесс loyalpro-gateway запущен,
// в backend/.env заданы MESSAGING_GATEWAY_*.
// Путь: бэкенд → шлюз → Baileys → WhatsApp → эхо → вебхук → бэкенд.
// Проверки (PASS/FAIL по каждой, код выхода 1 при любом FAIL):
//  1. delivery id вида g<n> и accountId аккаунта шлюза;
//  2. ровно ОДНА строка chatpush_messages (salon, phone, text) — свою отправку
//     персистит бэкенд (как диспетчер), эхо шлюза ложится в тот же ключ api:g<n>
//     (раньше или позже персиста) и второй строки не создаёт; channel=whatsapp,
//     authored_by='agent', external_message_id ~ /^api:g\d+$/;
//  3. в chatpush_events есть событие provider='gateway' с delivery_id = d.id
//     (им сторож agent_reply_deliveries подтверждает доставку);
//  4. статус доставки по аккаунту — «Отправлено» (status_id 2) за 30 с.
// ============================================================
require('dotenv').config();
const { db } = require('../db');
const transport = require('../services/messaging/transport');
const accounts = require('../services/messaging/accounts');
const authorship = require('../services/outgoing-authorship');
const chatPersist = require('../services/chat-persist');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const phone = String(arg('--phone', '') || '').replace(/\D/g, '');
const SALON = Number(arg('--salon', '1'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
  return ok;
};
const abort = (m) => { console.error('FAIL:', m); process.exit(1); };

(async () => {
  if (!phone) abort('обязателен аргумент --phone <цифры номера>: скрипт шлёт реальное сообщение');
  const dbName = (await db.oneOrNone('SELECT current_database() AS n')).n;
  console.log(`БД: ${dbName}, салон ${SALON}, номер ${phone}`);

  const creds = await accounts.credentialsFor(SALON, 'whatsapp');
  if (!creds || creds.provider !== 'gateway') abort(`whatsapp салона ${SALON} не на шлюзе: ${JSON.stringify(creds && { provider: creds.provider, id: creds.id })}`);
  const acc = await db.oneOrNone('SELECT id, auth_state, phone FROM messenger_accounts WHERE id=$1 AND salon_id=$2', [creds.id, SALON]);
  if (!acc || acc.auth_state !== 'ready') abort(`аккаунт шлюза #${creds.id} не в состоянии ready: ${acc && acc.auth_state}`);
  console.log(`аккаунт шлюза #${acc.id} (${acc.phone}) ready`);

  const text = `e2e шлюз WhatsApp ${new Date().toISOString()}`;
  await authorship.remember(SALON, phone, text, 'agent');
  const d = await transport.sendMessage(SALON, { text, phone, dispatchRouting: ['whatsapp'] });
  console.log('delivery:', JSON.stringify({ id: d.id, accountId: d.accountId, channels: d.channels, status: d.status }));
  check('delivery id вида g<n>', /^g\d+$/.test(String(d.id)), String(d.id));
  check('accountId совпадает с аккаунтом шлюза', Number(d.accountId) === Number(acc.id), `${d.accountId} / ${acc.id}`);
  if (!/^g\d+$/.test(String(d.id))) abort('без delivery id дальше проверять нечего');

  // Персист своей отправки — как делает диспетчер (transport сам строку не пишет).
  await chatPersist.persistWhatsappOutgoing(SALON, { delivery: d, phone, chatId: null, text, msgType: 'text', authoredBy: 'agent' });

  // Ждём эхо шлюза (событие с этим delivery_id), до 30 с; оно могло прийти и раньше персиста.
  let ev = null;
  for (let i = 0; i < 30 && !ev; i++) {
    ev = await db.oneOrNone(
      `SELECT id, provider FROM chatpush_events
        WHERE provider='gateway' AND payload->'payload'->>'delivery_id' = $1 ORDER BY id DESC LIMIT 1`,
      [String(d.id)]);
    if (!ev) await sleep(1000);
  }
  check('событие provider=gateway с этим delivery_id в chatpush_events', !!ev, ev ? `событие #${ev.id}` : 'не пришло за 30 с — сторож доставки не подтвердит реплику');
  if (ev) await sleep(1500); // дать вебхуку дописать строку чата

  const rows = await db.any(
    `SELECT id, channel, direction, authored_by, provider, external_message_id
       FROM chatpush_messages WHERE salon_id=$1 AND phone=$2 AND text=$3 ORDER BY id`,
    [SALON, phone, text]);
  console.log('rows:', JSON.stringify(rows));
  check('ровно одна строка чата (эхо не задвоило)', rows.length === 1, `строк: ${rows.length}`);
  const row = rows[0];
  if (row) {
    check('channel=whatsapp, direction=outgoing', row.channel === 'whatsapp' && row.direction === 'outgoing', `${row.channel}/${row.direction}`);
    check('authored_by=agent', row.authored_by === 'agent', String(row.authored_by));
    check('external_message_id вида api:g<n>', /^api:g\d+$/.test(String(row.external_message_id)), String(row.external_message_id));
  } else {
    check('строка чата существует', false, 'нет ни одной');
  }

  let st = null;
  for (let i = 0; i < 30; i++) {
    st = await transport.getDeliveryStatus(SALON, 'whatsapp', d.id, { accountId: d.accountId }).catch(() => null);
    if (st && st.status && Number(st.status.status_id) === 2) break;
    await sleep(1000);
  }
  console.log('status:', JSON.stringify(st && st.status));
  check('статус доставки «Отправлено» (status_id 2) за 30 с', !!(st && st.status && Number(st.status.status_id) === 2));

  console.log(failed ? `ИТОГ: FAIL (${failed})` : 'ИТОГ: PASS');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
