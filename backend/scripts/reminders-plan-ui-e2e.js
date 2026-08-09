// ============================================================
// Живая проверка блока «План отправок» на вкладке «История напоминаний».
//
//   node scripts/reminders-plan-ui-e2e.js
//
// ЗАЧЕМ отдельно от reminders-ui-e2e.js: тот гоняет ОДНУ строку очереди, а
// блок плана существует ровно ради ситуации «догон положил сотни строк на два
// месяца вперёд» — на одной строке он не отличим от заглушки, и ни порядок
// «ближайшие сверху», ни оценка времени по паузе не проверяются.
//
// Ничего не отправляет: строки ставятся в БУДУЩЕЕ (воркер арендует только
// scheduled_at <= NOW()), правило создаётся ВЫКЛЮЧЕННЫМ. Чистит за собой —
// строки очереди и правило удаляются в finally.
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => { throw new Error(m); };

const RULE_TITLE = 'E2E-план отправок (тест, удалить)';
const INTERVAL_MIN = 3;
// Раскладка повторяет боевую после догона: крупная догоняющая партия в первый
// день и «естественные» хвосты по одному-двум в последующие.
const PLAN = [
  { dayOffset: 1, count: 32, source: 'backfill' },
  { dayOffset: 2, count: 2,  source: 'webhook' },
  { dayOffset: 5, count: 3,  source: 'webhook' },
];

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') AND salon_id = 1 ORDER BY id LIMIT 1`);
  if (!user) fail('нет owner/admin в салоне 1');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '15m' });
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'reminders-plan-ui-e2e', NOW() + INTERVAL '15 minutes')`,
    [user.id, token]);

  let ruleId = null;
  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  });
  const consoleErrors = [];
  try {
    const rule = await db.oneOrNone(
      `INSERT INTO reminder_rules (salon_id, title, is_enabled, conditions, delay_days, send_time,
                                   text_mode, text, attribution_days, bonus_enabled, bonus_tiers,
                                   backfill_max_per_day, send_interval_min, created_by)
       VALUES ($1, $2, FALSE, $3, 60, '11:00', 'strict', 'тест', 30, FALSE, '[]'::jsonb, 30, $4, $5)
       RETURNING id`,
      [user.salon_id, RULE_TITLE, JSON.stringify({ logic: 'and', items: [{ type: 'category', ids: [1] }] }),
        INTERVAL_MIN, user.id]);
    ruleId = rule.id;

    for (const part of PLAN) {
      // 11:00 мск дня N: то же время, что ставит боевой планировщик по send_time.
      await db.query(
        `INSERT INTO reminder_queue (salon_id, rule_id, rule_title, phone, scheduled_at, status, source)
         SELECT $1, $2, $3, '7999000' || LPAD(g::text, 4, '0'),
                ((CURRENT_DATE + $4::int)::timestamp + TIME '11:00') AT TIME ZONE 'Europe/Moscow',
                'scheduled', $5
           FROM generate_series(1, $6) g`,
        [user.salon_id, ruleId, RULE_TITLE, part.dayOffset, part.source, part.count]);
    }
    ok(`очередь засеяна: ${PLAN.map(p => `+${p.dayOffset}д×${p.count}`).join(', ')}`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900 });
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);

    await page.goto(BASE + '/#care', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#page-care.active', { timeout: 20000 });
    await page.click('#careTabBtn-reminders-history');
    await page.waitForFunction(() =>
      document.getElementById('remHistBody').textContent.indexOf('Загрузка') === -1, { timeout: 20000 });

    // Фильтр по нашему правилу — иначе в план подмешаются чужие строки салона.
    // Ждать здесь просто «План отправок» НЕЛЬЗЯ: блок уже отрисован для «всех
    // правил», условие выполнено с первого кадра, и проверка читала бы состояние
    // ДО фильтра (на этой гонке тест и упал в первый раз). Пауза между
    // сообщениями — настройка правила, поэтому оценка времени появляется РОВНО
    // после выбора одного правила: её и ждём.
    await page.select('#remHistRule', String(ruleId));
    await page.waitForFunction(() =>
      document.getElementById('remHistPlan').textContent.includes('последнее около'), { timeout: 15000 });

    const plan = await page.$eval('#remHistPlan', el => el.textContent.replace(/\s+/g, ' ').trim());
    const total = PLAN.reduce((s, p) => s + p.count, 0);
    if (!plan.includes(`${total} сообщений в очереди`)) fail(`в блоке нет общего счётчика: ${plan.slice(0, 200)}`);
    // 32 сообщения по 3 минуты от 11:00 → последнее около 12:33.
    if (!plan.includes('12:33')) fail(`нет оценки времени последней отправки: ${plan.slice(0, 300)}`);
    ok('блок плана: общий счётчик и оценка «последнее около 12:33» на месте');

    const chips = await page.$$eval('#remHistPlan .bc-chip', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    if (chips.length !== PLAN.length) fail(`чипов ${chips.length}, ожидалось ${PLAN.length}: ${chips.join(' | ')}`);
    if (!chips[0].endsWith('32')) fail(`первый чип не ближайший день с 32 строками: ${chips[0]}`);
    ok(`чипы по дням: ${chips.join(' | ')}`);

    // Клик по дню — таблица показывает только его.
    await page.click('#remHistPlan .bc-chip');
    await page.waitForFunction(() =>
      document.querySelectorAll('#remHistBody tr').length === 32, { timeout: 15000 })
      .catch(() => fail('после клика по дню в таблице не 32 строки'));
    // Подсветку ждём, а не читаем сразу: план и журнал грузятся ПАРАЛЛЕЛЬНО
    // (журнал не ждёт плана), и таблица успевает перерисоваться раньше чипов.
    await page.waitForFunction(() =>
      document.querySelectorAll('#remHistPlan .bc-chip.on').length === 1, { timeout: 15000 })
      .catch(() => fail('выбранный день не подсветился в плане'));
    ok('клик по дню фильтрует журнал и подсвечивает чип');

    // Порядок «ближайшие сверху»: первая строка журнала — с самой ранней датой.
    await page.select('#remHistStatus', 'scheduled');
    await page.waitForFunction(() =>
      document.querySelectorAll('#remHistBody tr').length > 32, { timeout: 15000 });
    const firstCell = await page.$eval('#remHistBody tr td', el => el.textContent.trim());
    const soonest = new Date(Date.now() + 24 * 3600 * 1000)
      .toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });
    if (!firstCell.startsWith(soonest)) fail(`сверху не ближайшая отправка (${firstCell}, ждали ${soonest})`);
    ok('фильтр «Запланировано» ставит ближайшие отправки сверху');

    await page.screenshot({ path: '/tmp/reminders-plan.png', fullPage: false });
    ok('скриншот: /tmp/reminders-plan.png');

    if (consoleErrors.length) fail('ошибки в консоли: ' + consoleErrors.join(' | '));
    ok('ошибок в консоли нет');
  } finally {
    await browser.close().catch(() => {});
    if (ruleId) {
      await db.query(`DELETE FROM reminder_queue WHERE rule_id = $1`, [ruleId]).catch(() => {});
      await db.query(`DELETE FROM reminder_rules WHERE id = $1`, [ruleId]).catch(() => {});
    }
    await db.query(`DELETE FROM sessions WHERE user_agent = 'reminders-plan-ui-e2e'`).catch(() => {});
  }
}

main().then(() => { console.log('\n\x1b[32mОК\x1b[0m'); process.exit(0); })
  .catch(e => { console.error('\n\x1b[31mПРОВАЛ:\x1b[0m ' + e.message); process.exit(1); });
