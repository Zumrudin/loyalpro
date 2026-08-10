'use strict';
// ============================================================================
// Разовая склейка переписок, расщеплённых ключом диалога («phone, иначе chat_id»).
// Инцидент 2026-08-10 (диалог 298342940, tdlib «darialyaskalo»). Два прохода:
//
// 1) В phone лежит номер САМОЙ клиники. Разбор события Chatpush брал номер
//    собеседника с перекрёстным фолбэком (`recipient || sender` у исходящего и
//    `sender || recipient` у входящего), а вторая сторона в обоих случаях — НАШ
//    инстанс. У собеседника со скрытым номером фолбэк и срабатывал: сообщения
//    клиента оставались под chat_id, ответы администратора уходили под номер
//    клиники — переписка выглядела монологом клиента, а ответы 31 разного чата
//    свалились в один фантомный диалог. Проход гасит такой phone; собственный
//    номер НЕ хардкодится — берётся из сырых chatpush_events как
//    sender_phone_number исходящих (у одного салона он один, проверено на проде).
//
// 2) Номер стал известен ПОСРЕДИ переписки (клиент прислал его текстом и попал в
//    базу): начало чата лежит без номера, продолжение — с номером, и один диалог
//    виден как два. Проход дописывает номер прежним строкам того же чата.
//
// Код починен в `services/chatpush.js` (перекрёстных фолбэков больше нет) и в
// `services/chat-persist.adoptPhoneForChat` (вебхук склеивает чат на лету, как
// только номер стал известен). Скрипт нужен только для УЖЕ накопленной истории.
//
// Запуск (с прод-бокса, cwd = backend/):
//   node scripts/fix-dialog-phone-keys.js            # сухой прогон
//   node scripts/fix-dialog-phone-keys.js --commit   # записать
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

  // ВХОДЯЩИЕ трогаем только в ЛИЧНЫХ чатах: в группе `sender_phone_number` — это
  // номер УЧАСТНИКА, и наш собственный номер там законен (администратор пишет в
  // рабочую группу со своего аккаунта). В личном чате отправитель входящего —
  // клиент, поэтому наш номер в phone мог взяться только из фолбэка на получателя.
  const WHERE = `(direction = 'outgoing' OR chat_id NOT LIKE '-%')`;

  let total = 0;
  for (const o of owners) {
    const rows = await db.any(
      `SELECT channel, direction, chat_id, count(*)::int AS n
         FROM chatpush_messages
        WHERE salon_id = $1 AND phone = $2 AND ${WHERE}
        GROUP BY 1, 2, 3 ORDER BY 4 DESC`, [o.salon_id, o.phone]);
    const n = rows.reduce((s, r) => s + r.n, 0);
    console.log(`\nсалон ${o.salon_id} / ${o.phone}: ${n} строк в ${rows.length} чатах`);
    for (const r of rows.slice(0, 40)) console.log(`  ${r.channel} ${r.direction} chat_id=${r.chat_id}: ${r.n}`);
    if (rows.length > 40) console.log(`  … ещё ${rows.length - 40} чатов`);
    total += n;

    if (COMMIT && n) {
      const upd = await db.query(
        `UPDATE chatpush_messages SET phone = NULL
          WHERE salon_id = $1 AND phone = $2 AND ${WHERE}`, [o.salon_id, o.phone]);
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

  // ── Проход 2: номер стал известен ПОСРЕДИ переписки ───────────────────────
  // Telegram/MAX скрывают номер, пока клиент не пришлёт его сам, — до этого
  // момента строки чата лежат без номера (ключ = chat_id), после него с номером
  // (ключ = phone), и одна переписка выглядит в «Чате» двумя диалогами.
  // Дописываем известный номер прежним строкам того же ЛИЧНОГО чата — ровно то,
  // что теперь делает на лету `chat-persist.adoptPhoneForChat` в вебхуке.
  // Чат, где засветилось НЕСКОЛЬКО разных номеров, пропускаем: какой из них
  // принадлежит собеседнику — из данных не следует.
  const split = await db.any(
    `SELECT salon_id, chat_id,
            count(*) FILTER (WHERE phone IS NULL OR phone = '')::int AS blanks,
            array_agg(DISTINCT phone) FILTER (WHERE phone IS NOT NULL AND phone <> '') AS phones
       FROM chatpush_messages
      WHERE chat_id IS NOT NULL AND chat_id <> '' AND chat_id NOT LIKE '-%'
      GROUP BY 1, 2
     HAVING count(*) FILTER (WHERE phone IS NULL OR phone = '') > 0
        AND count(DISTINCT phone) FILTER (WHERE phone IS NOT NULL AND phone <> '') > 0`);

  console.log(`\nЧатов с номером, появившимся посреди переписки: ${split.length}`);
  let merged = 0;
  for (const s of split) {
    if (s.phones.length > 1) {
      console.log(`  ⚠ салон ${s.salon_id} chat_id=${s.chat_id}: номеров несколько (${s.phones.join(', ')}) — пропуск`);
      continue;
    }
    console.log(`  салон ${s.salon_id} chat_id=${s.chat_id} → ${s.phones[0]} (${s.blanks} строк)`);
    merged += s.blanks;
    if (COMMIT) {
      const upd = await db.query(
        `UPDATE chatpush_messages SET phone = $3
          WHERE salon_id = $1 AND chat_id = $2 AND (phone IS NULL OR phone = '')`,
        [s.salon_id, s.chat_id, s.phones[0]]);
      console.log(`    → обновлено ${upd.rowCount}`);
    }
  }
  total += merged;

  console.log(COMMIT ? `\nГотово. Затронуто строк: ${total}` : `\nСУХОЙ ПРОГОН. К обновлению: ${total} строк. Повтори с --commit.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
