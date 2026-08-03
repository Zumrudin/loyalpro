'use strict';
// ============================================================
// Живая проверка страницы «Забота» (Task 14): headless-Chrome
// против запущенного дев-сервера, по образцу chat-escalation-visual.js.
//
//   node scripts/care-ui-e2e.js
//
// Прогон: логин токеном → создать программу (условие по услуге, два
// касания Т+1 10:30 и Т+120 11:00) → бейджи в списке → тумблер
// выкл/вкл → редактирование названия → вкладка «Клиенты» (фильтр
// applied, без ошибок консоли) → скриншоты light/dark обеих вкладок
// (/tmp/care-ui-*.png) → удаление программы через confirm → список пуст.
// Чистит за собой: программа удаляется в конце (и в finally на всякий).
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => { throw new Error(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROGRAM_TITLE = 'E2E-забота (тест, удалить)';
const PROGRAM_TITLE2 = 'E2E-забота (переименована)';

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') AND salon_id = 1 ORDER BY id LIMIT 1`);
  if (!user) fail('нет owner/admin в салоне 1');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '15m' });
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'care-ui-e2e', NOW() + INTERVAL '15 minutes')`,
    [user.id, token]);

  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  });
  const consoleErrors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900 });
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    // confirm() принимаем автоматически
    page.on('dialog', async d => { await d.accept(); });
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);

    await page.goto(BASE + '/#care', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#page-care.active', { timeout: 20000 });
    ok('страница «Забота» открыта по deep-link, пункт меню виден');

    // ── создать программу ──
    await page.waitForFunction(() =>
      document.getElementById('carePrograms').textContent.indexOf('Загрузка') === -1, { timeout: 15000 });
    await page.click('#careTab-programs .btn-pri');
    await page.waitForSelector('#careEditorOv.open', { timeout: 5000 });
    await page.type('#careTitle', PROGRAM_TITLE);

    // условие по услуге: + Условие → тип уже service (дефолт) → выбрать первую опцию
    await page.evaluate(() => careAddCond());
    await page.waitForSelector('#careCondList-0 .nr-cond-opt input', { timeout: 10000 });
    await page.click('#careCondList-0 .nr-cond-opt input');
    const condCount = await page.$eval('#careCondCount-0', el => el.textContent);
    if (!/выбрано: 1/.test(condCount)) fail('условие не выбралось: ' + condCount);
    ok('условие по услуге выбрано (' + condCount + ')');

    // касание 1 (уже есть по умолчанию): Т+1 10:30
    const setTouch = async (idx, title, days, time, text) => {
      const row = `#careTouches .care-touch:nth-of-type(${idx + 1})`;
      await page.$eval(`${row} input[type=text]`, (el, v) => { el.value = ''; }, null);
      await page.type(`${row} input[type=text]`, title);
      await page.$eval(`${row} input[type=number]`, (el, v) => {
        el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
      }, String(days));
      await page.$eval(`${row} input[type=time]`, (el, v) => {
        el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
      }, time);
      await page.type(`${row} textarea`, text);
    };
    await setTouch(0, 'Контроль Т+1', 1, '10:30', 'Спросить о самочувствии после процедуры.');
    await page.evaluate(() => careAddTouch());
    await setTouch(1, 'Ретеншн Т+120', 120, '11:00', 'Пригласить на повторную процедуру.');
    ok('два касания заполнены (Т+1 10:30, Т+120 11:00)');

    await page.click('#careSaveBtn');
    await page.waitForFunction(() =>
      !document.getElementById('careEditorOv').classList.contains('open'), { timeout: 10000 });
    await page.waitForFunction((t) =>
      document.getElementById('carePrograms').textContent.includes(t), { timeout: 10000 }, PROGRAM_TITLE);
    const badges = await page.$$eval('#carePrograms .care-tbadge', els => els.map(e => e.textContent.trim()));
    if (!(badges.includes('Т+1') && badges.includes('Т+120')))
      fail('нет бейджей Т+1/Т+120: ' + JSON.stringify(badges));
    ok('программа в списке с бейджами ' + badges.join(', '));

    // ── тумблер выкл/вкл ──
    const progId = await page.$eval('#carePrograms .bc-row', el => +el.dataset.id);
    await page.click('#carePrograms .bc-row .tgl .ts');
    await sleep(600);
    let en = await db.one(`SELECT is_enabled FROM care_programs WHERE id=$1`, [progId]);
    if (en.is_enabled !== false) fail('toggle: ожидали false, в БД ' + en.is_enabled);
    await page.click('#carePrograms .bc-row .tgl .ts');
    await sleep(600);
    en = await db.one(`SELECT is_enabled FROM care_programs WHERE id=$1`, [progId]);
    if (en.is_enabled !== true) fail('toggle: ожидали true, в БД ' + en.is_enabled);
    ok('тумблер выключил и включил программу (проверено по БД)');

    // ── редактирование: смена названия ──
    await page.evaluate((id) => careOpenProgramModal(id), progId);
    await page.waitForSelector('#careEditorOv.open', { timeout: 5000 });
    const touchesInModal = await page.$$eval('#careTouches .care-touch', els => els.length);
    if (touchesInModal !== 2) fail('в модалке не 2 касания: ' + touchesInModal);
    await sleep(400);
    await page.screenshot({ path: '/tmp/care-ui-light-modal.png' });
    await page.$eval('#careTitle', el => { el.value = ''; });
    await page.type('#careTitle', PROGRAM_TITLE2);
    await page.click('#careSaveBtn');
    await page.waitForFunction((t) =>
      document.getElementById('carePrograms').textContent.includes(t), { timeout: 10000 }, PROGRAM_TITLE2);
    ok('редактирование: название изменено, список обновился');

    // ── скриншоты: обе вкладки, обе темы ──
    await sleep(800); // дождаться fade-out модалки, иначе призрак на скриншоте
    await page.screenshot({ path: '/tmp/care-ui-light-programs.png' });
    await page.click('#careTabBtn-clients');
    await page.waitForFunction(() =>
      document.getElementById('careEnrBody').textContent.indexOf('Загрузка') === -1, { timeout: 15000 });
    // фильтр статуса дергаем — не должен падать
    await page.select('#careEnrStatus', 'active');
    await sleep(700);
    await page.select('#careEnrStatus', '');
    await sleep(700);
    ok('вкладка «Клиенты»: дашборд загрузился, фильтр статуса отработал');
    await page.screenshot({ path: '/tmp/care-ui-light-clients.png' });

    await page.evaluate(() => toggleDarkMode());
    await sleep(400);
    await page.screenshot({ path: '/tmp/care-ui-dark-clients.png' });
    await page.click('#careTabBtn-programs');
    await sleep(300);
    await page.screenshot({ path: '/tmp/care-ui-dark-programs.png' });
    await page.evaluate(() => toggleDarkMode());
    await sleep(300);
    ok('скриншоты: /tmp/care-ui-{light,dark}-{programs,clients}.png');

    // ── удаление через UI (confirm авто-принят) ──
    await page.evaluate((id) => careDeleteProgram(id), progId);
    await page.waitForFunction((t) =>
      !document.getElementById('carePrograms').textContent.includes(t), { timeout: 10000 }, PROGRAM_TITLE2);
    const left = await db.oneOrNone(`SELECT id FROM care_programs WHERE id=$1`, [progId]);
    if (left) fail('программа осталась в БД после удаления');
    ok('программа удалена через UI, в БД её нет');

    if (consoleErrors.length) fail('ошибки консоли: ' + JSON.stringify(consoleErrors));
    ok('ошибок в консоли браузера нет');
    console.log('\n\x1b[32mCARE UI E2E: OK\x1b[0m');
  } finally {
    await browser.close().catch(() => {});
    await db.query(`DELETE FROM care_programs WHERE salon_id=1 AND title LIKE 'E2E-забота%'`).catch(() => {});
    await db.query(`DELETE FROM sessions WHERE user_agent='care-ui-e2e'`).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\x1b[31mFAIL:\x1b[0m', e.message); process.exit(1); });
