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
// «🧾 История напоминаний»: сперва заглушка «Отправок пока нет» для только
// что созданного правила, фильтр правил его содержит; затем строка истории
// заводится НАПРЯМУЮ в БД (status=sent, бонусы, телефон) — проверяем рендер
// (статус/бонус), кнопку «Запретить»/«Разрешить снова» и что клик реально
// ставит/снимает флаг в reminder_suppressions (это путь, где живёт escJs()
// в инлайн-обработчике remToggleMute — единственная UI-строка со статусом
// sent, которую прежняя версия скрипта не проверяла вовсе). Ошибок в консоли
// нет. Чистит за собой: тестовая строка очереди, флаг анти-повтора и само
// правило удаляются в конце (и в finally на всякий случай).
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
const TEST_PHONE = '79990001122';

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
  let queueRowId = null;
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

    // пауза между сообщениями: меняем с дефолта 3 на 7 — round-trip ниже
    // проверит, что значение реально доехало до send_interval_min в БД и
    // вернулось в форму при повторном открытии. Соответствие списка колонок
    // и параметров в INSERT/UPDATE ничем не защищено — лишняя/сдвинутая
    // колонка в запросе тихо запишет не то поле, и юнит-тесты этого не увидят.
    await page.$eval('#remInterval', (el) => { el.value = '7'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    ok('пауза между сообщениями изменена на 7 мин');

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
    const dbRule = await db.one(`SELECT conditions, bonus_tiers, bonus_enabled, send_interval_min FROM reminder_rules WHERE id=$1`, [ruleId]);
    if (!dbRule.bonus_enabled) fail('bonus_enabled=false в БД');
    if (!Array.isArray(dbRule.bonus_tiers) || dbRule.bonus_tiers.length !== 2) {
      fail('в БД не 2 ступени: ' + JSON.stringify(dbRule.bonus_tiers));
    }
    if (dbRule.conditions.items.length !== 1 || dbRule.conditions.items[0].type !== 'category') {
      fail('условие в БД не по категории: ' + JSON.stringify(dbRule.conditions));
    }
    if (dbRule.send_interval_min !== 7) fail('send_interval_min в БД не 7: ' + dbRule.send_interval_min);
    ok('в БД: условие по категории + 2 ступени бонусов + пауза 7 мин сохранены корректно');

    // ── открыть заново: условия и ступени должны восстановиться ──
    // Между remCloseRuleModal (снимает только класс .open — DOM никуда не
    // девается) и повторным открытием ничего не перезагружает форму: если бы
    // мы проверяли поля «как есть», проверка прошла бы на СТАРОМ значении,
    // которое туда положил сам сценарий заполнения, а не код восстановления
    // (например, если remOpenRuleModal перестанет звать condSet/remRenderTiers
    // для уже открывавшегося id — DOM молча останется от первого открытия).
    // Сбрасываем в заведомо ДРУГОЕ состояние перед повторным открытием.
    await page.evaluate(() => {
      condSet('rem', { logic: 'and', items: [] });
      document.getElementById('remBonusEnabled').checked = false;
      remRenderTiers();
    });
    await page.$eval('#remInterval', el => { el.value = '1'; });

    await page.evaluate((id) => remOpenRuleModal(id), ruleId);
    await page.waitForSelector('#remRuleOv.open', { timeout: 5000 });
    await sleep(300); // condSet/remRenderTiers асинхронно ждут careEnsureDicts
    const reopenCondCount = await page.$eval('#remCondCount-0', el => el.textContent).catch(() => null);
    if (!/выбрано: 1/.test(reopenCondCount || '')) fail('условие не восстановилось при повторном открытии: ' + reopenCondCount);
    const reopenTierRows = await page.$$eval('#remTiers .nr-cond', els => els.length);
    if (reopenTierRows !== 2) fail('ступени не восстановились: ' + reopenTierRows);
    const reopenBonusChecked = await page.$eval('#remBonusEnabled', el => el.checked);
    if (!reopenBonusChecked) fail('чекбокс бонусов не восстановился');
    const reopenInterval = await page.$eval('#remInterval', el => el.value);
    if (reopenInterval !== '7') fail('пауза между сообщениями не восстановилась: ' + reopenInterval);
    ok('повторное открытие (после явного сброса DOM): условие, 2 ступени бонусов и пауза 7 мин восстановились');
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
    // Основной деливерабл задачи — разбивка на просроченных/будущих строк:
    // без явной проверки текста ассерт выше («Записей за период») зеленеет,
    // даже если overdueCount/lastFutureAt пропадут из ответа и блок отрендерит
    // «Просрочено: undefined» — так и было в первой версии e2e этой правки.
    if (!/Просрочено/.test(bfText)) fail('блок «Просрочено» не отрендерился: ' + bfText.slice(0, 300));
    if (!/встанут в очередь/.test(bfText)) fail('блок «встанут в очередь» не отрендерился: ' + bfText.slice(0, 300));
    const bfThCount = await page.$$eval('#remBfResult .mtbl thead th', els => els.length);
    if (bfThCount !== 5) fail('ожидали 5 колонок в таблице догона (включая «Встанет на»), получили ' + bfThCount);
    const bfThText = await page.$$eval('#remBfResult .mtbl thead th', els => els.map(e => e.textContent).join('|'));
    if (!bfThText.includes('Встанет на')) fail('колонка «Встанет на» не найдена в шапке: ' + bfThText);
    ok('превью догона: разбивка «Просрочено»/«встанут в очередь» и колонка «Встанет на» на месте');
    await page.screenshot({ path: '/tmp/reminders-ui-light-backfill.png' });
    // явная защита сценария: кнопку «Поставить в очередь» не нажимаем
    const runBtnDisabledOk = await page.$eval('#remBfRunBtn', el => typeof el.disabled === 'boolean');
    if (!runBtnDisabledOk) fail('кнопка запуска догона недоступна для проверки состояния');
    ok('кнопка «Поставить в очередь» НЕ нажата (по требованию сценария)');
    await page.click('#remBackfillOv .mc');
    await page.waitForFunction(() =>
      !document.getElementById('remBackfillOv').classList.contains('open'), { timeout: 5000 });

    // ── тестовая отправка: модалка открывается, кнопку НЕ жмём ──
    // «Отправить тест» шлёт РЕАЛЬНОЕ сообщение на указанный номер — в
    // автоматическом прогоне этого делать нельзя (та же причина, что у
    // «Поставить в очередь» выше). Проверяем разметку, предзаполнение номера
    // из localStorage и то, что галочка начисления по умолчанию снята.
    await page.evaluate(() => localStorage.setItem('remTestPhone', '79990001122'));
    await page.evaluate((id) => remOpenTest(id), ruleId);
    await page.waitForSelector('#remTestOv.open', { timeout: 5000 });
    const testPhone = await page.$eval('#remTestPhone', el => el.value);
    if (testPhone !== '79990001122') fail('номер не подставился из localStorage: ' + testPhone);
    const accrueChecked = await page.$eval('#remTestAccrue', el => el.checked);
    if (accrueChecked) fail('галочка реального начисления должна быть снята по умолчанию');
    ok('«🧪 Тест»: модалка открылась, номер подставлен, начисление по умолчанию выключено');
    await page.screenshot({ path: '/tmp/reminders-ui-light-testsend.png' });
    await page.click('#remTestOv .mc');
    await page.waitForFunction(() =>
      !document.getElementById('remTestOv').classList.contains('open'), { timeout: 5000 });
    ok('кнопка «Отправить тест» НЕ нажата (реальное сообщение в автопрогоне недопустимо)');

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

    // ── строка истории напрямую в БД: рендер, статус, бонусы, тумблер анти-повтора ──
    // Пустая история выше не трогает саму разметку таблицы (кнопки, форматирование
    // бонусов, инлайн-обработчик remToggleMute с телефоном внутри JS-строки) —
    // заводим одну реальную строку, чтобы проверить именно её.
    queueRowId = await db.one(
      `INSERT INTO reminder_queue
         (salon_id, rule_id, rule_title, phone, anchor_record_id, anchor_visit_at,
          scheduled_at, status, sent_at, rendered_text, balance_before, bonus_tier, bonus_accrued, source)
       VALUES (1, $1, $2, $3, -987654321, NOW() - interval '10 days',
               NOW() - interval '9 days', 'sent', NOW() - interval '9 days',
               'Тестовый текст напоминания для e2e', 150, 'accrue', 300, 'backfill')
       RETURNING id`,
      [ruleId, RULE_TITLE, TEST_PHONE]).then(r => r.id);

    // фильтр уже стоит на нашем правиле — просто перезагружаем список
    await page.evaluate(() => remLoadHistory());
    await page.waitForFunction(() =>
      document.getElementById('remHistBody').textContent.indexOf('Загрузка') === -1, { timeout: 15000 });
    let rowText = await page.$eval('#remHistBody', el => el.textContent);
    if (!rowText.includes(TEST_PHONE)) fail('тестовая строка истории не отрисовалась: ' + rowText.slice(0, 300));
    if (!/Отправлено/.test(rowText)) fail('статус «Отправлено» не показан: ' + rowText.slice(0, 300));
    if (!rowText.includes('+300')) fail('начисленный бонус +300 не показан: ' + rowText.slice(0, 300));
    ok('строка истории отрисовалась: телефон, статус «Отправлено», бонус +300');

    // «Запретить»: клик по инлайн-обработчику remToggleMute(ruleId, '<телефон через escJs>', true)
    let clicked = await page.evaluate((phone) => {
      const btn = [...document.querySelectorAll('#remHistBody button')]
        // includes, а не строгое равенство: у кнопки есть эмодзи-префикс (🔕/🔔),
        // и точное сравнение ломалось от косметической правки подписи
        .find(b => b.textContent.includes('Запретить') && b.closest('tr').textContent.includes(phone));
      if (!btn) return false;
      btn.click();
      return true;
    }, TEST_PHONE);
    if (!clicked) fail('кнопка «Запретить» не найдена в строке истории');
    await sleep(600); // remToggleMute сама зовёт remLoadHistory() после успешного ответа

    let suppression = await db.oneOrNone(
      `SELECT muted FROM reminder_suppressions WHERE rule_id=$1 AND phone=$2`, [ruleId, TEST_PHONE]);
    if (!suppression || suppression.muted !== true) {
      fail('после «Запретить» флаг muted не выставился в БД: ' + JSON.stringify(suppression));
    }
    ok('«Запретить»: в reminder_suppressions выставлен muted=true');

    rowText = await page.$eval('#remHistBody', el => el.textContent);
    if (!/Разрешить снова/.test(rowText)) {
      fail('после запрета кнопка не сменилась на «Разрешить снова»: ' + rowText.slice(0, 300));
    }
    ok('кнопка сменилась на «Разрешить снова»');

    // «Разрешить снова»: обратный клик должен снять флаг
    clicked = await page.evaluate((phone) => {
      const btn = [...document.querySelectorAll('#remHistBody button')]
        .find(b => b.textContent.includes('Разрешить снова') && b.closest('tr').textContent.includes(phone));
      if (!btn) return false;
      btn.click();
      return true;
    }, TEST_PHONE);
    if (!clicked) fail('кнопка «Разрешить снова» не найдена');
    await sleep(600);

    suppression = await db.oneOrNone(
      `SELECT muted FROM reminder_suppressions WHERE rule_id=$1 AND phone=$2`, [ruleId, TEST_PHONE]);
    if (!suppression || suppression.muted !== false) {
      fail('после «Разрешить снова» флаг muted не снялся: ' + JSON.stringify(suppression));
    }
    ok('«Разрешить снова»: флаг muted снят обратно (muted=false)');

    await page.screenshot({ path: '/tmp/reminders-ui-light-history.png' });

    // уборка тестовой строки истории и флага анти-повтора — дальше правило не должно
    // светить их в истории после своего удаления
    await db.query(`DELETE FROM reminder_queue WHERE id=$1`, [queueRowId]);
    await db.query(`DELETE FROM reminder_suppressions WHERE rule_id=$1 AND phone=$2`, [ruleId, TEST_PHONE]);
    queueRowId = null;
    await page.select('#remHistRule', '');
    await sleep(300);

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
    // Порядок не важен для целостности (reminder_queue.rule_id ON DELETE SET
    // NULL, reminder_suppressions.rule_id ON DELETE CASCADE), но чистим явно
    // и по rule_title/phone, а не полагаемся на каскад — страховка на случай
    // падения теста ДО того, как ruleId вообще определился.
    await db.query(`DELETE FROM reminder_queue WHERE salon_id=1 AND rule_title=$1`, [RULE_TITLE]).catch(() => {});
    await db.query(`DELETE FROM reminder_suppressions
                      WHERE salon_id=1 AND phone=$1
                        AND rule_id IN (SELECT id FROM reminder_rules WHERE salon_id=1 AND title=$2)`,
      [TEST_PHONE, RULE_TITLE]).catch(() => {});
    await db.query(`DELETE FROM reminder_rules WHERE salon_id=1 AND title=$1`, [RULE_TITLE]).catch(() => {});
    await db.query(`DELETE FROM sessions WHERE user_agent='reminders-ui-e2e'`).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\x1b[31mFAIL:\x1b[0m', e.message); process.exit(1); });
