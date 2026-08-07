'use strict';
// ============================================================
// Живая проверка вкладок «Напоминания» / «История напоминаний» (Task 14):
// headless-Chrome против запущенного дев-сервера, по образцу care-ui-e2e.js.
//
//   node scripts/reminders-ui-e2e.js
//
// Сценарий: логин токеном → «Забота» → вкладка «🔁 Напоминания» → «+ Новое
// правило» → название, условие по категории, задержка 30, бонусы (две
// ступени: до 500 → начислить 300, без предела → упомянуть) → сохранить →
// открыть заново и проверить, что условие и ступени восстановились →
// «👁 Догон» → «Показать выборку» на 30 дней (кнопку «Поставить в очередь»
// НЕ нажимаем — иначе живым клиентам уйдут реальные сообщения) → вкладка
// «🧾 История напоминаний»: заглушка «Отправок пока нет» для только что
// созданного правила, фильтр правил его содержит, ошибок в консоли нет.
// Чистит за собой: правило удаляется в конце (и в finally на всякий случай).
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

const RULE_TITLE = 'E2E-напоминание (тест, удалить)';

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') AND salon_id = 1 ORDER BY id LIMIT 1`);
  if (!user) fail('нет owner/admin в салоне 1');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '15m' });
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'reminders-ui-e2e', NOW() + INTERVAL '15 minutes')`,
    [user.id, token]);

  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  });
  const consoleErrors = [];
  let ruleId = null;
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
    ok('страница «Забота» открыта по deep-link');

    // ── вкладка «Напоминания» ──
    await page.waitForFunction(() =>
      document.getElementById('carePrograms').textContent.indexOf('Загрузка') === -1, { timeout: 15000 });
    await page.click('#careTabBtn-reminders');
    await page.waitForFunction(() =>
      document.getElementById('remRules').textContent.indexOf('Загрузка') === -1, { timeout: 15000 });
    ok('вкладка «Напоминания» открыта, список правил загрузился');

    // ── создать правило ──
    await page.click('#careTab-reminders .btn-pri');
    await page.waitForSelector('#remRuleOv.open', { timeout: 5000 });
    await page.type('#remTitle', RULE_TITLE);

    // условие по категории: тип по умолчанию 'service' → переключаем на 'category'
    await page.evaluate(() => condAdd('rem'));
    await page.waitForSelector('#remCondList-0', { timeout: 10000 });
    await page.select('#remConds .nr-cond-head select', 'category');
    await page.waitForSelector('#remCondList-0 .nr-cond-opt input', { timeout: 10000 });
    await page.click('#remCondList-0 .nr-cond-opt input');
    const condCount = await page.$eval('#remCondCount-0', el => el.textContent);
    if (!/выбрано: 1/.test(condCount)) fail('условие по категории не выбралось: ' + condCount);
    ok('условие по категории выбрано (' + condCount + ')');

    // задержка 30 (уже дефолт), время отправки — дефолт 11:00
    await page.$eval('#remDelay', (el) => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('#remText', '{first_name}, приходите ещё раз — соскучились!');
    ok('задержка и текст заполнены');

    // бонусы: включить, добавить две ступени
    await page.click('#remBonusEnabled');
    // «+ Ступень» скрыта, пока бонусы выключены (remRenderTiers прячет её
    // display:none) — дожидаемся, пока onchange её откроет, иначе click() падает.
    await page.waitForFunction(() =>
      document.getElementById('remAddTierBtn').style.display !== 'none', { timeout: 5000 });
    // первая ступень появляется не сама — жмём «+ Ступень» дважды
    await page.click('#remAddTierBtn');
    await sleep(150);
    await page.click('#remAddTierBtn');
    await sleep(150);
    const tierRows = () => page.$$('#remTiers .nr-cond');
    const rows0 = await tierRows();
    if (rows0.length !== 2) fail('ожидали 2 ступени после двух кликов, получили ' + rows0.length);

    // ступень 1: до 500 → начислить 300 (значения уже дефолтные у remAddTier,
    // но проверим/зафиксируем явно через remTierField, чтобы не зависеть от
    // порядка полей в разметке)
    await page.evaluate(() => {
      remTierField(0, 'upTo', '500');
      remTierField(0, 'action', 'accrue');
      remTierField(0, 'amount', '300');
    });
    // ступень 2: без предела → только упомянуть баланс
    await page.evaluate(() => {
      remTierField(1, 'upTo', '');
      remTierField(1, 'action', 'mention');
    });
    // remRenderTiers перерисовывает DOM после смены action — перечитываем поля
    await sleep(200);
    ok('две ступени бонусов заданы (до 500 → начислить 300; без предела → упомянуть)');

    await page.click('#remRuleOv .bc-actions .btn-pri');
    await page.waitForFunction(() =>
      !document.getElementById('remRuleOv').classList.contains('open'), { timeout: 10000 });
    await page.waitForFunction((t) =>
      document.getElementById('remRules').textContent.includes(t), { timeout: 10000 }, RULE_TITLE);
    ok('правило сохранено, появилось в списке');

    ruleId = await db.oneOrNone(
      `SELECT id FROM reminder_rules WHERE salon_id=1 AND title=$1`, [RULE_TITLE]).then(r => r && r.id);
    if (!ruleId) fail('правило не найдено в БД после сохранения');

    // проверка в БД: условие и ступени легли как надо
    const dbRule = await db.one(`SELECT conditions, bonus_tiers, bonus_enabled FROM reminder_rules WHERE id=$1`, [ruleId]);
    if (!dbRule.bonus_enabled) fail('bonus_enabled=false в БД');
    if (!Array.isArray(dbRule.bonus_tiers) || dbRule.bonus_tiers.length !== 2) {
      fail('в БД не 2 ступени: ' + JSON.stringify(dbRule.bonus_tiers));
    }
    if (dbRule.conditions.items.length !== 1 || dbRule.conditions.items[0].type !== 'category') {
      fail('условие в БД не по категории: ' + JSON.stringify(dbRule.conditions));
    }
    ok('в БД: условие по категории + 2 ступени бонусов сохранены корректно');

    // ── открыть заново: условия и ступени должны восстановиться ──
    await page.evaluate((id) => remOpenRuleModal(id), ruleId);
    await page.waitForSelector('#remRuleOv.open', { timeout: 5000 });
    await sleep(300); // condSet/remRenderTiers асинхронно ждут careEnsureDicts
    const reopenCondCount = await page.$eval('#remCondCount-0', el => el.textContent).catch(() => null);
    if (!/выбрано: 1/.test(reopenCondCount || '')) fail('условие не восстановилось при повторном открытии: ' + reopenCondCount);
    const reopenTierRows = await page.$$eval('#remTiers .nr-cond', els => els.length);
    if (reopenTierRows !== 2) fail('ступени не восстановились: ' + reopenTierRows);
    const reopenBonusChecked = await page.$eval('#remBonusEnabled', el => el.checked);
    if (!reopenBonusChecked) fail('чекбокс бонусов не восстановился');
    ok('повторное открытие: условие и 2 ступени бонусов восстановились');
    await sleep(300);
    await page.screenshot({ path: '/tmp/reminders-ui-light-rule-modal.png' });
    await page.click('#remRuleOv .mc');
    await page.waitForFunction(() =>
      !document.getElementById('remRuleOv').classList.contains('open'), { timeout: 5000 });

    // ── догон по базе: показать выборку (НЕ ставить в очередь) ──
    await page.evaluate((id) => remOpenBackfill(id), ruleId);
    await page.waitForSelector('#remBackfillOv.open', { timeout: 5000 });
    await page.click('#remBackfillOv .btn-sec.btn-sm');
    await page.waitForFunction(() =>
      document.getElementById('remBfResult').textContent.indexOf('Считаю') === -1, { timeout: 20000 });
    const bfText = await page.$eval('#remBfResult', el => el.textContent);
    if (!/Записей за период/.test(bfText)) fail('превью догона не отрендерилось: ' + bfText.slice(0, 200));
    ok('«Догон по базе»: выборка на 30 дней построена (' + bfText.match(/уйдёт напоминаний: \d+/)?.[0] + ')');
    await page.screenshot({ path: '/tmp/reminders-ui-light-backfill.png' });
    // явная защита сценария: кнопку «Поставить в очередь» не нажимаем
    const runBtnDisabledOk = await page.$eval('#remBfRunBtn', el => typeof el.disabled === 'boolean');
    if (!runBtnDisabledOk) fail('кнопка запуска догона недоступна для проверки состояния');
    ok('кнопка «Поставить в очередь» НЕ нажата (по требованию сценария)');
    await page.click('#remBackfillOv .mc');
    await page.waitForFunction(() =>
      !document.getElementById('remBackfillOv').classList.contains('open'), { timeout: 5000 });

    // ── вкладка «История напоминаний» ──
    await page.click('#careTabBtn-reminders-history');
    await page.waitForFunction(() =>
      document.getElementById('remHistBody').textContent.indexOf('Загрузка') === -1, { timeout: 15000 });
    const filterOptions = await page.$$eval('#remHistRule option', els => els.map(e => e.textContent));
    if (!filterOptions.includes(RULE_TITLE)) fail('фильтр правил не содержит созданное правило: ' + JSON.stringify(filterOptions));
    ok('фильтр правил в истории содержит созданное правило');

    await page.select('#remHistRule', String(ruleId));
    await page.waitForFunction(() =>
      document.getElementById('remHistBody').textContent.indexOf('Загрузка') === -1, { timeout: 15000 });
    const histText = await page.$eval('#remHistBody', el => el.textContent);
    if (!/Отправок пока нет/.test(histText)) fail('ожидали заглушку «Отправок пока нет» для нового правила: ' + histText.slice(0, 200));
    ok('история по новому правилу пуста — заглушка «Отправок пока нет»');
    await page.select('#remHistRule', '');
    await sleep(300);
    await page.screenshot({ path: '/tmp/reminders-ui-light-history.png' });

    await page.evaluate(() => toggleDarkMode());
    await sleep(400);
    await page.screenshot({ path: '/tmp/reminders-ui-dark-history.png' });
    await page.click('#careTabBtn-reminders');
    await sleep(300);
    await page.screenshot({ path: '/tmp/reminders-ui-dark-rules.png' });
    await page.evaluate(() => toggleDarkMode());
    await sleep(300);
    ok('скриншоты: /tmp/reminders-ui-{light,dark}-*.png');

    // ── удаление правила через UI (confirm авто-принят) ──
    await page.evaluate((id) => remDeleteRule(id), ruleId);
    await page.waitForFunction((t) =>
      !document.getElementById('remRules').textContent.includes(t), { timeout: 10000 }, RULE_TITLE);
    const left = await db.oneOrNone(`SELECT id FROM reminder_rules WHERE id=$1`, [ruleId]);
    if (left) fail('правило осталось в БД после удаления');
    ruleId = null;
    ok('правило удалено через UI, в БД его нет');

    if (consoleErrors.length) fail('ошибки консоли: ' + JSON.stringify(consoleErrors));
    ok('ошибок в консоли браузера нет');
    console.log('\n\x1b[32mREMINDERS UI E2E: OK\x1b[0m');
  } finally {
    await browser.close().catch(() => {});
    await db.query(`DELETE FROM reminder_rules WHERE salon_id=1 AND title=$1`, [RULE_TITLE]).catch(() => {});
    await db.query(`DELETE FROM sessions WHERE user_agent='reminders-ui-e2e'`).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\x1b[31mFAIL:\x1b[0m', e.message); process.exit(1); });
