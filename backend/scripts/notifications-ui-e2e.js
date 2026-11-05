'use strict';
// ============================================================
// Живая проверка вкладки «Автоуведомления» (Task 10 плана 2026-10-13-yclients-notifications-own-module):
// headless-Chrome против запущенного дев-сервера, по образцу reminders-ui-e2e.js.
//
//   node scripts/notifications-ui-e2e.js
//
// ДЕВ ПОЛУЧАЕТ НАСТОЯЩИЕ ВЕБХУКИ КЛИНИКИ, поэтому скрипт НИКОГДА не включает модуль:
//  • стартует только при mode='off' (иначе отказывается работать);
//  • настройки сохраняет С РЕЖИМОМ «выключен» и теми же значениями, что были; режимы «тень» и «боевой»
//    в выпадающем списке только ЧИТАЕТСЯ подсказка («боевой» выбирается и тут же возвращается назад,
//    кнопка «Сохранить» при этом не нажимается); подтверждение «Включить боевой режим?» ловится
//    обработчиком диалогов, отклоняется и валит прогон;
//  • тест правила гоняется в off: ручка отвечает 409 и строку НЕ создаёт (проверяем по БД).
//
// Сценарий: «Рассылка» → «Автоуведомления» → список из 7 типов → правило «Напоминание» с условием по
// категории (предупреждение «нет просьбы подтвердить» и отказ от confirm) → правило «Рекомендации» с
// картинкой из frontend/uploads/notify_seed/ (загрузка, предпросмотр, замена, «Убрать») → правило
// «Запись отменена» (флаг «клиент не придёт») → выключение тумблером правила с запланированной отправкой
// (confirm, отказ возвращает тумблер, согласие гасит отправку) и правка текста выключенного правила (редактор
// isEnabled не шлёт — правило не должно включиться) → «🧪 Тест» в off → «⚙️ Настройки» (поля из БД, каскад стрелками, проверки
// формы, сохранение с режимом «выключен») → журнал с фильтрами и «Отменить» (строки заведены напрямую в
// БД) → «Оценки» → «Сверка с Chatpush» → удаление правил через UI (запланированная отправка правила
// гасится, файлы картинок удаляются). Скриншоты /tmp/notify-ui-*.png: светлая и тёмная темы и телефон 390px.
// Чистит за собой всё, включая файлы вложений; в конце проверяет, что режим по-прежнему off.
// Единственная допустимая ошибка консоли — 409 от «Теста» в режиме off.
// ГОТЧА puppeteer: смена isMobile/hasTouch у viewport ПЕРЕЗАГРУЖАЕТ страницу — после неё вкладку открываем заново.
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const UPLOADS = path.join(__dirname, '../../frontend/uploads');
const SEED = path.join(UPLOADS, 'notify_seed');
let lastStep = '';
const ok = (m) => { lastStep = m; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const step = (m) => { lastStep = m; };
const fail = (m) => { throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PREFIX = 'E2E-уведомление';
const T_REMIND = `${PREFIX}: напоминание (тест, удалить)`;
const T_AFTER = `${PREFIX}: рекомендации (тест, удалить)`;
const T_CANCEL = `${PREFIX}: отмена (тест, удалить)`;
const TEST_PHONE = '79990001122';
const REC = [-987654301, -987654302, -987654303, -987654304, -987654305, -987654306];   // фиктивные id записей журнала
const SETTINGS_COLS = `mode, default_channels, prefer_last_channel, quiet_from, quiet_to, confirm_reply_text,
  rating_high_text, rating_mid_text, rating_low_text, rating_escalate_low`;

async function main() {
  // ── страховки до браузера ──
  const before = await db.oneOrNone(`SELECT ${SETTINGS_COLS} FROM notification_settings WHERE salon_id = 1`);
  const modeBefore = before ? before.mode : 'off';
  if (modeBefore !== 'off') fail(`режим модуля «${modeBefore}», а не off — отказываюсь работать: дев получает настоящие вебхуки клиники`);
  const leftover = await db.one(`SELECT count(*)::int AS n FROM notification_rules WHERE salon_id = 1 AND title LIKE $1`, [PREFIX + '%']);
  if (leftover.n) fail('в БД остались тестовые правила прошлого прогона — удалите их вручную: ' + PREFIX + '%');

  const user = await db.oneOrNone(`SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') AND salon_id = 1 ORDER BY id LIMIT 1`);
  if (!user) fail('нет owner/admin в салоне 1');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role }, config.JWT_SECRET, { expiresIn: '30m' });
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'notifications-ui-e2e', NOW() + INTERVAL '30 minutes')`, [user.id, token]);

  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  });
  const consoleErrors = [];
  const dialogs = [];                 // все confirm()/alert() страницы: { message, accepted }
  const dialogPlan = [];              // очередь решений для ближайших диалогов (пусто — принять)
  let liveConfirmSeen = false;
  const ruleIds = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900 });
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', async (d) => {
      const message = d.message();
      if (/боевой режим/i.test(message)) { liveConfirmSeen = true; dialogs.push({ message, accepted: false }); await d.dismiss(); return; }
      const accept = dialogPlan.length ? dialogPlan.shift() : true;
      dialogs.push({ message, accepted: accept });
      if (accept) await d.accept(); else await d.dismiss();
    });
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);

    const rulesIdle = () => page.waitForFunction(() =>
      !document.getElementById('ntSub-rules').textContent.includes('Загрузка'), { timeout: 20000 });
    const jobsIdle = () => page.waitForFunction(() =>
      !document.getElementById('ntJobsList').textContent.includes('Загрузка'), { timeout: 15000 });
    const closed = (id) => page.waitForFunction((i) => !document.getElementById(i).classList.contains('open'), { timeout: 20000 }, id);
    const ruleRow = (id) => `.nt-rule[data-id="${id}"]`;
    const ruleId = async (title) => (await db.oneOrNone(`SELECT id FROM notification_rules WHERE salon_id=1 AND title=$1`, [title]) || {}).id;
    const dbRule = (id) => db.one(`SELECT * FROM notification_rules WHERE id=$1`, [id]);
    const notifText = () => page.$eval('#notif', (e) => e.textContent);
    const click = async (sel) => {
      for (let i = 0; ; i++) {
        try { await page.click(sel); return; }
        catch (err) { if (i >= 6 || !/detached|not clickable|not an Element/.test(err.message)) throw err; await sleep(250); }
      }
    };
    const shot = (name) => page.screenshot({ path: `/tmp/notify-ui-${name}.png` });

    // ── вход: вкладка «Автоуведомления» ──
    await page.goto(BASE + '/#broadcasts', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#page-broadcasts.active', { timeout: 20000 });
    await page.click('#bcTabBtn-rules');
    await rulesIdle();
    ok('страница «Рассылка» открыта по deep-link, вкладка «Автоуведомления» загрузилась');

    await page.waitForFunction(() => typeof _ntDicts !== 'undefined' && !!_ntDicts, { timeout: 30000 });   // справочник дорисовывает сводки — не кликаем во время перерисовки
    const cards = await page.$$eval('.nt-type', (els) => els.map((e) => ({ type: e.dataset.type, label: e.querySelector('b').textContent })));
    const wantTypes = ['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_review', 'visit_after', 'first_visit'];
    if (JSON.stringify(cards.map((c) => c.type)) !== JSON.stringify(wantTypes)) fail('карточки типов: ' + JSON.stringify(cards));
    ok('список типов: ' + cards.map((c) => c.label).join(' · '));
    const modeLine = await page.$eval('#ntModeLine', (e) => e.textContent);
    if (!/Режим: ⚪ выключен/.test(modeLine)) fail('строка режима: ' + modeLine);
    if (!(await page.$('.nt-banner'))) fail('нет плашки «модуль выключен»');
    ok('строка режима: «' + modeLine + '», плашка «модуль выключен» на месте');
    const hintsText = await page.$eval('#ntSub-rules', (e) => e.textContent);
    for (const must of ['Удаление записи уведомления не шлёт — как YClients', 'по уже подтверждённым визитам не шлётся',
      'не чаще раза в 30 дней', 'по услугам, с картинкой', 'при создании первой записи', 'только для будущих визитов']) {
      if (!hintsText.includes(must)) fail('в подсказках типов нет: «' + must + '»');
    }
    ok('подсказки типов — утверждённые тексты');

    // ── правило «Напоминание о визите» с условием по категории ──
    await click('.nt-type[data-type="visit_reminder"] .btn');
    await page.waitForSelector('#ntEditorOv.open', { timeout: 20000 });
    if ((await page.$eval('#ntType', (e) => e.value)) !== 'visit_reminder') fail('тип в редакторе не предвыбран');
    if ((await page.$eval('#ntHours', (e) => e.value)) !== '24') fail('часы до визита по умолчанию не 24');
    if (!(await page.$eval('#ntAsk', (e) => e.checked))) fail('«Просить подтверждение» по умолчанию должно быть включено');
    if (await page.$eval('#ntTestBtn', (e) => e.style.display) !== 'none') fail('кнопка «Тест» не должна быть видна у нового правила');
    const placeholder = await page.$eval('#ntText', (e) => e.placeholder);
    if (!/подтвердите визит/.test(placeholder)) fail('нет образца текста в placeholder: ' + placeholder);
    ok('редактор нового правила: тип предвыбран, 24 ч, подтверждение включено, «Тест» скрыт, образец текста в подсказке');

    await page.type('#ntTitle', T_REMIND);
    await page.evaluate(() => condAdd('ntf'));
    await page.waitForSelector('#ntfCondList-0', { timeout: 10000 });
    await page.select('#ntfConds .nr-cond-head select', 'category');
    await page.waitForSelector('#ntfCondList-0 .nr-cond-opt input', { timeout: 20000 }).catch(() => fail('справочник категорий пуст: YClients не ответил'));
    await page.click('#ntfCondList-0 .nr-cond-opt input');
    const condCount = await page.$eval('#ntfCondCount-0', (e) => e.textContent);
    if (!/выбрано: 1/.test(condCount)) fail('условие по категории не выбралось: ' + condCount);
    ok('условие по категории выбрано (' + condCount + ')');

    // Текст без просьбы подтвердить: живое предупреждение, при сохранении — confirm (отклоняем)
    await page.type('#ntText', 'Ждём вас завтра, {first_name}!');
    const warn1 = await page.$$eval('#ntTextWarn .nt-warn', (e) => e.map((x) => x.textContent));
    if (warn1.length !== 1 || !/Подтверждаю/.test(warn1[0])) fail('нет предупреждения про подтверждение: ' + JSON.stringify(warn1));
    dialogPlan.push(false);
    await page.click('#ntSaveBtn');
    await sleep(500);
    if (await ruleId(T_REMIND)) fail('правило сохранилось, хотя confirm отклонён');
    if (!(await page.$eval('#ntEditorOv', (e) => e.classList.contains('open')))) fail('редактор закрылся после отказа от confirm');
    if (!/Сохранить всё равно/.test(dialogs[dialogs.length - 1].message)) fail('не тот confirm: ' + dialogs[dialogs.length - 1].message);
    ok('текст без «подтвердите»: предупреждение под полем, confirm «Сохранить всё равно?» отклонён — ничего не сохранилось');
    await shot('light-editor-warning');

    await page.$eval('#ntText', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('#ntText', 'Здравствуйте, {first_name}! Напоминаем о записи {date} в {time}. Пожалуйста, подтвердите визит.');
    if ((await page.$$eval('#ntTextWarn .nt-warn', (e) => e.length)) !== 0) fail('предупреждение не исчезло после правки текста');
    await page.click('#ntSaveBtn');
    await closed('ntEditorOv');
    await page.waitForFunction((t) => document.getElementById('ntSub-rules').textContent.includes(t), { timeout: 15000 }, T_REMIND);
    const idRemind = await ruleId(T_REMIND);
    if (!idRemind) fail('правило «Напоминание» не найдено в БД');
    ruleIds.push(idRemind);
    const r1 = await dbRule(idRemind);
    if (r1.trigger_type !== 'visit_reminder' || r1.hours_before !== 24 || r1.ask_confirmation !== true || r1.is_enabled !== true) {
      fail('поля правила в БД: ' + JSON.stringify(r1));
    }
    if (r1.conditions.items.length !== 1 || r1.conditions.items[0].type !== 'category') fail('условие в БД: ' + JSON.stringify(r1.conditions));
    const summary1 = await page.$eval(`${ruleRow(idRemind)} .care-meta`, (e) => e.textContent);
    if (!/за 24 ч до визита, просит подтвердить · Категория: /.test(summary1)) fail('сводка правила: ' + summary1);
    ok('правило «Напоминание» создано: 24 ч, подтверждение, условие по категории; сводка «' + summary1 + '»');

    // ── правило «Рекомендации после процедуры» с картинкой ──
    await click('.nt-type[data-type="visit_after"] .btn');
    await page.waitForSelector('#ntEditorOv.open', { timeout: 20000 });
    if ((await page.$eval('#ntDelay', (e) => e.value)) !== '5') fail('минуты после визита по умолчанию не 5');
    await page.type('#ntTitle', T_AFTER);
    await page.type('#ntText', 'Рекомендации после процедуры «{services}»');
    const fileInput = await page.$('#ntFile');
    if (!fileInput) fail('нет поля загрузки картинки у visit_after');
    await fileInput.uploadFile(path.join(SEED, 'Пилинг.jpg'));
    await page.click('#ntSaveBtn');
    await closed('ntEditorOv');
    await page.waitForFunction((t) => document.getElementById('ntSub-rules').textContent.includes(t), { timeout: 15000 }, T_AFTER);
    const idAfter = await ruleId(T_AFTER);
    if (!idAfter) fail('правило «Рекомендации» не найдено в БД');
    ruleIds.push(idAfter);
    let r2 = await dbRule(idAfter);
    const urlRe = new RegExp(`^/uploads/notify_1_${idAfter}_\\d+\\.jpg$`);
    if (!urlRe.test(r2.attachment_url || '')) fail('attachment_url в БД: ' + r2.attachment_url);
    if (r2.attachment_name !== 'Пилинг.jpg') fail('attachment_name в БД (кириллица): ' + r2.attachment_name);
    if (r2.delay_minutes !== 5) fail('delay_minutes в БД: ' + r2.delay_minutes);
    const file1 = path.join(UPLOADS, path.basename(r2.attachment_url));
    if (!fs.existsSync(file1) || fs.statSync(file1).size !== fs.statSync(path.join(SEED, 'Пилинг.jpg')).size) fail('файл вложения не на диске или не тот размер');
    if (!(await page.$(`${ruleRow(idAfter)} [title="К сообщению приложена картинка"]`))) fail('в списке нет значка 📎');
    ok('правило «Рекомендации»: создано вместе с картинкой (' + r2.attachment_url + ', имя «' + r2.attachment_name + '»), файл на диске');

    // Повторное открытие: картинка видна и реально грузится с сервера
    await page.evaluate((id) => ntOpenEditor(id), idAfter);
    await page.waitForSelector('#ntEditorOv.open .nt-att img', { timeout: 15000 });
    await page.waitForFunction(() => { const i = document.querySelector('.nt-att img'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 15000 });
    if ((await page.$eval('#ntType', (e) => e.disabled)) !== true) fail('тип существующего правила должен быть заблокирован');
    ok('повторное открытие: превью картинки загрузилось с сервера, тип заблокирован');
    await sleep(500);                                    // дождаться конца анимации открытия модалки
    await shot('light-editor-image');

    // «Убрать картинку» → файл и ссылка исчезают
    await page.click('.nt-att .btn');
    await page.waitForFunction(() => !document.querySelector('.nt-att'), { timeout: 10000 });
    r2 = await dbRule(idAfter);
    if (r2.attachment_url !== null || r2.attachment_name !== null) fail('картинка не убрана в БД');
    await sleep(300);
    if (fs.existsSync(file1)) fail('файл картинки остался на диске после «Убрать»');
    ok('«Убрать картинку»: в БД NULL, файл удалён с диска');

    // Замена: существующее правило + новый файл
    await (await page.$('#ntFile')).uploadFile(path.join(SEED, 'Ботулинотерапия.jpg'));
    await page.click('#ntSaveBtn');
    await closed('ntEditorOv');
    r2 = await dbRule(idAfter);
    if (!urlRe.test(r2.attachment_url || '') || r2.attachment_name !== 'Ботулинотерапия.jpg') fail('замена картинки: ' + JSON.stringify([r2.attachment_url, r2.attachment_name]));
    const file2 = path.join(UPLOADS, path.basename(r2.attachment_url));
    if (!fs.existsSync(file2)) fail('новый файл вложения не на диске');
    ok('замена: у существующего правила загружена другая картинка (' + r2.attachment_name + ')');

    // ── правило «Запись отменена»: флаг «клиент не придёт» ──
    await click('.nt-type[data-type="record_cancelled"] .btn');
    await page.waitForSelector('#ntEditorOv.open', { timeout: 20000 });
    const noShowLbl = await page.$eval('#ntTypeFields', (e) => e.textContent);
    if (!/Удаление записи уведомления не шлёт — как YClients/.test(noShowLbl)) fail('подпись флага «клиент не придёт»: ' + noShowLbl);
    if (!(await page.$eval('#ntNoShow', (e) => e.checked))) fail('флаг «клиент не придёт» по умолчанию должен быть включён');
    await page.type('#ntTitle', T_CANCEL);
    await page.type('#ntText', '❌ Ваша запись в «{salon}» {date} в {time} отменена');
    await page.click('#ntNoShow');
    await page.click('#ntSaveBtn');
    await closed('ntEditorOv');
    await page.waitForFunction((t) => document.getElementById('ntSub-rules').textContent.includes(t), { timeout: 15000 }, T_CANCEL);
    const idCancel = await ruleId(T_CANCEL);
    if (!idCancel) fail('правило «Запись отменена» не найдено в БД');
    ruleIds.push(idCancel);
    const r3 = await dbRule(idCancel);
    if (r3.on_no_show !== false) fail('on_no_show в БД: ' + r3.on_no_show);
    await page.waitForFunction((id) => /не отправляется/.test(document.querySelector(`.nt-rule[data-id="${id}"] .care-meta`).textContent), { timeout: 10000 }, idCancel);
    ok('«Запись отменена»: флаг снят → в БД on_no_show=false, в списке «не отправляется»');

    // Строки очереди заводим напрямую в БД (дальше — шаг с тумблером и журнал).
    const jobBase = `INSERT INTO notification_jobs
        (salon_id, rule_id, rule_title, trigger_type, yclients_record_id, visit_datetime, phone, scheduled_at, status,
         rendered_text, attachment_url, cascade_log, channel_used, confirmed_at, sent_at, decision_reason, error)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16) RETURNING id`;
    const mk = (rid, title, type, rec, visit, sched, status, text, att, log, ch, conf, sent, reason, err) =>
      db.one(jobBase, [rid, title, type, rec, visit, TEST_PHONE, sched, status, text, att, JSON.stringify(log), ch, conf, sent, reason, err])
        .then((r) => Number(r.id));    // BIGSERIAL приходит строкой
    const now = Date.now();
    const iso = (ms) => new Date(now + ms).toISOString();

    // ── тумблер и правка выключенного правила ──
    // У правила есть запланированная отправка: выключение должно спросить и (контракт T9 после ревью) погасить её.
    const jToggle = await mk(idRemind, T_REMIND, 'visit_reminder', REC[5], iso(3 * 86400000), iso(2 * 86400000), 'pending',
      'Напоминание (тест e2e: гасится выключением правила)', null, [], null, null, null, null, null);
    await page.evaluate(() => ntLoad());                  // счётчик «ждут отправки» подтянется в карточку правила
    await page.waitForFunction((id) => !!document.querySelector(`.nt-rule[data-id="${id}"] [title="Ждут отправки"]`), { timeout: 15000 }, idRemind);
    dialogPlan.push(false);                               // сперва отказ: тумблер возвращается, правило и очередь на месте
    await click(`${ruleRow(idRemind)} .tgl .ts`);
    await page.waitForFunction((id) => document.querySelector(`.nt-rule[data-id="${id}"] .tgl input`).checked, { timeout: 10000 }, idRemind);
    if (!/будут отменены/.test(dialogs[dialogs.length - 1].message)) fail('не тот confirm при выключении: ' + dialogs[dialogs.length - 1].message);
    let toggled = await db.one(`SELECT r.is_enabled, j.status FROM notification_rules r, notification_jobs j WHERE r.id=$1 AND j.id=$2`, [idRemind, jToggle]);
    if (toggled.is_enabled !== true || toggled.status !== 'pending') fail('отказ от confirm что-то изменил: ' + JSON.stringify(toggled));
    ok('выключение правила с запланированной отправкой спрашивает подтверждение; отказ — тумблер возвращён, очередь цела');
    await click(`${ruleRow(idRemind)} .tgl .ts`);       // теперь подтверждаем
    await page.waitForFunction((id) => !!document.querySelector(`.nt-rule[data-id="${id}"] .care-st-stopped`), { timeout: 10000 }, idRemind);
    toggled = await db.one(`SELECT r.is_enabled, j.status FROM notification_rules r, notification_jobs j WHERE r.id=$1 AND j.id=$2`, [idRemind, jToggle]);
    if (toggled.is_enabled !== false) fail('тумблер не выключил правило в БД');
    if (toggled.status !== 'cancelled') fail('выключение правила не погасило его запланированную отправку: ' + toggled.status);
    ok('подтверждено: правило выключено, его запланированная отправка в БД cancelled');
    await page.evaluate((id) => ntOpenEditor(id), idRemind);
    await page.waitForSelector('#ntEditorOv.open', { timeout: 15000 });
    await page.type('#ntText', ' Ждём вас!');
    await page.click('#ntSaveBtn');
    await closed('ntEditorOv');
    await sleep(300);
    const r1b = await dbRule(idRemind);
    if (r1b.is_enabled !== false) fail('правка текста ВКЛЮЧИЛА выключенное правило (PUT без isEnabled)');
    if (!/Ждём вас!$/.test(r1b.message_template)) fail('новый текст не сохранился');
    if (!(await page.$(`${ruleRow(idRemind)} .care-st-stopped`))) fail('после правки пропал бейдж «выключено»');
    ok('выключенное тумблером правило после правки текста осталось выключенным (редактор isEnabled не шлёт)');
    await click(`${ruleRow(idRemind)} .tgl .ts`);                 // вернуть включённым — для скриншотов и сверки
    await page.waitForFunction((id) => !document.querySelector(`.nt-rule[data-id="${id}"] .care-st-stopped`), { timeout: 10000 }, idRemind);

    // ── «🧪 Тест» в режиме off: 409, строка не создаётся ──
    await page.evaluate((id) => ntOpenEditor(id), idRemind);
    await page.waitForSelector('#ntEditorOv.open', { timeout: 15000 });
    await page.click('#ntTestBtn');
    await page.waitForSelector('#ntTestOv.open', { timeout: 5000 });
    await page.type('#ntTestPhone', TEST_PHONE);
    await page.click('#ntTestSendBtn');
    await page.waitForFunction(() => /Модуль выключен/.test(document.getElementById('ntTestResult').textContent), { timeout: 15000 });
    const testRes = await page.$eval('#ntTestResult', (e) => e.textContent);
    const testRows = await db.one(`SELECT count(*)::int AS n FROM notification_jobs WHERE salon_id=1 AND rule_id=$1 AND COALESCE(meta->>'test', '') = 'true'`, [idRemind]);
    if (testRows.n !== 0) fail('тест в режиме off создал строку в notification_jobs');
    ok('«🧪 Тест» в off: ошибка показана («' + testRes.slice(0, 60) + '…»), строка не создана');
    await shot('light-test-off');
    await page.click('#ntTestOv .mc');
    await closed('ntTestOv');
    await page.click('#ntEditorOv .mc');
    await closed('ntEditorOv');

    // ── ⚙️ Настройки ──
    await page.click('#ntSettingsBtn');
    await page.waitForSelector('#ntSettingsOv.open', { timeout: 15000 });
    const f = await page.evaluate(() => ({
      mode: document.getElementById('ntsMode').value, from: document.getElementById('ntsQuietFrom').value,
      to: document.getElementById('ntsQuietTo').value, confirm: document.getElementById('ntsConfirm').value,
      high: document.getElementById('ntsHigh').value, mid: document.getElementById('ntsMid').value, low: document.getElementById('ntsLow').value,
      escalate: document.getElementById('ntsEscalate').checked, preferLast: document.getElementById('ntsPreferLast').checked,
      order: [...document.querySelectorAll('#ntsChannels .nt-ch')].map((e) => e.dataset.ch),
    }));
    const dbS = before || (await db.one(`SELECT ${SETTINGS_COLS} FROM notification_settings WHERE salon_id = 1`).catch(() => null));
    if (dbS) {
      const same = f.mode === dbS.mode && f.from === (dbS.quiet_from || '') && f.to === (dbS.quiet_to || '')
        && f.confirm === dbS.confirm_reply_text && f.high === dbS.rating_high_text && f.mid === dbS.rating_mid_text
        && f.low === dbS.rating_low_text && f.escalate === dbS.rating_escalate_low && f.preferLast === dbS.prefer_last_channel
        && JSON.stringify(f.order) === JSON.stringify(dbS.default_channels);
      if (!same) fail('поля настроек не совпали с БД: ' + JSON.stringify(f));
    }
    ok('настройки: поля заполнены из БД (режим ' + f.mode + ', каскад ' + f.order.join(' → ') + ', тихие часы ' + f.from + '–' + f.to + ')');
    const hintOff = await page.$eval('#ntsModeHint', (e) => e.textContent);
    if (!/Выключен: правила не работают/.test(hintOff)) fail('подсказка режима off: ' + hintOff);

    // каскад: стрелка ↓ у первого, затем ↑ — порядок возвращается
    const orderNow = () => page.$$eval('#ntsChannels .nt-ch', (e) => e.map((x) => x.dataset.ch));
    if (f.order.length >= 2) {
      await page.click('#ntsChannels .nt-ch:nth-child(1) .nt-ch-btn:nth-of-type(2)');          // ↓
      const swapped = await orderNow();
      if (swapped[0] !== f.order[1] || swapped[1] !== f.order[0]) fail('стрелка ↓ не поменяла порядок: ' + swapped);
      await page.click('#ntsChannels .nt-ch:nth-child(2) .nt-ch-btn:nth-of-type(1)');          // ↑ у второго
      if (JSON.stringify(await orderNow()) !== JSON.stringify(f.order)) fail('стрелка ↑ не вернула порядок');
      ok('каскад: стрелки меняют порядок (↓ у первого, ↑ у второго — возвращено как было)');
    }
    // ✕ у последнего → уходит в «+ …», клик по «+» возвращает его в конец
    const last = f.order[f.order.length - 1];
    await page.click(`#ntsChannels .nt-ch[data-ch="${last}"] .nt-ch-btn[title="Выключить"]`);
    if ((await orderNow()).includes(last)) fail('✕ не выключил мессенджер');
    await page.click(`#ntsChannels .nt-ch-off[data-ch="${last}"]`);
    if (JSON.stringify(await orderNow()) !== JSON.stringify(f.order)) fail('«+» не вернул мессенджер в конец каскада');
    ok('каскад: ✕ выключает мессенджер, «+» возвращает его в конец');

    // «боевой» только читаем подсказку и возвращаем назад — НЕ сохраняем
    await page.select('#ntsMode', 'live');
    const hintLive = await page.$eval('#ntsModeHint', (e) => ({ t: e.textContent, warn: e.classList.contains('nt-warn') }));
    if (!/Chatpush/.test(hintLive.t) || !hintLive.warn) fail('подсказка «боевой» без предупреждения про Chatpush');
    await page.select('#ntsMode', 'off');
    if ((await page.$eval('#ntsMode', (e) => e.value)) !== 'off') fail('режим не вернулся в off');
    ok('режим «боевой» показывает предупреждение про Chatpush; возвращён в «выключен» без сохранения');

    // проверки формы: пустой ответ и «один край» тихих часов — отказ без запроса
    const saveBtn = '#ntsSaveBtn';
    const mustBeOff = async () => { if ((await page.$eval('#ntsMode', (e) => e.value)) !== 'off') fail('перед сохранением режим не off'); };
    await page.$eval('#ntsConfirm', (e) => { e.value = ''; });
    await mustBeOff(); await page.click(saveBtn);
    if (!/не может быть пустым/.test(await notifText())) fail('пустой ответ «Подтверждаю» не отклонён: ' + await notifText());
    await page.$eval('#ntsConfirm', (e, v) => { e.value = v; }, f.confirm);
    await page.$eval('#ntsQuietTo', (e) => { e.value = ''; });
    await mustBeOff(); await page.click(saveBtn);
    if (!/оба поля/.test(await notifText())) fail('одиночная граница тихих часов не отклонена: ' + await notifText());
    await page.$eval('#ntsQuietTo', (e, v) => { e.value = v; }, f.to);
    const midSaved = await db.one(`SELECT ${SETTINGS_COLS} FROM notification_settings WHERE salon_id = 1`);
    if (dbS && (midSaved.confirm_reply_text !== dbS.confirm_reply_text || midSaved.quiet_to !== dbS.quiet_to)) fail('отклонённая форма всё же что-то записала');
    ok('форма: пустой ответ пациенту и одиночная граница тихих часов отклоняются, БД не тронута');
    await shot('light-settings');

    // сохранение с режимом «выключен» и прежними значениями
    await mustBeOff();
    await page.click(saveBtn);
    await closed('ntSettingsOv');
    const after = await db.one(`SELECT ${SETTINGS_COLS} FROM notification_settings WHERE salon_id = 1`);
    if (after.mode !== 'off') fail('после сохранения настроек режим «' + after.mode + '»');
    if (dbS) for (const c of Object.keys(dbS)) {
      if (JSON.stringify(after[c]) !== JSON.stringify(dbS[c])) fail(`настройка ${c} изменилась: ${JSON.stringify(dbS[c])} → ${JSON.stringify(after[c])}`);
    }
    if (liveConfirmSeen) fail('появилось подтверждение боевого режима');
    ok('настройки сохранены с режимом «выключен»: все значения в БД прежние, режим off');

    // ── журнал: строки заведены напрямую в БД ──
    const jPending = await mk(idRemind, T_REMIND, 'visit_reminder', REC[0], iso(3 * 86400000), iso(2 * 86400000), 'pending',
      'Здравствуйте! Напоминаем о записи завтра. Пожалуйста, подтвердите визит (тест e2e, pending)', null, [], null, null, null, null, null);
    const jSent = await mk(idRemind, T_REMIND, 'visit_reminder', REC[1], iso(86400000), iso(-2 * 3600000), 'sent',
      'Здравствуйте!\nНапоминаем о записи (тест e2e, отправлено)\nПожалуйста, подтвердите визит', null,
      [{ ch: 'tdlib', res: 'no_recipient', at: iso(-2 * 3600000) }, { ch: 'whatsapp', res: 'sent', at: iso(-2 * 3600000) }],
      'whatsapp', iso(-1800000), iso(-2 * 3600000), null, null);
    const jShadow = await mk(idAfter, T_AFTER, 'visit_after', REC[2], iso(-3600000), iso(-3 * 3600000), 'shadow',
      'Рекомендации после процедуры (тест e2e, тень)', '/uploads/notify_seed/Пилинг.jpg', [], null, null, null, 'теневой режим: не отправлено', null);
    const jFailed = await mk(idRemind, T_REMIND, 'visit_reminder', REC[3], iso(86400000), iso(-4 * 3600000), 'failed',
      'Напоминание (тест e2e, ошибка)', null,
      [{ ch: 'tdlib', res: 'rejected', err: 'HTTP 422', at: iso(-4 * 3600000) }, { ch: 'whatsapp', res: 'ambiguous', err: 'timeout', at: iso(-4 * 3600000) }],
      null, null, null, null, 'ни один мессенджер не принял: tdlib=rejected, whatsapp=ambiguous');
    const jPendingAfter = await mk(idAfter, T_AFTER, 'visit_after', REC[4], iso(-1800000), iso(5 * 3600000), 'pending',
      'Рекомендации (тест e2e, гасится удалением правила)', null, [], null, null, null, null, null);
    const mskDay = (await db.one(`SELECT (scheduled_at AT TIME ZONE 'Europe/Moscow')::date::text AS d FROM notification_jobs WHERE id=$1`, [jPending])).d;

    await page.click('#ntSubBtn-jobs');
    await jobsIdle();
    const rowsOf = () => page.$$eval('#ntJobsList tbody tr[data-id]', (rows) => rows.map((r) => ({ id: Number(r.dataset.id), status: r.dataset.status })));
    let rows = await rowsOf();
    for (const id of [jPending, jSent, jShadow, jFailed, jPendingAfter]) {
      if (!rows.some((r) => r.id === id)) fail('в журнале нет строки #' + id + '; в списке: ' + JSON.stringify(rows) + '; текст: ' + (await page.$eval('#ntJobsList', (el) => el.innerText)).slice(0, 300));
    }
    const typeOpts = await page.$$eval('#ntJobType option', (o) => o.map((x) => x.value));
    if (typeOpts.length !== 8) fail('фильтр типов: ' + typeOpts);
    ok('журнал: 5 заведённых строк на месте, фильтр типов содержит «Все» + 7 типов');
    // порядок: запланированные сверху по возрастанию времени
    if (rows[0].status !== 'pending') fail('первой должна идти запланированная строка, а не ' + rows[0].status);

    const rowText = (id) => page.$eval(`#ntJobsList tr[data-id="${id}"]`, (e) => e.innerText);
    const tSent = await rowText(jSent);
    if (!/Telegram: нет адресата → WhatsApp: отправлено/.test(tSent)) fail('путь каскада не показан: ' + tSent);
    if (!/✅ подтвердил/.test(tSent)) fail('отметка «подтвердил» не показана: ' + tSent);
    if (!/Отправлено/.test(tSent) || !/WhatsApp/.test(tSent)) fail('статус/канал не показаны: ' + tSent);
    const tFailed = await rowText(jFailed);
    if (!/Telegram: отказ → WhatsApp: сбой/.test(tFailed) || !/ни один мессенджер не принял/.test(tFailed)) fail('строка с ошибкой: ' + tFailed);
    const tPending = await rowText(jPending);
    if (!/\(план\)/.test(tPending) || !(await page.$(`#ntJobsList tr[data-id="${jPending}"] .btn`))) fail('у запланированной нет «(план)» или «Отменить»');
    const tShadow = await rowText(jShadow);
    if (!/Тень/.test(tShadow) || !/теневой режим: не отправлено/.test(tShadow)) fail('строка в тени: ' + tShadow);
    const attHref = await page.$eval(`#ntJobsList tr[data-id="${jShadow}"] a[title="Открыть картинку"]`, (a) => a.getAttribute('href'));
    if (attHref !== '/uploads/notify_seed/Пилинг.jpg') fail('ссылка на картинку: ' + attHref);
    ok('журнал: путь каскада по шагам, «✅ подтвердил», ошибка, «(план)» + «Отменить», тень + ссылка 📎');

    // фильтры
    const pick = async (sel, val) => { await page.select(sel, val); await jobsIdle(); return rowsOf(); };
    rows = await pick('#ntJobStatus', 'sent');
    if (!rows.every((r) => r.status === 'sent') || !rows.some((r) => r.id === jSent) || rows.some((r) => r.id === jPending)) fail('фильтр «Отправлено»: ' + JSON.stringify(rows));
    rows = await pick('#ntJobStatus', 'shadow');
    await page.select('#ntJobType', 'visit_after'); await jobsIdle();
    rows = await rowsOf();
    if (rows.length !== 1 || rows[0].id !== jShadow) fail('фильтр тип+статус: ' + JSON.stringify(rows));
    ok('фильтры: статус «Отправлено» и пара «Рекомендации + Тень» отдают ровно свои строки');
    await page.click('#ntSub-jobs .nt-filters .btn-sm');                 // «Сбросить»
    await jobsIdle();
    rows = await rowsOf();
    if (rows.length < 5) fail('после «Сбросить» строк меньше пяти');
    await page.$eval('#ntJobDate', (e, d) => { e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, mskDay);
    await jobsIdle();
    rows = await rowsOf();
    if (!rows.some((r) => r.id === jPending) || rows.some((r) => r.id === jSent)) fail('фильтр по дню ' + mskDay + ': ' + JSON.stringify(rows));
    ok('фильтр по дню отправки (' + mskDay + ') оставляет только запланированное на этот день');
    await page.click('#ntSub-jobs .nt-filters .btn-sm');
    await jobsIdle();
    await shot('light-journal');

    // «Отменить» у запланированной
    await page.click(`#ntJobsList tr[data-id="${jPending}"] .btn`);
    await page.waitForFunction((id) => document.querySelector(`#ntJobsList tr[data-id="${id}"]`)?.dataset.status === 'cancelled', { timeout: 10000 }, jPending);
    const cancelled = await db.one(`SELECT status, decision_reason FROM notification_jobs WHERE id=$1`, [jPending]);
    if (cancelled.status !== 'cancelled') fail('«Отменить» не отменила строку в БД: ' + JSON.stringify(cancelled));
    ok('«Отменить»: строка #' + jPending + ' в БД cancelled («' + cancelled.decision_reason + '»), в журнале «Отменено»');

    // ── оценки ──
    await db.query(`INSERT INTO visit_ratings (salon_id, yclients_record_id, phone, rating, source_job_id) VALUES (1,$1,$2,5,$3),(1,$4,$2,2,$3)`,
      [REC[1], TEST_PHONE, jSent, REC[3]]);
    await page.click('#ntSubBtn-ratings');
    await page.waitForFunction(() => !document.getElementById('ntRatingsBody').textContent.includes('Загрузка'), { timeout: 15000 });
    const st = await db.one(
      `SELECT count(*)::int AS n, round(avg(rating)::numeric, 2)::float AS avg FROM visit_ratings WHERE salon_id=1 AND created_at > NOW() - interval '30 days'`);
    const ratingsText = await page.$eval('#ntRatingsBody', (e) => e.innerText);
    if (!ratingsText.includes(`${st.n} `) || !ratingsText.includes(`средняя ${st.avg}`)) fail('сводка оценок не сходится с БД: ' + ratingsText.slice(0, 200));
    const ratingCells = await page.$$eval('#ntRatingsBody tbody td b', (e) => e.map((x) => x.textContent));
    if (!ratingCells.includes('5') || !ratingCells.includes('2')) fail('оценки 5 и 2 не показаны: ' + ratingCells);
    ok('«Оценки»: сводка сходится с БД (' + st.n + ' шт., средняя ' + st.avg + '), оценки 5 и 2 в таблице');
    await shot('light-ratings');

    // ── сверка с Chatpush ──
    await page.click('#ntSubBtn-parity');
    await page.waitForFunction(() => !document.getElementById('ntParityBody').textContent.includes('Загрузка'), { timeout: 15000 });
    const parityRows = await page.$$eval('#ntParityBody tbody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
    if (parityRows.length !== 7) fail('строк в сверке не 7: ' + parityRows.length);
    const remRow = parityRows.find((x) => x.startsWith('Напоминание о визите'));
    if (!remRow) fail('нет строки «Напоминание о визите» в сверке');
    const planned = Number(remRow.split(' ')[3]);
    if (!(planned >= 1)) fail('в сверке «Мы (план)» по напоминаниям не видит отправленную строку: ' + remRow);
    await page.select('#ntParityDays', '14');
    await page.waitForFunction(() => !document.getElementById('ntParityBody').textContent.includes('Загрузка') && /За 14 дн/.test(document.getElementById('ntParityBody').textContent), { timeout: 15000 });
    ok('«Сверка с Chatpush»: 7 типов, у напоминаний «Мы (план)» = ' + planned + ', переключение периода на 14 дней работает');
    await page.select('#ntParityDays', '7');
    await page.waitForFunction(() => /За 7 дн/.test(document.getElementById('ntParityBody').textContent), { timeout: 15000 });
    await shot('light-parity');

    // ── скриншоты: правила, редактор и настройки (светлая), затем тёмная тема и телефон ──
    // Диагностика клика, который не нашёл точки нажатия: что открыто, где кнопка и что лежит поверх неё.
    const diag = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      const r = el ? el.getBoundingClientRect() : null;
      const top = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
      return JSON.stringify({ sel: s, rect: r && [r.x, r.y, r.width, r.height], viewport: [innerWidth, innerHeight],
        hitTest: top ? (top.id || top.className || top.tagName) : null, open: [...document.querySelectorAll('.ov.open')].map((o) => o.id),
        display: el ? getComputedStyle(el).display : null, parentDisplay: el && el.parentElement ? getComputedStyle(el.parentElement).display : null });
    }, sel);
    const toRules = async () => {
      step('вкладка «Правила»');
      try { await page.click('#ntSubBtn-rules'); }
      catch (err) { throw new Error(err.message + ' | ' + await diag('#ntSubBtn-rules')); }
      await sleep(250);
    };
    const openEditorImage = async () => { step('открыть редактор с картинкой (скриншоты)');
      await page.evaluate((id) => ntOpenEditor(id), idAfter);
      await page.waitForSelector('#ntEditorOv.open .nt-att img', { timeout: 15000 });
      await sleep(400);
    };
    const openSettings = async () => { step('открыть настройки (скриншоты)'); await page.click('#ntSettingsBtn'); await page.waitForSelector('#ntSettingsOv.open'); await sleep(300); };
    const closeOv = async (ov) => { await page.evaluate((i) => document.getElementById(i).classList.remove('open'), ov); await sleep(250); };

    await toRules();
    await shot('light-rules');
    await openSettings(); await closeOv('ntSettingsOv');

    await page.evaluate(() => toggleDarkMode());
    await sleep(500);
    await shot('dark-rules');
    await openEditorImage(); await shot('dark-editor'); await closeOv('ntEditorOv');
    await openSettings(); await shot('dark-settings'); await closeOv('ntSettingsOv');
    for (const [name, btn] of [['journal', '#ntSubBtn-jobs'], ['ratings', '#ntSubBtn-ratings'], ['parity', '#ntSubBtn-parity']]) {
      step('тёмная тема: ' + name); await page.click(btn); await sleep(900); await shot('dark-' + name);
    }
    await page.evaluate(() => toggleDarkMode());
    await sleep(400);

    // ГОТЧА puppeteer: смена isMobile/hasTouch ПЕРЕЗАГРУЖАЕТ страницу — вкладка «Автоуведомления» после неё закрыта.
    const reopenRulesTab = async () => {
      step('открыть вкладку «Автоуведомления» после перезагрузки страницы');
      await page.waitForSelector('#page-broadcasts.active', { timeout: 30000 });
      await click('#bcTabBtn-rules');
      await rulesIdle();
      await page.waitForFunction(() => typeof _ntDicts !== 'undefined' && !!_ntDicts, { timeout: 30000 });
    };
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await reopenRulesTab();
    // Горизонтальное переполнение: страница скроллится внутри .content (#app — overflow:clip), поэтому меряем
    // и документ, и .content, и открытую модалку; допуск 1px на округление.
    const overflowOf = (modalSel) => page.evaluate((sel) => {
      const c = document.querySelector('.content');
      const m = sel ? document.querySelector(sel) : null;
      return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth,
        c ? c.scrollWidth - c.clientWidth : 0, m ? m.scrollWidth - m.clientWidth : 0);
    }, modalSel);
    const noOverflow = async (what, modalSel) => { const o = await overflowOf(modalSel); if (o > 1) fail(`на телефоне «${what}» шире экрана на ${o}px`); };
    await toRules(); await shot('mobile-rules'); await noOverflow('правила');
    await openEditorImage(); await shot('mobile-editor'); await noOverflow('редактор', '#ntEditorOv .modal'); await closeOv('ntEditorOv');
    await openSettings(); await shot('mobile-settings'); await noOverflow('настройки', '#ntSettingsOv .modal'); await closeOv('ntSettingsOv');
    for (const [name, btn] of [['journal', '#ntSubBtn-jobs'], ['ratings', '#ntSubBtn-ratings'], ['parity', '#ntSubBtn-parity']]) {
      step('телефон: ' + name); await page.click(btn); await sleep(900); await shot('mobile-' + name); await noOverflow(name);
    }
    ok('скриншоты /tmp/notify-ui-{light,dark,mobile}-*.png; на телефоне нет горизонтального переполнения (правила, редактор, настройки, журнал, оценки, сверка)');
    await page.setViewport({ width: 1360, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
    await reopenRulesTab();

    // ── удаление правил через UI (confirm принимается автоматически) ──
    const attachFiles = () => fs.readdirSync(UPLOADS).filter((n) => /^notify_1_\d+_\d+\.(jpg|png|webp)$/.test(n));
    if (!attachFiles().some((n) => n.startsWith(`notify_1_${idAfter}_`))) fail('перед удалением файла вложения нет на диске');
    for (const [id, title] of [[idRemind, T_REMIND], [idAfter, T_AFTER], [idCancel, T_CANCEL]]) {
      await click(ruleRow(id) + ' .btn-sec');                      // «✏️ Изменить»
      await page.waitForSelector('#ntEditorOv.open', { timeout: 15000 });
      await page.click('#ntDeleteBtn');
      await closed('ntEditorOv');
      await page.waitForFunction((t) => !document.getElementById('ntSub-rules').textContent.includes(t), { timeout: 15000 }, title);
      if (await db.oneOrNone(`SELECT id FROM notification_rules WHERE id=$1`, [id])) fail('правило осталось в БД после удаления: ' + title);
    }
    const pa = await db.one(`SELECT status, decision_reason, rule_id FROM notification_jobs WHERE id=$1`, [jPendingAfter]);
    if (pa.status !== 'cancelled' || pa.decision_reason !== 'правило удалено') fail('запланированная отправка удалённого правила: ' + JSON.stringify(pa));
    const hist = await db.one(`SELECT count(*)::int AS n FROM notification_jobs WHERE id = ANY($1)`, [[jSent, jShadow, jFailed]]);
    if (hist.n !== 3) fail('история отправок не пережила удаление правил');
    if (attachFiles().some((n) => ruleIds.some((id) => n.startsWith(`notify_1_${id}_`)))) fail('файлы вложений остались на диске после удаления правил');
    ok('правила удалены через UI: запланированная отправка погашена («правило удалено»), история осталась, файлы вложений убраны');

    // 409 — ожидаемый ответ «Теста» в режиме off (браузер пишет проваленный запрос в консоль); других ошибок быть не должно.
    const conflicts = consoleErrors.filter((m) => /status of 409/.test(m));
    const unexpected = consoleErrors.filter((m) => !/status of 409/.test(m));
    if (unexpected.length) fail('ошибки консоли: ' + JSON.stringify(unexpected));
    if (conflicts.length !== 1) fail('ожидали ровно один 409 (тест в режиме off), получили ' + conflicts.length);
    ok('ошибок в консоли браузера нет (кроме ожидаемого 409 от «Теста» в режиме off)');
    if (liveConfirmSeen) fail('появилось подтверждение боевого режима');
    console.log(`\n  confirm()-диалогов за прогон: ${dialogs.length}`);
    console.log('\n\x1b[32mNOTIFICATIONS UI E2E: OK\x1b[0m');
  } finally {
    await browser.close().catch(() => {});
    // Чистим по заголовку/телефону/фиктивным id, а не по запомненным id: страховка на случай падения посреди сценария.
    const mine = (await db.any(`SELECT id FROM notification_rules WHERE salon_id=1 AND title LIKE $1`, [PREFIX + '%']).catch(() => [])).map((r) => r.id);
    for (const id of new Set([...mine, ...ruleIds])) {
      for (const n of fs.readdirSync(UPLOADS)) if (n.startsWith(`notify_1_${id}_`)) fs.unlinkSync(path.join(UPLOADS, n));
    }
    await db.query(`DELETE FROM visit_ratings WHERE salon_id=1 AND phone=$1 AND yclients_record_id = ANY($2)`, [TEST_PHONE, REC]).catch(() => {});
    await db.query(`DELETE FROM notification_jobs WHERE salon_id=1 AND phone=$1 AND yclients_record_id = ANY($2)`, [TEST_PHONE, REC]).catch(() => {});
    await db.query(`DELETE FROM notification_jobs WHERE salon_id=1 AND rule_title LIKE $1`, [PREFIX + '%']).catch(() => {});
    await db.query(`DELETE FROM notification_rules WHERE salon_id=1 AND title LIKE $1`, [PREFIX + '%']).catch(() => {});
    await db.query(`DELETE FROM sessions WHERE user_agent='notifications-ui-e2e'`).catch(() => {});
    // Настройки — к исходному состоянию, если прогон что-то изменил и упал на полпути.
    const cur = await db.oneOrNone(`SELECT ${SETTINGS_COLS} FROM notification_settings WHERE salon_id = 1`).catch(() => null);
    if (before && cur && JSON.stringify(cur) !== JSON.stringify(before)) {
      await db.query(
        `UPDATE notification_settings SET mode=$1, default_channels=$2::jsonb, prefer_last_channel=$3, quiet_from=$4, quiet_to=$5,
           confirm_reply_text=$6, rating_high_text=$7, rating_mid_text=$8, rating_low_text=$9, rating_escalate_low=$10 WHERE salon_id=1`,
        [before.mode, JSON.stringify(before.default_channels), before.prefer_last_channel, before.quiet_from, before.quiet_to,
          before.confirm_reply_text, before.rating_high_text, before.rating_mid_text, before.rating_low_text, before.rating_escalate_low]).catch(() => {});
      console.log('  \x1b[33m!\x1b[0m настройки салона были изменены прогоном и возвращены к исходным');
    } else if (!before && cur) {
      await db.query(`DELETE FROM notification_settings WHERE salon_id=1`).catch(() => {});
    }
    const mode = await db.oneOrNone(`SELECT mode FROM notification_settings WHERE salon_id=1`).catch(() => null);
    console.log('  режим модуля после прогона: ' + (mode ? mode.mode : 'нет строки (= off)'));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('\x1b[31mFAIL:\x1b[0m', e.message, '\n  последний пройденный/текущий шаг:', lastStep); process.exit(1); });
