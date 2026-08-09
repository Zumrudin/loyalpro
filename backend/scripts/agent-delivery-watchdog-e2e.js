'use strict';
// Живая проверка сторожа доставки на дев-БД: гоняет НАСТОЯЩИЙ SQL модуля
// (insert / listPending / isConfirmed / setStatus / repointChatRow), которого
// юнит-моки не проверяют вовсе. Разбор инцидента 2026-08-09 показал, что цена
// ошибки тут — молчание в ответ клиенту, поэтому запросы обязаны быть проверены
// на живой базе, а не только на jest.fn().
//
//   node scripts/agent-delivery-watchdog-e2e.js [--allow-worker-running]
//
// Отправка и перевод на администратора ЗАСТАБЛЕНЫ всегда: цель — SQL и ветвление,
// а не реальное сообщение. За собой чистит все созданные строки.
//
// ОПАСНОСТЬ, из-за которой скрипт по умолчанию не запускается при живом pm2:
// на деве крутится крон сторожа (*/2 мин) с НЕзастабленной отправкой. Строка,
// которую вставляет скрипт, намеренно просрочена (created_at в прошлом) — если
// тик боевого прохода попадёт между вставкой и нашим sweep(), повтор уйдёт
// по-настоящему. Тот же приём и та же причина, что в scripts/reminders-e2e.js.
const { execFileSync } = require('child_process');
const { db, pool } = require('../db');
const watchdog = require('../services/agent/delivery-watchdog');

const args = process.argv.slice(2);
const SALON = 1;
const KEY = 'e2e-watchdog-79000000000';
const DELIVERY_1 = '990000001';
const DELIVERY_2 = '990000002';

function pm2Online() {
  try {
    const out = execFileSync('pm2', ['jlist'], { encoding: 'utf8' });
    return JSON.parse(out).some(p => p.name === 'loyalpro' && p.pm2_env.status === 'online');
  } catch { return false; }
}

const ok = [];
const bad = [];
function check(name, cond) { (cond ? ok : bad).push(name); console.log(`${cond ? '✓' : '✗'} ${name}`); }

async function cleanup() {
  await db.query('DELETE FROM agent_reply_deliveries WHERE dialog_key = $1', [KEY]);
  await db.query('DELETE FROM chatpush_messages WHERE salon_id = $1 AND external_message_id = ANY($2)',
    [SALON, [`api:${DELIVERY_1}`, `api:${DELIVERY_2}`]]);
  await db.query(`DELETE FROM chatpush_events WHERE payload->'payload'->>'delivery_id' = $1`, [DELIVERY_2]);
}

(async () => {
  if (pm2Online() && !args.includes('--allow-worker-running')) {
    console.error('pm2 loyalpro online: крон сторожа может увести строку и отправить повтор по-настоящему.\n' +
      'Останови процесс или запусти с --allow-worker-running.');
    process.exit(1);
  }
  await cleanup();

  // 1) Запись отправки боевым record() — тот же путь, что зовёт диспетчер.
  const meta = { phone: '79000000000', channel: 'whatsapp', messageId: 'm-e2e', chatId: '79000000000@c.us' };
  const id1 = await watchdog.record(SALON, KEY, meta, 'Здравствуйте! Это проверка сторожа.', { id: DELIVERY_1 });
  check('record() вернул id строки журнала', Number.isInteger(Number(id1)) && id1);

  // Строка «Чата», сохранённая при отправке (fix 2) — её сторож перецепит на повтор.
  await db.query(
    `INSERT INTO chatpush_messages (salon_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts, authored_by)
     VALUES ($1,'whatsapp','outgoing',$2,'text','Здравствуйте! Это проверка сторожа.',$3,$4,'agent')`,
    [SALON, `api:${DELIVERY_1}`, meta.phone, Math.floor(Date.now() / 1000)]);

  // 2) Порог ещё не вышел — сторож не трогает свежую строку.
  let r = await watchdog.sweep({ send: async () => { throw new Error('не должно вызываться'); }, escalate: async () => {} });
  const fresh = await db.oneOrNone('SELECT status FROM agent_reply_deliveries WHERE id = $1', [id1]);
  check('свежая строка остаётся pending', fresh && fresh.status === 'pending');

  // 3) Состариваем строку и ждём ПОВТОР.
  await db.query(`UPDATE agent_reply_deliveries SET created_at = NOW() - interval '10 minutes' WHERE id = $1`, [id1]);
  let sent = null;
  r = await watchdog.sweep({
    send: async (row) => { sent = row; return { id: DELIVERY_2 }; },
    escalate: async () => { throw new Error('перевода на этом шаге быть не должно'); },
  });
  check('sweep отчитался об одном повторе', r.retried === 1 && r.escalated === 0);
  check('повтор ушёл тем же текстом и тем же каналом',
    !!sent && sent.text.startsWith('Здравствуйте!') && sent.channel === 'whatsapp');
  const after = await db.oneOrNone('SELECT status FROM agent_reply_deliveries WHERE id = $1', [id1]);
  check('исходная строка помечена retried', after && after.status === 'retried');
  const retryRow = await db.oneOrNone(
    'SELECT * FROM agent_reply_deliveries WHERE dialog_key = $1 AND retry_of = $2', [KEY, id1]);
  check('строка повтора создана с новым delivery_id',
    !!retryRow && retryRow.delivery_id === DELIVERY_2 && retryRow.status === 'pending');
  const chatRow = await db.oneOrNone(
    'SELECT external_message_id FROM chatpush_messages WHERE salon_id = $1 AND external_message_id = $2',
    [SALON, `api:${DELIVERY_2}`]);
  check('строка «Чата» перецеплена на новый delivery (эхо повтора не задвоит ответ)', !!chatRow);

  // 4) Подтверждение повтора: кладём сырое событие ровно той формы, что шлёт Chatpush.
  await db.query(
    `INSERT INTO chatpush_events (type, payload) VALUES ('message_status', $1::jsonb)`,
    [JSON.stringify({ type: 'message_status', payload: { customer_id: 46594, delivery_id: Number(DELIVERY_2), message_status: { status: 'sent' } } })]);
  await db.query(`UPDATE agent_reply_deliveries SET created_at = NOW() - interval '10 minutes' WHERE id = $1`, [retryRow.id]);
  r = await watchdog.sweep({
    send: async () => { throw new Error('второго повтора быть не должно'); },
    escalate: async () => { throw new Error('перевода при подтверждении быть не должно'); },
  });
  const confirmed = await db.oneOrNone('SELECT status FROM agent_reply_deliveries WHERE id = $1', [retryRow.id]);
  check('статус доставки найден по delivery_id → строка confirmed',
    r.confirmed === 1 && confirmed && confirmed.status === 'confirmed');

  // 5) Неподтверждённый повтор уходит к человеку и второй раз не отправляется.
  const id3 = await watchdog.record(SALON, KEY, meta, 'Вторая проверка.', { id: '990000003' });
  await db.query('UPDATE agent_reply_deliveries SET retry_of = $2, created_at = NOW() - interval \'10 minutes\' WHERE id = $1', [id3, id1]);
  let escalated = null;
  r = await watchdog.sweep({
    send: async () => { throw new Error('третьей отправки быть не должно'); },
    escalate: async (salonId, dialogKey, reason) => { escalated = { salonId, dialogKey, reason }; },
  });
  const failed = await db.oneOrNone('SELECT status FROM agent_reply_deliveries WHERE id = $1', [id3]);
  check('неподтверждённый повтор → перевод на администратора + статус failed',
    r.escalated === 1 && escalated && escalated.dialogKey === KEY && failed && failed.status === 'failed');

  await cleanup();
  console.log(`\nИтог: ok=${ok.length} fail=${bad.length}${bad.length ? '\n  ' + bad.join('\n  ') : ''}`);
  await pool.end();
  process.exit(bad.length ? 1 : 0);
})().catch(async (e) => {
  console.error('FAIL:', e.message);
  try { await cleanup(); await pool.end(); } catch {}
  process.exit(1);
});
