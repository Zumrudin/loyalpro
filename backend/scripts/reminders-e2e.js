'use strict';
// Живая проверка напоминания на дев-БД: создаёт правило, ставит строку очереди
// на «сейчас», прогоняет ОДИН тик настоящего воркера и печатает результат.
//
// По умолчанию НИЧЕГО НЕ ОТПРАВЛЯЕТ и НИЧЕГО НЕ НАЧИСЛЯЕТ: отправка и
// начисление застаблены. Начисление необратимо (ручная транзакция по карте),
// поэтому боевой путь бонусов включается только явным флагом --accrue.
//
//   node scripts/reminders-e2e.js [--phone 79200255591] [--send] [--accrue]
//
// За собой чистит: удаляет созданное правило (строки очереди уходят каскадом
// по salon_id только при удалении салона, поэтому чистим их явно).
//
// ОПАСНОСТЬ, из-за которой скрипт по умолчанию отказывается работать: на деве
// (pm2 `loyalpro`) уже крутится настоящий воркер напоминаний с тиком 60с
// (services/reminders/worker.js startRemindersWorker). Строка, которую этот
// скрипт вставляет, ставится на scheduled_at = NOW() - 1 минута — то есть
// сразу просроченная и пригодная к аренде ЛЮБЫМ процессом. Если тик боевого
// воркера попадёт между вставкой строки и вызовом processTick() в этом
// скрипте, строку арендует ОН — а у него отправка НЕ застаблена, и живому
// человеку на номер уйдёт настоящее сообщение. Поэтому:
//   1) без --allow-worker-running скрипт проверяет pm2 и отказывается
//      работать, если процесс `loyalpro` запущен;
//   2) вставка строки и вызов processTick стоят вплотную друг к другу, и
//      сразу после вставки печатается предупреждение, что строка «живая».

const { execFileSync } = require('child_process');
const { db, pool } = require('../db');
const worker = require('../services/reminders/worker');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, def) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : def; };

const PHONE = val('--phone', '79200255591');
const REAL_SEND = flag('--send');
const REAL_ACCRUE = flag('--accrue');
const ALLOW_WORKER_RUNNING = flag('--allow-worker-running');

const PM2_PROCESS_NAME = 'loyalpro';

/**
 * Запущен ли pm2-процесс `loyalpro` и в каком он статусе. Возвращает null,
 * если pm2 недоступен вовсе (не блокируем прогон — просто предупреждаем):
 * отсутствие pm2 в PATH не означает, что боевой воркер не крутится где-то
 * ещё, но чаще всего это dev-окружение без pm2 вообще.
 */
function pm2ProcessStatus(name) {
  let out;
  try {
    out = execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000 });
  } catch (e) {
    console.warn(`⚠️  не удалось спросить pm2 (${e.message}) — проверка боевого воркера ПРОПУЩЕНА`);
    return null;
  }
  let list;
  try { list = JSON.parse(out); } catch (e) {
    console.warn(`⚠️  pm2 jlist вернул не-JSON (${e.message}) — проверка боевого воркера ПРОПУЩЕНА`);
    return null;
  }
  const proc = (list || []).find(p => p && p.name === name);
  if (!proc) return { found: false, status: null };
  return { found: true, status: proc.pm2_env && proc.pm2_env.status };
}

function guardAgainstLiveWorker() {
  if (REAL_SEND) return; // --send уже осознанное согласие слать реально
  if (ALLOW_WORKER_RUNNING) {
    console.warn('⚠️  --allow-worker-running: проверка боевого pm2-воркера ОБОЙДЕНА осознанно.');
    return;
  }
  const info = pm2ProcessStatus(PM2_PROCESS_NAME);
  if (info && info.found && info.status === 'online') {
    console.error([
      '',
      `ОТКАЗ: pm2-процесс «${PM2_PROCESS_NAME}» сейчас ONLINE.`,
      'В нём крутится настоящий воркер напоминаний (тик 60с, без стабов).',
      'Строка очереди, которую ставит этот скрипт, просрочена (scheduled_at = NOW() - 1 мин)',
      'и может быть арендована боевым воркером первой — тогда сообщение реально',
      'уйдёт клиенту.',
      '',
      'Сделай так:',
      `  1) pm2 stop ${PM2_PROCESS_NAME}`,
      '  2) node scripts/reminders-e2e.js  (этот скрипт)',
      `  3) PORT=3001 pm2 restart ${PM2_PROCESS_NAME} --update-env`,
      `  4) pm2 list — убедиться, что ${PM2_PROCESS_NAME} online`,
      '',
      'Если ты точно знаешь, что делаешь (например, боевой воркер физически',
      'не может добраться до этой строки), обойди проверку флагом:',
      '  node scripts/reminders-e2e.js --allow-worker-running',
      '',
    ].join('\n'));
    process.exit(1);
  }
}

(async () => {
  guardAgainstLiveWorker();

  const salon = await db.oneOrNone(`SELECT id, name FROM salons WHERE is_active = TRUE ORDER BY id LIMIT 1`);
  if (!salon) throw new Error('нет ни одного активного салона в БД — некуда ставить тестовое правило');
  console.log(`салон #${salon.id} «${salon.name}», телефон ${PHONE}`);

  const rule = await db.oneOrNone(
    `INSERT INTO reminder_rules
       (salon_id, title, conditions, delay_days, send_time, text_mode, text,
        attribution_days, bonus_enabled, bonus_tiers, backfill_max_per_day)
     VALUES ($1, 'E2E тест напоминаний', '{"logic":"and","items":[]}'::jsonb, 30, '11:00',
             'strict', '{first_name}, прошло {дней} дн. — пора повторить {услуга}!',
             30, $2, '[{"up_to":500,"action":"accrue","amount":10,"text":"{first_name}, начислили {бонусы} бонусов, ждём вас!"}]'::jsonb, 30)
     RETURNING *`,
    [salon.id, REAL_ACCRUE]);
  if (!rule) throw new Error('INSERT reminder_rules не вернул строку');
  console.log(`правило #${rule.id} создано (бонусы: ${REAL_ACCRUE ? 'БОЕВЫЕ' : 'выключены'})`);

  let row;
  try {
    // Вставка строки и запуск тика — вплотную друг к другу (см. шапку файла):
    // с этого момента строка scheduled_at в прошлом и годна к аренде ЛЮБЫМ
    // процессом, читающим reminder_queue.
    row = await db.oneOrNone(
      `INSERT INTO reminder_queue
         (salon_id, rule_id, rule_title, phone, anchor_record_id, anchor_visit_at,
          anchor_services, scheduled_at, source)
       VALUES ($1,$2,$3,$4,$5, NOW() - interval '30 days',
               '[{"id":1,"title":"Лазерная эпиляция"}]'::jsonb, NOW() - interval '1 minute', 'webhook')
       RETURNING id`,
      [salon.id, rule.id, rule.title, PHONE, Date.now() % 1000000000]);
    if (!row) throw new Error('INSERT reminder_queue не вернул строку');
    console.log(`строка очереди #${row.id} поставлена на «сейчас» — с этого момента она ЖИВАЯ`
      + ' (scheduled_at в прошлом, годна к аренде любым процессом, читающим reminder_queue)');

    const deps = {};
    if (!REAL_SEND) {
      deps.sendMessage = async (p) => {
        console.log(`\n=== ТЕКСТ (не отправлен) ===\n${p.text}\n=== канал: ${(p.dispatchRouting || []).join(',')} ===\n`);
        return { id: 'stub', channel: 'telegram' };
      };
      deps.rememberPending = async () => {};
      deps.persistWhatsapp = async () => {};
    }

    await worker.processTick(deps);

    const after = await db.oneOrNone(
      `SELECT status, decision_reason, rendered_text, balance_before, bonus_tier,
              bonus_accrued, bonus_txn_ok, channel_used
         FROM reminder_queue WHERE id=$1`, [row.id]);
    console.log('итог строки:', after);

    const mute = await db.oneOrNone(
      `SELECT muted, reason, source FROM reminder_suppressions WHERE rule_id=$1 AND phone=$2`,
      [rule.id, PHONE]);
    console.log('флаг анти-повтора:', mute || 'не выставлен');
  } finally {
    await db.query(`DELETE FROM reminder_queue WHERE rule_id=$1`, [rule.id]);
    await db.query(`DELETE FROM reminder_suppressions WHERE rule_id=$1`, [rule.id]);
    await db.query(`DELETE FROM reminder_rules WHERE id=$1`, [rule.id]);
    console.log('прибрано');
  }
  await pool.end();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
