'use strict';
// ============================================================================
// Разовая правка данных: у ИСХОДЯЩИХ сообщений в phone лежит номер САМОЙ клиники.
//
// Инцидент 2026-08-10 (диалог 298342940, tdlib «darialyaskalo»). Разбор события
// Chatpush брал номер собеседника как `recipient_phone_number || sender_phone_number`,
// и у собеседника со скрытым в Telegram номером фолбэк подставлял отправителя —
// то есть НАШ инстанс. Ключ диалога («phone, иначе chat_id») у входящих и
// исходящих расходился: клиент — под chat_id, ответы администратора — под
// номером клиники. В «Чате» переписка выглядела как монолог клиента, а ответы
// из 31 разного чата сваливались в один фантомный диалог.
//
// Код починен в services/chatpush.js (у исходящего фолбэка на отправителя нет).
// Этот скрипт склеивает УЖЕ сохранённую историю: гасит phone там, где он равен
// собственному номеру инстанса. После него ключ таких строк — chat_id, как у
// входящих того же чата.
//
// Собственный номер НЕ хардкодится: берётся из сырых chatpush_events как
// sender_phone_number исходящих (у одного салона он один — проверено на проде).
//
// Запуск (с прод-бокса, cwd = backend/):
//   node scripts/fix-outgoing-own-phone.js            # сухой прогон
//   node scripts/fix-outgoing-own-phone.js --commit   # записать
// ============================================================================
require('dotenv').config();
const { db } = require('../db');

const COMMIT = process.argv.includes('--commit');

(async () => {
  const owners = await db.any(
    `SELECT salon_id, payload->'payload'->>'sender_phone_number' AS phone, count(*)::int AS n
       FROM chatpush_events
      WHERE direction = 'outgoing'
        AND payload->'payload'->>'sender_phone_number' IS NOT NULL
        AND salon_id IS NOT NULL
      GROUP BY 1, 2 ORDER BY 1, 3 DESC`);
  if (!owners.length) { console.log('собственных номеров в chatpush_events не нашлось — нечего делать'); process.exit(0); }

  console.log('Собственные номера инстансов (по исходящим событиям):');
  for (const o of owners) console.log(`  салон ${o.salon_id}: ${o.phone} (${o.n} событий)`);

  let total = 0;
  for (const o of owners) {
    const rows = await db.any(
      `SELECT channel, chat_id, count(*)::int AS n
         FROM chatpush_messages
        WHERE salon_id = $1 AND direction = 'outgoing' AND phone = $2
        GROUP BY 1, 2 ORDER BY 3 DESC`, [o.salon_id, o.phone]);
    const n = rows.reduce((s, r) => s + r.n, 0);
    console.log(`\nсалон ${o.salon_id} / ${o.phone}: ${n} строк в ${rows.length} чатах`);
    for (const r of rows.slice(0, 40)) console.log(`  ${r.channel} chat_id=${r.chat_id}: ${r.n}`);
    if (rows.length > 40) console.log(`  … ещё ${rows.length - 40} чатов`);
    total += n;

    if (COMMIT && n) {
      const upd = await db.query(
        `UPDATE chatpush_messages SET phone = NULL
          WHERE salon_id = $1 AND direction = 'outgoing' AND phone = $2`, [o.salon_id, o.phone]);
      console.log(`  → обновлено ${upd.rowCount}`);
      // Строка агента на фантомном ключе: диалога с таким ключом больше нет,
      // а пауза «ответил оператор» на нём означала, что настоящий диалог клиента
      // остался БЕЗ паузы. Настоящие диалоги перепаузить нельзя (неизвестно, в
      // каком из 31 чата человек ещё ведёт разговор) — их всё равно распустил бы
      // вечерний авто-сброс operator_reply на открытии окна расписания.
      const del = await db.query(
        `DELETE FROM agent_dialogs WHERE salon_id = $1 AND dialog_key = $2`, [o.salon_id, o.phone]);
      if (del.rowCount) console.log(`  → удалена фантомная строка agent_dialogs (${o.phone})`);
    }
  }

  console.log(COMMIT ? `\nГотово. Затронуто строк: ${total}` : `\nСУХОЙ ПРОГОН. К обновлению: ${total} строк. Повтори с --commit.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
