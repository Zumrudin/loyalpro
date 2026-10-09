'use strict';
// ============================================================
// Живая проверка своего Telegram-шлюза (gateway/) на деве. НИЧЕГО не стабит:
// шлёт РЕАЛЬНОЕ сообщение на тестовый номер через transport и ждёт эха в
// chatpush_messages — то есть проверяет весь путь «бэкенд → шлюз → TDLib →
// Telegram → updateMessageSendSucceeded → вебхук → бэкенд».
//   node scripts/gateway-telegram-e2e.js [--phone 79200255591] [--salon 1]
// Предусловия: у салона активная строка messenger_accounts provider='gateway'
// channel='tdlib' с auth_state='ready' (подключена через Настройки → Мессенджеры),
// процесс loyalpro-gateway запущен, в backend/.env заданы MESSAGING_GATEWAY_*.
// Проверяет: (1) delivery id вида g<n> и accountId строки шлюза; (2) эхо
// исходящего легло в chatpush_messages с channel=tdlib, authored_by='agent'
// (авторство пишем заранее, как диспетчер), provider='gateway', составным
// external_message_id; (3) статус доставки по аккаунту — «Отправлено»;
// (4) сырое событие с этим delivery_id есть в chatpush_events — им сторож
// agent_reply_deliveries подтверждает доставку.
// ============================================================
require('dotenv').config();
const { db } = require('../db');
const transport = require('../services/messaging/transport');
const accounts = require('../services/messaging/accounts');
const authorship = require('../services/outgoing-authorship');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const phone = arg('--phone', '79200255591');
const SALON = Number(arg('--salon', '1'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fail = (m) => { throw new Error(m); };

(async () => {
  const dbName = (await db.oneOrNone('SELECT current_database() AS n')).n;
  console.log(`БД: ${dbName}, салон ${SALON}, номер ${phone}`);

  const creds = await accounts.credentialsFor(SALON, 'tdlib');
  if (!creds || creds.provider !== 'gateway') fail(`tdlib салона ${SALON} не на шлюзе: ${JSON.stringify(creds && { provider: creds.provider, id: creds.id })}`);
  const acc = await db.oneOrNone('SELECT id, auth_state, phone FROM messenger_accounts WHERE id=$1 AND salon_id=$2', [creds.id, SALON]);
  if (!acc || acc.auth_state !== 'ready') fail(`аккаунт шлюза #${creds.id} не в состоянии ready: ${acc && acc.auth_state}`);
  console.log(`аккаунт шлюза #${acc.id} (${acc.phone}) ready`);

  const text = `Проверка шлюза ${new Date().toISOString().slice(11, 19)}`;
  await authorship.remember(SALON, phone, text, 'agent');
  const d = await transport.sendMessage(SALON, { text, phone, dispatchRouting: ['tdlib'] });
  console.log('delivery:', JSON.stringify({ id: d.id, accountId: d.accountId, channels: d.channels, status: d.status }));
  if (!/^g\d+$/.test(String(d.id))) fail('ожидался id вида g<n>');
  if (Number(d.accountId) !== Number(acc.id)) fail(`accountId ${d.accountId} ≠ ${acc.id}`);

  let row = null;
  for (let i = 0; i < 40 && !row; i++) {
    await sleep(1000);
    row = await db.oneOrNone(
      `SELECT id, channel, direction, authored_by, provider, salon_id, external_message_id
         FROM chatpush_messages WHERE salon_id=$1 AND phone=$2 AND text=$3 ORDER BY id DESC LIMIT 1`,
      [SALON, phone, text]);
  }
  console.log('echo row:', JSON.stringify(row));
  if (!row) fail('эхо исходящего не пришло за 40 с');
  if (row.channel !== 'tdlib' || row.direction !== 'outgoing') fail('эхо не tdlib/outgoing');
  if (row.authored_by !== 'agent') fail(`authored_by=${row.authored_by}, ожидался agent`);
  if (row.provider !== 'gateway') fail(`provider=${row.provider}, ожидался gateway`);
  if (!/^-?\d+:\d+$/.test(row.external_message_id)) fail('external_message_id не составной');

  const st = await transport.getDeliveryStatus(SALON, 'tdlib', d.id, { accountId: d.accountId });
  console.log('status:', JSON.stringify(st && st.status));
  if (!st || Number(st.status.status_id) !== 2) fail('статус не «Отправлено» (2)');

  const ev = await db.oneOrNone(`SELECT id FROM chatpush_events WHERE payload->'payload'->>'delivery_id' = $1`, [String(d.id)]);
  if (!ev) fail('в chatpush_events нет события с этим delivery_id — сторож доставки не подтвердит реплику');
  console.log(`OK: отправка (${d.id}), эхо с delivery_id (событие #${ev.id}), авторство agent, статус «Отправлено»`);
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
