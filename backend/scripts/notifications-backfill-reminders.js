'use strict';
// Разовый догон напоминаний о визите по записям, созданным ДО включения модуля уведомлений.
//
//   cd backend && node scripts/notifications-backfill-reminders.js --salon=1 [--days=60] [--write]
//
// По умолчанию СУХОЙ ПРОГОН: читает записи YClients и считает, ничего не пишет и ничего не отправляет.
// --write ставит строки visit_reminder в notification_jobs (pending, meta.backfill=true) и дописывает
// notification_record_state ТОЛЬКО записям, у которых состояния ещё нет (перезапись откатила бы более свежее
// состояние от вебхуков). Отправляет не скрипт: строки подберёт воркер — в режиме shadow они лягут в журнал как
// shadow, в live уйдут клиентам. Режим салона скрипт НЕ меняет и печатает; в режиме off воркер строки не арендует
// (заработают при включении shadow/live).
//
// ЗАЧЕМ: напоминание ставится на событии создания/переноса записи, а записи в клинике делают на недели вперёд.
// Без догона визиты, записанные до включения модуля, остались бы без нашего напоминания после отключения
// Chatpush. Правила отбора — те же, что у вебхука (services/notifications/enroll.js, backfillReminders).
//
// Повторный запуск безопасен: ключ job'а (правило, запись, момент визита) занят — строка не создаётся, погашенные
// (в том числе отменённые администратором) не оживают. Лимит YClients минутный: страница, упавшая на нём,
// повторяется через минуту (до двух раз).
const { db, pool } = require('../db');
const { ycGet } = require('../services/yclients');
const { withRateLimitRetry } = require('../services/yclients-retry');
const settingsSvc = require('../services/notifications/settings');
const { backfillReminders } = require('../services/notifications/enroll');

const PAGE = 200;
const MAX_PAGES = 100;                 // 20 000 записей; /records отдаёт от свежих к старым
const PAGE_PAUSE_MS = 300;
const RECORDS_RETRY = { retries: 2, delayMs: 60_000 };

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Записи салона от сегодня на days дней вперёд (московские даты), без дублей по id. */
async function fetchUpcoming(salon, days) {
  const startDate = ymd(new Date());
  const endDate = ymd(new Date(Date.now() + days * 86400000));
  const byId = new Map();
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = await withRateLimitRetry(
      () => ycGet(salon, `/records/${salon.yclients_company_id}`, { start_date: startDate, end_date: endDate, page, count: PAGE }),
      RECORDS_RETRY);
    if (!Array.isArray(chunk) || !chunk.length) break;
    // Записи создаются, пока идём по страницам: сдвиг выдачи может отдать одну запись дважды.
    for (const r of chunk) if (r && r.id != null) byId.set(r.id, r);
    if (chunk.length < PAGE) break;
    if (page === MAX_PAGES) truncated = true;
    await sleep(PAGE_PAUSE_MS);
  }
  return { records: [...byId.values()], startDate, endDate, truncated };
}

(async () => {
  const salonId = Number(args.salon || 1);
  const salon = Number.isInteger(salonId) ? await db.oneOrNone('SELECT * FROM salons WHERE id = $1', [salonId]) : null;
  if (!salon) throw new Error(`салон не найден (--salon=${args.salon})`);
  if (!salon.yclients_company_id) throw new Error('у салона не настроен YClients');
  const rawDays = args.days === undefined ? 60 : Number(args.days);
  if (!Number.isFinite(rawDays)) throw new Error(`--days должно быть числом (получено ${args.days})`);
  const days = Math.min(Math.max(Math.floor(rawDays), 1), 180);
  const write = args.write === true;

  const cfg = await settingsSvc.getSettings(salon.id);
  const { records, startDate, endDate, truncated } = await fetchUpcoming(salon, days);
  if (truncated) {
    console.warn(`ВНИМАНИЕ: выдача /records обрезана потолком ${MAX_PAGES * PAGE} записей — записи старше последней полученной `
      + 'не проверены. Повторите запуск с меньшим --days (повтор безопасен).');
  }
  const r = await backfillReminders(salon, records, Date.now(), { dryRun: !write });
  console.log(`${write ? 'WRITE' : 'DRY-RUN'}: записей ${r.scanned}, подходят под правила ${r.eligible}, поставлено ${r.queued}`);
  console.log(`  период ${startDate}..${endDate}, режим салона: ${cfg.mode}, включённых правил visit_reminder: ${r.rules}`);
  if (r.rules === 0) console.log('  у салона нет включённых правил «Напоминание о визите» — догонять нечего (записи не разбирались)');
  else console.log(`  пропущено по записям: ${JSON.stringify(r.skipped)}`);
  if (write && cfg.mode !== 'shadow' && cfg.mode !== 'live') {
    console.warn(`ВНИМАНИЕ: режим «${cfg.mode}» — воркер строки не арендует, они заработают при включении shadow/live.`);
  }
  if (!write) console.log('  (сухой прогон: ничего не записано; --write ставит строки в очередь)');
})().catch((e) => {
  console.error(`ОШИБКА: ${e && e.message}`);
  process.exitCode = 1;
}).finally(() => pool.end().catch(() => {}));
