'use strict';
// Живая проверка правила «окно расписания закрылось посреди живого диалога»
// (services/agent/window-handover.js) на ДЕВ-БД: синтетический диалог 70000000707
// повторяет инцидент 07.11.2026 (79292633336) — запись в 09:09 внутри окна,
// «…До встречи!», уведомление YClients, в 09:37 (окно до 09:30) «Ок». Дальше —
// настоящий onOutsideSchedule с настоящим history: SQL lastAgentReply /
// incomingTextsAfter идёт с реальными параметрами. Эскалация и отправка
// застаблены, синтетические строки удаляются в finally.
//
// Запуск: cd backend && node scripts/window-handover-ack-e2e.js
// Пишет в chatpush_messages, поэтому работает ТОЛЬКО на loyalpro_test.
require('dotenv').config();
const { db, pool } = require('../db');
const history = require('../services/agent/history');
const pending = require('../services/agent/pending-replies');
const wh = require('../services/agent/window-handover');

const SALON = 1;
const KEY = '70000000707';
const PREFIX = 'e2e-window-ack:';
const T0 = Date.parse('2026-11-07T09:09:25+03:00') / 1000;   // реплика Милы в инциденте
const BOOKED = 'Татьяна, записала Вас на фотоомоложение лица к Астемиру Алексеевичу в четверг, 12 ноября, в 10:30. До встречи!';
const NOTICE = 'Вы записаны на прием 12.11.2026 10:30 в «PERI CLINIC». По адресу: ул. Генерала Белова, 28 корпус 3';

let seq = 0;
const out = (text, dt, authoredBy) => ({ direction: 'outgoing', text, ts: T0 + dt, authoredBy });
const inc = (text, dt, fileUrl = null) => ({ direction: 'incoming', text, ts: T0 + dt, fileUrl });

async function cleanup() {
  await db.query('DELETE FROM chatpush_messages WHERE salon_id = $1 AND external_message_id LIKE $2', [SALON, `${PREFIX}%`]);
}

async function insert(rows) {
  for (const r of rows) {
    seq += 1;
    await db.query(
      `INSERT INTO chatpush_messages (salon_id, channel, direction, external_message_id, msg_type, text,
         file_url, phone, msg_ts, provider, authored_by)
       VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, $7, $8, 'e2e', $9)`,
      [SALON, r.direction, `${PREFIX}${seq}`, r.fileUrl ? 'image' : 'text', r.text, r.fileUrl || null,
        KEY, r.ts, r.authoredBy || null]);
  }
}

async function scenario(name, rows, metaText, expectHandover) {
  await cleanup();
  await insert(rows);
  const logs = [];
  const deps = {
    state: { get: async () => ({ status: 'bot' }) },
    history,
    pending,
    escalate: async (s, k, reason) => { logs.push(`ESCALATE ${reason}`); },
    send: async (m, t) => { logs.push(`SEND «${t}»`); },
    handoverText: () => 'Передаю Ваш вопрос администратору, он подключится с минуты на минуту 🤍',
    maxAgeMs: 60 * 60 * 1000,
    nowMs: (T0 + 28 * 60 + 30) * 1000,
    logger: { info: (s) => logs.push(`INFO ${s}`), warn: (s) => logs.push(`WARN ${s}`) },
  };
  const res = await wh.onOutsideSchedule(SALON, KEY, { phone: KEY, channel: 'whatsapp', text: metaText }, deps);
  const ok = res === expectHandover;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: перевод=${res} (ожидали ${expectHandover})`);
  for (const l of logs) console.log(`      ${l}`);
  return ok;
}

(async () => {
  if (new URL(process.env.DATABASE_URL).pathname !== '/loyalpro_test') {
    console.error('Скрипт пишет в chatpush_messages — только для дев-БД loyalpro_test');
    process.exit(2);
  }
  let failed = 0;
  try {
    const run = async (...a) => { if (!(await scenario(...a))) failed += 1; };
    await run('A. инцидент: «Ок» после «записала… До встречи!» и уведомления YClients',
      [out(BOOKED, 0, 'agent'), out(NOTICE, 57, 'system'), inc('Ок', 1705)], 'Ок', false);
    await run('B. серия: вопрос, потом «Ок» → перевод',
      [out(BOOKED, 0, 'agent'), out(NOTICE, 57, 'system'), inc('А на чистку лица можно ещё записаться', 1700), inc('Ок', 1705)],
      'Ок', true);
    await run('C. «Ок» на вопрос Милы → перевод',
      [out('В четверг, 12 ноября, в 10:30 время свободно. Записать Вас на фотоомоложение лица?', 0, 'agent'), inc('Ок', 1705)],
      'Ок', true);
    await run('D. фото + «Ок» → перевод',
      [out(BOOKED, 0, 'agent'), inc(null, 1700, 'https://example.invalid/photo.jpg'), inc('Ок', 1705)], 'Ок', true);
    await run('E. «Спасибо» на вопрос Милы → тишина, как раньше',
      [out('Подобрать Вам удобное окошко?', 0, 'agent'), inc('Спасибо', 1705)], 'Спасибо', false);
    await run('F. «И вам!» после прощания → тишина',
      [out('Будем ждать Вас! Хорошего дня 🤍', 0, 'agent'), inc('И вам!', 1705)], 'И вам!', false);
  } finally {
    await cleanup();
    await pool.end();
  }
  console.log(failed ? `FAILED: ${failed}` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
