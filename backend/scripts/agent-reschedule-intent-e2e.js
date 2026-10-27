#!/usr/bin/env node
// Живая репродукция инцидента 2026-10-27 (79299778510): в окне транскрипта лежит
// автоуведомление YClients «Ваша запись … перенесена» двухмесячной давности,
// пациентка без будущих записей просит НОВУЮ запись цепочкой (лазер: бикини +
// живот) — до фикса book_chain отвечал reschedule_blocked и диалог уходил к
// администратору, потому что rescheduleRequested искал «перенес…» во всех ролях.
//
// Реальный LLM, реальный YClients (сетка, слоты, записи пациента), реальные гейты
// create_booking/book_chain; застаблены ТОЛЬКО: создание записи
// (booking.createBookingRecord и добавление услуги в запись — в YClients ничего
// не создаётся и не меняется), отправка,
// очередь напоминаний (agent_followups) и журнал доставок; гейт допуска — in-process.
//
// История тестового номера НЕ удаляется: строки диалога на время прогона
// прячутся подменой ключа (оригиналы — в /tmp/agent-reschedule-intent-backup-*.json)
// и возвращаются в finally, тестовые строки удаляются. Платный LLM: 2–4 хода.
//
// Usage (из backend/): node scripts/agent-reschedule-intent-e2e.js [--date "7 ноября"] [--phone 79200255591] [--text "…"]
const fs = require('fs');
const { db, pool } = require('../db');
const config = require('../config');
const settings = require('../services/agent-settings');
const dispatcher = require('../services/agent/dispatcher');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const booking = require('../services/agent/booking');
const bookChain = require('../services/agent/tools/book-chain');
const seqOffers = require('../services/agent/sequential-offers');

const SALON = 1;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PHONE = arg('--phone', '79200255591');
const DATE_HUMAN = arg('--date', '7 ноября');
// Тестовая карточка 79200255591 — мужская: на лазерную эпиляцию Мила законно
// откажет, поэтому по умолчанию цепочка без ограничений по полу.
const REQUEST = arg('--text', `Добрый день, можно записать на комбинированную чистку лица и микротоковый лимфодренаж? ${DATE_HUMAN}`);
const CHANNEL = 'tdlib';
const HIDDEN = `e2e-hidden-${PHONE}`;
const DAY = 86400;

const calls = [];
let turn = 0;
let fakeRecordId = 900000001;

function wrapRegistry() {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      // single_record: вторая услуга цепочки — правкой первой записи; запись
      // фиктивная, поэтому правка тоже заглушка (create_booking — настоящий).
      const res = name === 'book_chain'
        ? await bookChain.run(salonId, input, ctx, {
          modifyServices: async (sid, inp) => {
            console.log(`      · [stub] modifyServices record=${inp.record_id} add=${JSON.stringify(inp.add_service_yc_ids)}`);
            return { modified: true, record_id: inp.record_id, services_count: 1 + (inp.add_service_yc_ids || []).length };
          },
        })
        : await fn(salonId, input, ctx);
      calls.push({ turn, name, input, res, rescheduleRequested: ctx.rescheduleRequested });
      console.log(`    ▸ tool ${name} ${JSON.stringify(input).slice(0, 160)}`);
      if (['book_chain', 'create_booking'].includes(name)) {
        console.log(`      · rescheduleRequested=${ctx.rescheduleRequested} → ${JSON.stringify(res).slice(0, 300)}`);
      }
      return res;
    };
  }
  return { schemas: base.schemas, handlers };
}

async function insertMsg(direction, text, ts, authoredBy) {
  await db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts, authored_by)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `e2e:${direction}:${ts}:${Math.floor(Math.random() * 1e6)}`, text, PHONE, ts, authoredBy]);
}

// Прячем историю диалога: ключ диалога = phone || chat_id, подменяем оба.
async function hideHistory() {
  const backup = {
    messages: await db.any(
      `SELECT id, phone, chat_id FROM chatpush_messages
        WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]),
    toolEvents: await db.any(`SELECT id FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]),
    events: await db.any(`SELECT id FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]),
    followups: await db.any(`SELECT id FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]),
    dialog: await db.oneOrNone(`SELECT * FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]),
  };
  const file = `/tmp/agent-reschedule-intent-backup-${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(backup));
  console.log(`бэкап ключей истории: ${file} (сообщений ${backup.messages.length})`);
  const ids = rows => rows.map(r => r.id);
  await db.query(`UPDATE chatpush_messages SET phone=$2, chat_id=$2 WHERE id = ANY($1)`, [ids(backup.messages), HIDDEN]);
  await db.query(`UPDATE agent_tool_events SET dialog_key=$2 WHERE id = ANY($1)`, [ids(backup.toolEvents), HIDDEN]);
  await db.query(`UPDATE agent_events SET dialog_key=$2 WHERE id = ANY($1)`, [ids(backup.events), HIDDEN]);
  await db.query(`UPDATE agent_followups SET dialog_key=$2 WHERE id = ANY($1)`, [ids(backup.followups), HIDDEN]);
  return backup;
}

async function restoreHistory(backup) {
  seqOffers._reset();
  // Всё, что осталось под ключом номера, — строки прогона.
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_tool_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  for (const m of backup.messages) {
    await db.query(`UPDATE chatpush_messages SET phone=$2, chat_id=$3 WHERE id=$1`, [m.id, m.phone, m.chat_id]);
  }
  const ids = rows => rows.map(r => r.id);
  await db.query(`UPDATE agent_tool_events SET dialog_key=$2 WHERE id = ANY($1)`, [ids(backup.toolEvents), PHONE]);
  await db.query(`UPDATE agent_events SET dialog_key=$2 WHERE id = ANY($1)`, [ids(backup.events), PHONE]);
  await db.query(`UPDATE agent_followups SET dialog_key=$2 WHERE id = ANY($1)`, [ids(backup.followups), PHONE]);
  if (backup.dialog) {
    const d = backup.dialog;
    await db.query(`UPDATE agent_dialogs SET status=$3, escalated_reason=$4 WHERE salon_id=$1 AND dialog_key=$2`,
      [SALON, PHONE, d.status, d.escalated_reason]);
  } else {
    await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, PHONE]);
  }
  const left = await db.one(`SELECT count(*)::int n FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, PHONE]);
  console.log(`история восстановлена: сообщений ${left.n} (было ${backup.messages.length})`);
}

const qa = [];
async function runTurn(n, incoming) {
  turn = n;
  console.log(`\n=== ХОД ${n}: «${incoming}» ===`);
  await insertMsg('incoming', incoming, Math.floor(Date.now() / 1000), null);
  const replies = [];
  await dispatcher.process(SALON, PHONE, { phone: PHONE, channel: CHANNEL, text: incoming }, {
    send: async (meta, text) => { replies.push(text); return null; },
    persistOwn: async () => {},
    deliveryLog: { record: async () => null },
    followupQueue: { close: async () => {}, shouldAwaitReply: () => false, schedule: async () => {} },
    orchestrator: {
      runDialog: (sid, key, o) => orchestrator.runDialog(sid, key, {
        ...o, deps: { ...(o.deps || {}), registry: wrapRegistry() },
      }),
    },
  });
  const names = calls.filter(c => c.turn === n).map(c => c.name);
  console.log(`  инструменты хода: ${names.length ? names.join(' → ') : '(нет)'}`);
  for (const t of replies) {
    console.log(`  → Мила: ${t}`);
    await insertMsg('outgoing', t, Math.floor(Date.now() / 1000), 'agent');
  }
  qa.push({ q: incoming, a: replies.join('\n\n') || '(молчание)', tools: names });
  return replies.join('\n');
}

async function main() {
  // Создание записи — заглушка: все гейты create_booking/book_chain отрабатывают
  // по-настоящему, в YClients ничего не уходит.
  booking.createBookingRecord = async (sid, a) => {
    console.log(`      · [stub] createBookingRecord ${a.datetime} svc=${a.serviceYcId} staff=${a.staffYcId}`);
    return { created: true, record_id: fakeRecordId++ };
  };
  settings.isAllowed = async () => ({ allow: true, reason: 'e2e' });
  console.log(`провайдер=${config.AGENT_PROVIDER}, номер=${PHONE}, канал=${CHANNEL}`);

  const backup = await hideHistory();
  try {
    seqOffers._reset();
    // Посев: старая переписка с автоуведомлением о ПЕРЕНОСЕ (как 31.08 в инциденте).
    const now = Math.floor(Date.now() / 1000);
    await insertMsg('incoming', 'Давайте на 12', now - 57 * DAY, null);
    await insertMsg('outgoing', 'Ваша запись в «PERI CLINIC» перенесена.\nНовое время записи 01.09.2026 в 12:00\nПо адресу: ул. Генерала Белова, 28 корпус 3\nКлиника Эстетической Медицины «PERI CLINIC»\nТелефон: +79250177778', now - 57 * DAY + 40, 'system');
    await insertMsg('incoming', 'Здравствуйте, да', now - 27 * DAY, null);
    await insertMsg('outgoing', '✅ Ваша запись подтверждена.\nБудем ждать вас!', now - 27 * DAY + 20, 'system');

    let reply = await runTurn(1, REQUEST);
    for (let n = 2; n <= 4; n++) {
      if (calls.some(c => ['book_chain', 'create_booking'].includes(c.name))) break;
      const t = (reply.match(/(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/) || [])[0];
      reply = await runTurn(n, t ? t.replace('.', ':') : 'Да');
    }

    console.log('\n=== ИТОГ ===');
    const writes = calls.filter(c => ['book_chain', 'create_booking'].includes(c.name));
    const blocked = writes.some(c => c.res && (c.res.reschedule_blocked || c.res.requires_reschedule));
    const booked = writes.some(c => c.res && (c.res.booked_all || c.res.created === true));
    const flag = writes.map(c => c.rescheduleRequested);
    const handover = qa.some(x => /передаю|администратор[а-я]* клиники/iu.test(x.a));
    console.log(`write-вызовы: ${writes.map(c => c.name).join(', ') || '(нет)'}`);
    console.log(`rescheduleRequested на записи: ${JSON.stringify(flag)} ${flag.length && flag.every(f => f === false) ? '✅' : '❌'}`);
    console.log(`reschedule_blocked/requires_reschedule: ${blocked ? '❌ есть' : '✅ нет'}`);
    console.log(`запись оформлена (заглушка): ${booked ? '✅' : '❌'}`);
    console.log(`перевод на администратора: ${handover ? '❌ был' : '✅ нет'}`);
    console.log('\n=== ВОПРОС → ОТВЕТ ===');
    for (const x of qa) console.log(`\nПациент: ${x.q}\nМила: ${x.a}\n[инструменты: ${x.tools.join(', ') || 'нет'}]`);
  } finally {
    await restoreHistory(backup);
  }
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('HARNESS FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
