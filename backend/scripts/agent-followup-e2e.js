'use strict';
// Живая проверка «ожидания ответа клиента» (Task 14) на дев-БД: ставит строку
// agent_followups на просроченный next_at, прогоняет ОДИН тик настоящего
// воркера (services/agent/followup-worker.js processTick) и печатает, во что
// строка перешла.
//
//   node scripts/agent-followup-e2e.js [--phone 79200255591] [--salon 1]
//                                      [--stage 1] [--send]
//                                      [--allow-worker-running]
//
// По умолчанию НИЧЕГО НЕ ОТПРАВЛЯЕТ: sendMessage, rememberPending и
// persistWhatsapp застаблены — перехваченный текст печатается в консоль, а не
// уходит клиенту. LLM при этом РЕАЛЬНЫЙ (--stage 0, текст напоминания пишет
// живая модель без единого инструмента) — застабленный провайдер ничего не
// доказал бы про промпт followup-prompt.js. --stage 1 LLM не зовёт вовсе
// (финал — шаблон салона), см. followup-worker.js processOne/isFinal.
//
// НАСТРОЙКИ САЛОНА меняются на время прогона и ОБЯЗАТЕЛЬНО восстанавливаются
// в finally. На деве сейчас agent_settings.enabled=false (агент выключен) И
// followup_delay1_min=0 (воркер молча гасит такую строку как cancelled
// 'disabled' — followup-schedule.resolveDelays) — оба условия сделали бы
// счастливый путь недостижимым. Скрипт читает ТЕКУЩИЕ enabled/mode/
// followup_delay1_min/followup_delay2_min ПЕРЕД изменением, на время прогона
// временно включает агента (enabled=true, mode='all' — снимает и чёрный/белый
// список, и окно расписания), выставляет рабочие интервалы напоминаний
// (15/60, см. followup-schedule.DEFAULT_DELAY1_MIN/DEFAULT_DELAY2_MIN), а в
// finally возвращает РОВНО те значения, что были до запуска (если строки
// agent_settings не было вовсе — удаляет её, а не оставляет с дефолтами).
// followup_final_text/followup_latest_time не трогаются: NULL — штатное
// состояние схемы, воркер сам подставляет DEFAULT_FINAL_TEXT.
// Не сделать этого — значит оставить агента включённым НА ВЕСЬ САЛОН на
// деве, что несопоставимо хуже локальной проверки одного диалога.
//
// Транскрипт для LLM (--stage 0) — НЕ фикция поверх реальной БД: скрипт сам
// вставляет ДВА обмена подряд (см. комментарий в main() у их вставки — ровно
// ОДИН обмен ловит остаточную странность history.loadTranscript() и роняет
// единственную реплику Милы из транскрипта целиком) — без единого времени в
// текстах, иначе followup-guard.hasInventedTime не даст модели опоры и любое
// названное ею время окажется «выдуманным» — и чистит их в finally по ID.
// Если у номера уже есть диалог со статусом 'escalated' в
// agent_dialogs (пауза «отвечает оператор»), followup-worker шаг 5 гасит
// строку как cancelled/operator ДО платного прохода — скрипт разово снимает
// такую паузу для тестового диалога (тот же приём, что agent-tool-memory-e2e.js
// делает с agent_dialogs/agent_events своего теста), без восстановления: это
// диалог тестового номера, а не чужая переписка.
//
// За собой чистит: удаляет ВСТАВЛЕННУЮ строку agent_followups, вставленные
// сообщения chatpush_messages и восстанавливает agent_settings — всё в finally,
// не только на счастливом пути.
//
// ОПАСНОСТЬ, из-за которой скрипт по умолчанию отказывается работать: на деве
// (pm2 `loyalpro`) уже крутится настоящий воркер напоминаний о себе (тик 60с,
// services/agent/followup-worker.js startFollowupWorker). Строка, которую
// этот скрипт вставляет, ставится на next_at = NOW() - 1 минута — то есть
// сразу просроченная и пригодная к аренде ЛЮБЫМ процессом, читающим
// agent_followups. Если тик боевого воркера попадёт между вставкой строки и
// вызовом processTick() в этом скрипте, строку арендует ОН — а у него
// отправка НЕ застаблена, и живому человеку на номер уйдёт настоящее
// сообщение. Поэтому:
//   1) без --allow-worker-running скрипт проверяет pm2 и отказывается
//      работать, если процесс `loyalpro` запущен;
//   2) вставка строки и вызов processTick стоят вплотную друг к другу.
//
// ГОТЧА, на которой уже обжигались при разработке этой фичи: прогон, убитый
// SIGPIPE (например, `node scripts/agent-followup-e2e.js | head`), может
// оборвать процесс ДО uborki — try/finally синхронный разрыв стека переживёт,
// но НЕ переживёт его обрыв event loop'а из необработанного EPIPE где-то вне
// текущего стека. Поэтому: НЕ ПАЙПИТЬ ВЫВОД этого скрипта. Дополнительная
// страховка — обработчики SIGINT/SIGTERM ниже, которые запускают ТУ ЖЕ
// функцию уборки перед выходом.

const { execFileSync } = require('child_process');
const { db, pool } = require('../db');
const worker = require('../services/agent/followup-worker');
const { DEFAULT_DELAY1_MIN, DEFAULT_DELAY2_MIN } = require('../services/agent/followup-schedule');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, def) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : def; };

const PHONE = val('--phone', '79200255591');
const SALON_ID = Number(val('--salon', '1'));
const STAGE = Number(val('--stage', '0')) >= 1 ? 1 : 0;
const REAL_SEND = flag('--send');
const ALLOW_WORKER_RUNNING = flag('--allow-worker-running');

const PM2_PROCESS_NAME = 'loyalpro';

/**
 * Запущен ли pm2-процесс `loyalpro` и в каком он статусе. null — pm2
 * недоступен (не блокируем прогон, просто предупреждаем).
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
  const proc = (list || []).find((p) => p && p.name === name);
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
      'В нём крутится настоящий воркер напоминаний о себе (тик 60с, без стабов).',
      'Строка очереди, которую ставит этот скрипт, просрочена (next_at = NOW() - 1 мин)',
      'и может быть арендована боевым воркером первой — тогда сообщение реально',
      'уйдёт клиенту.',
      '',
      'Сделай так:',
      `  1) pm2 stop ${PM2_PROCESS_NAME}`,
      '  2) node scripts/agent-followup-e2e.js  (этот скрипт)',
      `  3) PORT=3001 pm2 start ${PM2_PROCESS_NAME}`,
      `  4) pm2 list — убедиться, что ${PM2_PROCESS_NAME} online`,
      '',
      'Если ты точно знаешь, что делаешь, обойди проверку флагом:',
      '  node scripts/agent-followup-e2e.js --allow-worker-running',
      '',
    ].join('\n'));
    process.exit(1);
  }
}

let cleanedUp = false;
const state = {
  followupRowId: null,
  msgIds: [],
  settingsBefore: undefined, // undefined — ещё не читали; null — строки не было
  dialogEscalationCleared: false,
};

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if (state.followupRowId != null) {
      await db.query(`DELETE FROM agent_followups WHERE id=$1`, [state.followupRowId]);
    }
    if (state.msgIds.length) {
      await db.query(`DELETE FROM chatpush_messages WHERE id = ANY($1::int[])`, [state.msgIds]);
    }
    if (state.settingsBefore === null) {
      await db.query(`DELETE FROM agent_settings WHERE salon_id=$1`, [SALON_ID]);
    } else if (state.settingsBefore) {
      const b = state.settingsBefore;
      await db.query(
        `UPDATE agent_settings
            SET enabled=$2, mode=$3, followup_delay1_min=$4, followup_delay2_min=$5,
                updated_at=now()
          WHERE salon_id=$1`,
        [SALON_ID, b.enabled, b.mode, b.followup_delay1_min, b.followup_delay2_min]);
    }
    console.log('прибрано (строка очереди, тестовые сообщения, настройки салона восстановлены)');
  } catch (e) {
    console.error('УБОРКА НЕ ЗАВЕРШЕНА:', e);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.warn(`\n⚠️  получен ${sig} — аварийная уборка перед выходом`);
    await cleanup();
    try { await pool.end(); } catch (_) {}
    process.exit(1);
  });
}

async function main() {
  guardAgainstLiveWorker();

  const salon = await db.oneOrNone(`SELECT id, name FROM salons WHERE id=$1`, [SALON_ID]);
  if (!salon) throw new Error(`салон #${SALON_ID} не найден`);
  console.log(`салон #${salon.id} «${salon.name}», телефон ${PHONE}, stage=${STAGE}${REAL_SEND ? ' [РЕАЛЬНАЯ ОТПРАВКА]' : ''}`);

  // ── 1. Настройки салона: читаем и запоминаем ДО изменения ──────────────
  const before = await db.oneOrNone(
    `SELECT enabled, mode, followup_delay1_min, followup_delay2_min
       FROM agent_settings WHERE salon_id=$1`, [SALON_ID]);
  state.settingsBefore = before || null;
  console.log('настройки салона ДО прогона:', before || '(строки agent_settings нет вовсе)');

  await db.query(
    `INSERT INTO agent_settings (salon_id, enabled, mode, followup_delay1_min, followup_delay2_min, updated_at)
     VALUES ($1, TRUE, 'all', $2, $3, now())
     ON CONFLICT (salon_id) DO UPDATE
       SET enabled=TRUE, mode='all', followup_delay1_min=$2, followup_delay2_min=$3, updated_at=now()`,
    [SALON_ID, DEFAULT_DELAY1_MIN, DEFAULT_DELAY2_MIN]);
  console.log(`настройки салона временно: enabled=true, mode=all, followup_delay1_min=${DEFAULT_DELAY1_MIN}, followup_delay2_min=${DEFAULT_DELAY2_MIN}`);

  try {
    // ── 2. Пауза «отвечает оператор» блокирует followup-worker шаг 5 ────
    const dlg = await db.oneOrNone(
      `SELECT status FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON_ID, PHONE]);
    if (dlg && dlg.status === 'escalated') {
      await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON_ID, PHONE]);
      state.dialogEscalationCleared = true;
      console.log(`диалог ${PHONE} был на паузе (agent_dialogs.status='escalated') — снята для теста, НЕ восстанавливается (тестовый номер)`);
    }

    // ── 3. Транскрипт для LLM: ДВА обмена подряд, БЕЗ единого времени в тексте ──
    // Почему два обмена, а не один: history.loadTranscript() (общий для
    // оркестратора и всех воркеров без tool-цикла) переносит ХВОСТОВОЙ
    // assistant-блок «перед последний user-блок», если транскрипт кончается
    // репликой Милы, — так задумано для orchestratora (Claude/Polza отвергает
    // диалог, кончающийся assistant-репликой, инцидент 2026-07-26). У РОВНО
    // ДВУХ сырых сообщений (один обмен) это стирает единственную реплику Милы
    // из messages целиком — она проваливается в неиспользуемый followup-worker'ом
    // leadingClinic, и модель получает голый вопрос клиента без единого ответа
    // (проверено живьём при разработке этого скрипта: LLM честно ответила
    // skip — «ответа от Милы в переписке нет»). При ≥2 обменах содержимое НЕ
    // теряется (переносится/склеивается, а не выбрасывается) — контент survives,
    // и это ближе к реальному диалогу, который обычно и предшествует
    // напоминанию. Это ОСТАТОЧНАЯ странность общего кода, а не баг этого
    // скрипта: результат зависит от РЕАЛЬНОЙ формы диалога на проде и его
    // тоже стоит разобрать отдельно (см. отчёт по Task 14).
    const now = Date.now();
    const anchorMs = now - 20 * 60000;        // «Мила ответила 20 минут назад» — якорь
    const trigInMs = anchorMs - 2 * 60000;    // вопрос клиента, приведший к якорю
    const oldOutMs = anchorMs - 20 * 60000;   // более ранний, уже закрытый обмен
    const oldInMs = oldOutMs - 2 * 60000;
    const stamp = now.toString(36);
    const inserted = await db.any(
      `INSERT INTO chatpush_messages
         (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts)
       VALUES
         ($1, NULL, 'whatsapp', 'incoming', $2, 'text', $3,  $4, $5),
         ($1, NULL, 'whatsapp', 'outgoing', $6, 'text', $7,  $4, $8),
         ($1, NULL, 'whatsapp', 'incoming', $9, 'text', $10, $4, $11),
         ($1, NULL, 'whatsapp', 'outgoing', $12,'text', $13, $4, $14)
       ON CONFLICT (salon_id, external_message_id) DO NOTHING
       RETURNING id`,
      [SALON_ID,
       `e2e-followup:in1:${stamp}`, 'Здравствуйте! А эпиляция подмышек у вас есть?', PHONE, Math.floor(oldInMs / 1000),
       `e2e-followup:out1:${stamp}`, 'Здравствуйте! Да, эпиляция подмышек у нас есть.', Math.floor(oldOutMs / 1000),
       `e2e-followup:in2:${stamp}`, 'Здравствуйте! Подскажите, пожалуйста, сколько стоит комбинированная чистка лица у Юлии?', Math.floor(trigInMs / 1000),
       `e2e-followup:out2:${stamp}`, 'Здравствуйте! Комбинированная чистка лица у Юлии стоит от 4500 ₽. Дайте знать, если захотите записаться — подберём удобное время.', Math.floor(anchorMs / 1000)]);
    state.msgIds = inserted.map((r) => r.id);
    console.log(`вставлено сообщений для транскрипта: ${state.msgIds.length} (id ${state.msgIds.join(', ') || '—'})`);

    // ── 4. Строка ожидания — вплотную к processTick (см. шапку файла) ───
    const row = await db.oneOrNone(
      `INSERT INTO agent_followups
         (salon_id, dialog_key, phone, channel, chat_id, anchor_at, next_at,
          stage, status, close_reason, attempts, last_attempt_at)
       VALUES ($1,$2,$3,'whatsapp',NULL, to_timestamp($4), NOW() - interval '1 minute',
               $5,'scheduled',NULL,0,NULL)
       RETURNING id`,
      [SALON_ID, PHONE, PHONE, anchorMs / 1000, STAGE]);
    if (!row) throw new Error('INSERT agent_followups не вернул строку');
    state.followupRowId = row.id;
    console.log(`строка очереди #${row.id} (stage=${STAGE}) поставлена на «сейчас» — с этого момента она ЖИВАЯ`
      + ' (next_at в прошлом, годна к аренде любым процессом, читающим agent_followups)');

    // ── 5. Один тик настоящего воркера ───────────────────────────────────
    const captured = [];
    const deps = {};
    if (!REAL_SEND) {
      deps.sendMessage = async (payload) => {
        captured.push(payload);
        console.log(`\n=== ТЕКСТ (не отправлен) ===\n${payload.text}\n=== канал: ${(payload.dispatchRouting || []).join(',')} ===\n`);
        return { id: 'stub', channel: (payload.dispatchRouting || [])[0] || null };
      };
      deps.rememberPending = async () => {};
      deps.persistWhatsapp = async () => {};
    }
    await worker.processTick(deps);

    // ── 6. Итог ───────────────────────────────────────────────────────────
    const after = await db.oneOrNone(
      `SELECT stage, status, close_reason, rendered_text, error, nudge1_at, final_at, updated_at
         FROM agent_followups WHERE id=$1`, [row.id]);
    console.log('итог строки:', after);
    console.log(`перехвачено сообщений (не отправлено): ${captured.length}`);
  } finally {
    await cleanup();
  }

  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup();
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
