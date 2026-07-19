#!/usr/bin/env node
// Очистка истории переписки одного диалога: chatpush_messages + состояние agent_dialogs.
//
// Нужно, когда тестируешь агента на своём номере: транскрипт (services/agent/history.js)
// подтягивает последние сообщения, и старый контекст тянется в новый прогон.
// Удалив строки, следующий входящий стартует диалог с чистого листа.
//
// Ключ диалога — тот же, что во всём коде: телефон, либо chat_id для каналов
// без телефона (Telegram/MAX). Формат телефона — каноничный, без плюса: 79001234567.
//
// Usage:
//   node backend/scripts/clear-dialog.js 79001234567              # dry-run: что будет удалено
//   node backend/scripts/clear-dialog.js 79001234567 --apply      # удалить
//   node backend/scripts/clear-dialog.js 79001234567 --salon 2    # другой салон (по умолчанию 1)
//
// Читает DATABASE_URL из backend/config, как и приложение.

const { pool, db } = require('../db');

const DIALOG_KEY_SQL = `COALESCE(NULLIF(phone,''), chat_id)`;

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const salonIdx = args.indexOf('--salon');
  const salonId = salonIdx >= 0 ? Number(args[salonIdx + 1]) : 1;
  const dialogKey = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--salon');

  if (!dialogKey) {
    console.error('Укажи ключ диалога: node backend/scripts/clear-dialog.js 79001234567 [--apply] [--salon N]');
    process.exit(1);
  }

  const rows = await db.any(
    `SELECT direction, channel, to_timestamp(msg_ts) AS ts, left(text, 60) AS text
       FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
      ORDER BY msg_ts DESC, id DESC`,
    [salonId, dialogKey]);

  const state = await db.oneOrNone(
    `SELECT status, escalated_reason FROM agent_dialogs WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey]);

  console.log(`Салон ${salonId}, диалог ${dialogKey}: ${rows.length} сообщений` +
              (state ? `, состояние agent_dialogs: ${state.status}${state.escalated_reason ? ` (${state.escalated_reason})` : ''}` : ', состояния в agent_dialogs нет'));
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.ts ? r.ts.toISOString() : '—'}  ${r.direction === 'incoming' ? '←' : '→'} [${r.channel}] ${r.text}`);
  }
  if (rows.length > 20) console.log(`  … и ещё ${rows.length - 20}`);

  if (!rows.length && !state) { console.log('Нечего удалять.'); return; }

  if (!apply) {
    console.log('\nDry-run. Добавь --apply, чтобы удалить.');
    return;
  }

  const del = await db.query(
    `DELETE FROM chatpush_messages WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2`,
    [salonId, dialogKey]);
  const delState = await db.query(
    `DELETE FROM agent_dialogs WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey]);

  console.log(`\nУдалено: ${del.rowCount} сообщений, ${delState.rowCount} строк состояния диалога.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
