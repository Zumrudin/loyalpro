'use strict';
// Живой смоук «Отдела заботы»: создаёт временную программу «[E2E] care-smoke»,
// касание Т+1 и enrollment на тестовый номер со scheduled_at=NOW(), затем ждёт,
// пока строку обработает БОЕВОЙ pm2-воркер (реальный LLM + реальная отправка в
// Chatpush), печатает решение и чистит за собой.
//
// ВАРИАНТ А (сознательно): свой processTick НЕ гоняем — на деве воркер тикает
// каждые 15с и всё равно заберёт строку первым (SKIP LOCKED отдаст её кому-то
// одному); poll честнее проверяет боевой путь и не плодит вторую инициализацию
// LLM-провайдера в процессе скрипта.
//
// Что скрипт правит во окружении на время прогона (и откатывает в finally):
//  - agent_dialogs тестового номера: если статус 'escalated' — воркер честно
//    скипнет «диалог на операторе», поэтому на время теста ставим 'bot' и
//    ПОЛНОСТЬЮ восстанавливаем прежние status/escalated_reason после;
//  - agent_number_rules: если номера нет в whitelist при mode='whitelist' —
//    добавляем allow-правило и удаляем после (ТОЛЬКО если добавляли сами).
// Доставленное сообщение из chatpush_messages НЕ удаляем: оно реально ушло
// пациенту и обязано остаться в истории чата (симметрия с реальностью).
//
// Честные исходы, которые скрипт распознаёт и докладывает:
//  - sent + живой текст Милы (цель смоука);
//  - skipped/cancelled с внятной decision_reason (гейт, оператор, reply-guard…);
//  - анти-спам «1 в день»: строка осталась scheduled, но уехала на завтра
//    (decision_reason 'анти-спам: …') — сегодня номеру уже слали касание;
//  - timeout: воркер не забрал строку (выключен? env?) — смотреть pm2 logs.
//
// ВНИМАНИЕ: ходит в платный LLM и шлёт РЕАЛЬНОЕ сообщение на номер.
// Финальная чистка уносит и sent-журнал (каскад от программы), поэтому
// анти-спам «1 в день» свой же прошлый прогон НЕ увидит — каждый повторный
// запуск в тот же день отправит ещё одно реальное сообщение.
// Запуск: cd backend && node scripts/care-e2e.js [phone]   (дефолт 79200255591)

const { db, pool } = require('../db');
const agentSettings = require('../services/agent-settings');

const PHONE = process.argv[2] || '79200255591';
const SALON_ID = Number(process.env.CARE_E2E_SALON || 1); // дев: 1 = PERI CLINIC (сверено 2026-08-03)
const POLL_MS = 2000;
const POLL_TIMEOUT_MS = 120000; // тик 15с + LLM до 60с + запас; больше эталонных ~40с сознательно

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let programId = null;
  let addedAllowRule = null;   // {id} — удалить ТОЛЬКО если добавляли сами
  let savedDialog;             // undefined = не трогали; null = строки не было; {...} = была
  try {
    // ── преflight: салон и гейт ─────────────────────────────────
    const salon = await db.oneOrNone(`SELECT id, name FROM salons WHERE id=$1`, [SALON_ID]);
    if (!salon) throw new Error(`салон #${SALON_ID} не найден (env CARE_E2E_SALON?)`);
    console.log(`салон #${salon.id} «${salon.name}», номер ${PHONE}`);

    const settings = await agentSettings.getSettings(SALON_ID);
    console.log(`агент: enabled=${settings.enabled}, mode=${settings.mode}, schedule=${settings.scheduleEnabled}`);
    if (!settings.enabled) {
      console.log('гейт: агент выключен в админке — воркер поставит skipped. Прерываю без вставки.');
      return;
    }

    let gate = await agentSettings.isAllowed(SALON_ID, PHONE);
    if (!gate.allow && settings.mode === 'whitelist') {
      const existing = await db.oneOrNone(
        `SELECT id FROM agent_number_rules WHERE salon_id=$1 AND phone=$2 AND rule_type='allow'`,
        [SALON_ID, PHONE]);
      if (!existing) {
        addedAllowRule = await agentSettings.addNumberRule(SALON_ID, { phone: PHONE, ruleType: 'allow', note: '[E2E] care-smoke (временно)' });
        console.log(`whitelist: добавил временное allow-правило #${addedAllowRule.id}`);
        gate = await agentSettings.isAllowed(SALON_ID, PHONE);
      }
    }
    console.log(`гейт Милы: allow=${gate.allow}${gate.reason ? ` (${gate.reason})` : ''}` +
      (gate.allow ? '' : ' — ожидаем честный skipped'));

    // Диалог на операторе → воркер скипнет; на время теста возвращаем боту.
    const dlg = await db.oneOrNone(
      `SELECT status, escalated_reason FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`,
      [SALON_ID, PHONE]);
    if (dlg && dlg.status === 'escalated') {
      console.log(`диалог был escalated («${dlg.escalated_reason}») — на время теста ставлю 'bot', восстановлю после`);
      await db.query(
        `UPDATE agent_dialogs SET status='bot', escalated_reason=NULL, updated_at=now()
          WHERE salon_id=$1 AND dialog_key=$2`, [SALON_ID, PHONE]);
      savedDialog = dlg; // восстановить в finally; иначе undefined — не трогали
    }

    // Анти-спам «1 в день»: если сегодня уже слали — воркер сдвинет строку.
    const sentToday = await db.oneOrNone(
      `SELECT s.id FROM care_touch_sends s JOIN care_enrollments e ON e.id=s.enrollment_id
        WHERE e.salon_id=$1 AND e.phone=$2 AND s.status='sent'
          AND (s.sent_at AT TIME ZONE 'Europe/Moscow')::date=(NOW() AT TIME ZONE 'Europe/Moscow')::date
        LIMIT 1`, [SALON_ID, PHONE]);
    if (sentToday) console.log(`ВНИМАНИЕ: сегодня номеру уже слали care-касание (#${sentToday.id}) — ожидаем сдвиг «анти-спам» вместо отправки`);

    // ── тестовые данные ─────────────────────────────────────────
    const p = await db.one(
      `INSERT INTO care_programs (salon_id, title, conditions)
       VALUES ($1, '[E2E] care-smoke', '{"logic":"and","items":[]}') RETURNING id`,
      [SALON_ID]);
    programId = p.id;
    const t = await db.one(
      `INSERT INTO care_touches (salon_id, program_id, title, delay_days, send_time, intent_text, sort_order)
       VALUES ($1,$2,'Т+1 самочувствие',1,'10:30',
               'Узнать самочувствие после вчерашней процедуры, нет ли дискомфорта.',0)
       RETURNING id`, [SALON_ID, programId]);
    const e = await db.one(
      `INSERT INTO care_enrollments (salon_id, program_id, phone, yclients_record_id,
                                     visit_at, staff_name, services)
       VALUES ($1,$2,$3, 999999901, NOW() - interval '1 day', 'Гаджиева Пери',
               '[{"id":1,"title":"Биоревитализация"}]'::jsonb)
       RETURNING id`, [SALON_ID, programId, PHONE]);
    const s = await db.one(
      `INSERT INTO care_touch_sends (salon_id, enrollment_id, touch_id, scheduled_at)
       VALUES ($1,$2,$3, NOW()) RETURNING id`, [SALON_ID, e.id, t.id]);

    console.log(`enrollment #${e.id}, send #${s.id} создан (scheduled_at=NOW()), жду pm2-воркер (тик 15с, до ${POLL_TIMEOUT_MS / 1000}с)…`);

    // ── poll: ждём боевой воркер ────────────────────────────────
    const started = Date.now();
    let send = null;
    while (Date.now() - started < POLL_TIMEOUT_MS) {
      await sleep(POLL_MS);
      send = await db.one(
        `SELECT status, attempts, decision_reason, rendered_text, channel_used, delivery_id, error,
                scheduled_at, sent_at, scheduled_at > NOW() AS shifted
           FROM care_touch_sends WHERE id=$1`, [s.id]);
      if (send.status !== 'scheduled') break;                       // терминальный исход
      if (send.shifted) { console.log('строка сдвинута в будущее (анти-спам «1 в день») — отправки сегодня не будет'); break; }
      if (send.attempts > 0) process.stdout.write(`  …в работе (attempt ${send.attempts})\r`);
    }
    if (!send || (send.status === 'scheduled' && !send.shifted)) {
      console.log('\nTIMEOUT: воркер не обработал строку — проверь pm2 logs loyalpro (запущен ли care-воркер, env CHATPUSH_*)');
    }
    if (send && send.status !== 'scheduled') {
      // Settle-re-read: status='sent' пишется mark-before-send'ом ДО реальной
      // отправки — delivery_id/channel_used (шаг 3 воркера) и завершение
      // цепочки (maybeCompleteChain) дозаписываются позже. Без паузы первый
      // прогон печатал sent с channel_used=null и enrollment 'active'.
      await sleep(10000);
      send = await db.one(
        `SELECT status, attempts, decision_reason, rendered_text, channel_used, delivery_id, error,
                scheduled_at, sent_at, FALSE AS shifted
           FROM care_touch_sends WHERE id=$1`, [s.id]);
    }
    if (send) {
      const { shifted, ...out } = send;
      console.log('\nРЕЗУЛЬТАТ:', JSON.stringify(out, null, 2));
    }
    const enr = await db.one(`SELECT status, status_reason FROM care_enrollments WHERE id=$1`, [e.id]);
    console.log('ENROLLMENT:', JSON.stringify(enr));

    // ── подтверждение доставки в chatpush_messages ─────────────
    if (send && send.status === 'sent') {
      const msg = await db.oneOrNone(
        `SELECT id, channel, direction, external_message_id, left(text, 80) AS text_head
           FROM chatpush_messages
          WHERE salon_id=$1 AND phone=$2 AND direction='outgoing' AND text=$3
          ORDER BY id DESC LIMIT 1`, [SALON_ID, PHONE, send.rendered_text]);
      console.log('CHATPUSH_MESSAGES:', msg
        ? JSON.stringify(msg)
        : '(нет строки — для telegram/max эхо может запоздать, для whatsapp это дефект persist-on-send)');
    }
  } finally {
    // Чистка ОБЯЗАТЕЛЬНА: программа каскадом уносит touches/enrollments/sends.
    if (programId) {
      await db.query(`DELETE FROM care_programs WHERE id=$1`, [programId]).catch((e) => console.error('cleanup program:', e.message));
      console.log(`почищено: программа #${programId} (каскад: касание, enrollment, send)`);
    }
    if (addedAllowRule) {
      await agentSettings.removeNumberRule(SALON_ID, addedAllowRule.id).catch((e) => console.error('cleanup rule:', e.message));
      console.log(`почищено: временное allow-правило #${addedAllowRule.id}`);
    }
    if (savedDialog !== undefined) {
      await db.query(
        `UPDATE agent_dialogs SET status=$3, escalated_reason=$4, updated_at=now()
          WHERE salon_id=$1 AND dialog_key=$2`,
        [SALON_ID, PHONE, savedDialog.status, savedDialog.escalated_reason]
      ).catch((e) => console.error('cleanup dialog:', e.message));
      console.log(`восстановлено: agent_dialogs → ${savedDialog.status}`);
    }
  }
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('CARE E2E FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
