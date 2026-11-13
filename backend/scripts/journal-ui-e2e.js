'use strict';
// ============================================================
// Живая проверка журнала записи (паритет с YClients v1, спека
// docs/superpowers/specs/2026-11-12-journal-parity-v1-design.md §7) против
// ЗАПУЩЕННОГО дев-сервера: headless-Chrome, владелец салона, свежий токен.
//
//   node scripts/journal-ui-e2e.js
//
//   1. День с записями: сетка, значки/цвет/метки видны, скриншоты обеих тем.
//   2. «Неделя»: 7 колонок одного мастера; «День» обратно.
//   3. Календарь месяца: дни с точками загрузки.
//   4. Перетаскивание блока: появляется вопрос «Перенести…»/«Длительность…»
//      (или отказ сетки), диалог ОТКЛОНЯЕТСЯ — ничего не сохраняется.
//   5. Карточка: поля паритета на месте, история грузится, панель клиента есть;
//      закрытие без изменений не спрашивает «Сохранить?».
//   6. Телефон 390px: один мастер, чипы, кнопки «Неделя» нет.
//   7. Печать (emulateMediaType('print')): тулбар скрыт.
// Скриншоты: /tmp/journal-*.png. Ни одного не-GET запроса к /api/journal/.
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const UA = 'journal-ui-e2e';
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const skip = (m) => console.log('  \x1b[33m–\x1b[0m ' + m);
const fail = (m) => { throw new Error(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const user = await db.oneOrNone(`SELECT id, salon_id, role FROM users WHERE role = 'owner' AND NOT COALESCE(must_change_password, false) ORDER BY id LIMIT 1`);
  if (!user) fail('нет владельца в базе');
  // A future day with an unpaid, not-arrived visit: there is something to drag.
  const day = await db.oneOrNone(`SELECT to_char(visit_date,'YYYY-MM-DD') AS d FROM records
    WHERE salon_id = $1 AND visit_date > (now() AT TIME ZONE 'Europe/Moscow')::date AND COALESCE(status,'') <> 'deleted'
      AND COALESCE(raw_payload->>'attendance','0') IN ('0','2') AND COALESCE(raw_payload->>'paid_full','0') = '0'
    ORDER BY visit_date LIMIT 1`, [user.salon_id]);
  const date = day ? day.d : new Date(Date.now() + 3 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role }, config.JWT_SECRET, { expiresIn: '15m' });
  await db.query(`INSERT INTO sessions (user_id, token, ip, user_agent, expires_at) VALUES ($1, $2, '127.0.0.1', $3, NOW() + INTERVAL '15 minutes')`, [user.id, token, UA]);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'], executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
  const errors = [], writes = [], dialogs = [], badGets = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });   // NEVER confirm: nothing is saved
    page.on('response', r => { if (r.status() >= 400 && /\/api\/journal\//.test(r.url())) badGets.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^.*\/api/, '/api')}`); });
    page.on('request', r => { if (r.method() !== 'GET' && /\/api\/journal\//.test(r.url())) writes.push(`${r.method()} ${r.url().replace(/^.*\/api/, '/api')}`); });

    const showDay = async () => {
      await page.evaluate((d) => { jrEl('jrDate').value = d; return loadJournal(); }, date);
      await page.waitForFunction(() => document.querySelector('#jrGrid .jr-calendar, #jrGrid .jr-empty'), { timeout: 30000 });
    };
    await page.goto(BASE + '/#journal', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#jrGrid', { timeout: 20000 });
    // Hash alone leaves the dashboard open on a fresh load: navigate explicitly once the app is up.
    await page.waitForFunction(() => typeof navTo === 'function' && document.querySelector('#mainNav .tn'), { timeout: 20000 });
    await page.evaluate(() => { if (document.body.dataset.page !== 'journal') navTo('journal'); });
    await page.waitForFunction(() => document.getElementById('jrGrid').getClientRects().length > 0, { timeout: 20000 });
    await showDay();

    // 1. Day, both themes.
    const columns = await page.$$eval('#jrGrid .jr-column', e => e.length);
    if (!columns) fail(`на ${date} нет колонок мастеров`);
    ok(`день ${date}: колонок ${columns}, записей ${await page.$$eval('#jrGrid .jr-visit', e => e.length)}, перерывов ${await page.$$eval('#jrGrid .jr-break-band', e => e.length)}`);
    await page.screenshot({ path: '/tmp/journal-day-light.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(300);
    await page.screenshot({ path: '/tmp/journal-day-dark.png', fullPage: true });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    ok('скриншоты /tmp/journal-day-{light,dark}.png');

    // 2. Week.
    await page.click('#jrViewWeek');
    await page.waitForFunction(() => document.querySelectorAll('#jrGrid .jr-week .jr-column').length === 7, { timeout: 30000 });
    await page.screenshot({ path: '/tmp/journal-week.png', fullPage: true });
    ok('неделя: 7 колонок, /tmp/journal-week.png');
    await page.click('#jrViewDay');
    await page.waitForFunction(() => !document.querySelector('#jrGrid .jr-week'), { timeout: 30000 });

    // 3. Month calendar.
    await page.click('#jrMonthBtn');
    await page.waitForFunction(() => document.querySelectorAll('#jrMonth .jr-month-day').length >= 28, { timeout: 30000 });
    const dots = await page.$$eval('#jrMonth .jr-density', e => e.filter(x => x.textContent.length > 0).length);
    await page.screenshot({ path: '/tmp/journal-month.png' });
    ok(`календарь месяца: дней с точками загрузки ${dots}, /tmp/journal-month.png`);
    await page.click('#jrMonth [data-month-close]');

    // 4. Drag with a dismissed confirmation.
    const blocks = await page.$$('#jrGrid .jr-visit.jr-draggable');
    if (!blocks.length) skip(`на ${date} нет перетаскиваемых записей — шаг перетаскивания пропущен`);
    else {
      // Several blocks/offsets: we want to see the confirmation at least once; a grid refusal also counts.
      let asked = null, refused = null;
      for (let bi = 0; bi < Math.min(6, blocks.length) && !asked; bi++) {
        const block = (await page.$$('#jrGrid .jr-visit.jr-draggable'))[bi];
        if (!block) break;
        for (const dy of [180, -180, 400, -400]) {
          await block.evaluate(e => e.scrollIntoView({ block: 'center', inline: 'center' }));
          await sleep(150);
          const box = await block.boundingBox();
          if (!box) continue;
          const x = box.x + box.width / 2, y = box.y + Math.min(12, box.height / 2);
          const before = dialogs.length;
          await page.mouse.move(x, y);
          await page.mouse.down();
          for (let i = 1; i <= 10; i++) await page.mouse.move(x, y + dy * i / 10);
          await page.mouse.up();
          await sleep(400);
          const q = dialogs.slice(before).find(m => /^Перенести запись|^Длительность/.test(m));
          if (q) { asked = q; break; }
          const notif = await page.$eval('#notif', e => e.textContent).catch(() => '');
          if (notif && !refused) refused = notif.trim();
          await showDay();
          break;
        }
      }
      if (writes.length) fail('после отклонённого вопроса ушли запросы: ' + writes.join(', '));
      if (asked) ok(`перетаскивание: вопрос «${asked}» — отклонён`);
      else if (refused) ok(`перетаскивание: вопроса не было, сетка отказала («${refused}»)`);
      else fail('перетаскивание не дало ни вопроса, ни отказа');
      ok('после отклонения ничего не сохранено');
      await showDay();
    }

    // 5. Card.
    const visit = await page.$('#jrGrid .jr-visit');
    if (!visit) skip('записей нет — карточка не проверялась');
    else {
      await visit.click();
      await page.waitForSelector('#jrModal[open] #jrCommentEdit', { timeout: 30000 });
      const present = await page.evaluate(() => ['jrDurationEdit', 'jrBreakEdit', 'jrNoNotify', 'jrRebook', 'jrHistoryOpen', 'jrClientSummaryBox']
        .filter(id => !document.getElementById(id)));
      if (present.length) fail('в карточке нет: ' + present.join(', '));
      if (!(await page.$('#jrModal .jr-colors'))) fail('в карточке нет палитры цвета');
      ok('карточка: длительность, перерыв, цвет, «не уведомлять», «Записать повторно», история, панель клиента');
      await page.click('#jrHistoryOpen');
      await page.waitForFunction(() => { const h = document.getElementById('jrHistory'); return h && !h.hidden && !/Загрузка/.test(h.textContent); }, { timeout: 30000 });
      ok('история: ' + (await page.$eval('#jrHistory', e => e.textContent.trim().slice(0, 80))));
      await page.waitForFunction(() => !/Загрузка/.test(document.getElementById('jrClientSummaryBox')?.textContent || ''), { timeout: 30000 });
      ok('панель клиента: ' + (await page.$eval('#jrClientSummaryBox', e => e.textContent.trim().slice(0, 80))));
      await page.screenshot({ path: '/tmp/journal-card.png' });
      await page.click('#jrModal .jr-dialog-head button');
      await sleep(300);
      if (await page.$eval('#jrModal', m => m.open)) fail('карточка без изменений не закрылась (спросила «Сохранить?»)');
      ok('карточка закрыта без вопроса, /tmp/journal-card.png');
    }

    // 6. Phone 390px.
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await sleep(400);
    await showDay();
    const mobile = await page.evaluate(() => ({
      columns: document.querySelectorAll('#jrGrid .jr-column').length,
      chips: !document.getElementById('jrStaffChips').hidden,
      week: getComputedStyle(document.getElementById('jrViewWeek')).display,
    }));
    if (mobile.columns !== 1) fail('на 390px колонок ' + mobile.columns);
    if (mobile.week !== 'none') fail('на 390px видна кнопка «Неделя»');
    await page.screenshot({ path: '/tmp/journal-mobile.png', fullPage: true });
    ok(`телефон 390px: 1 колонка, чипы мастеров ${mobile.chips ? 'есть' : 'нет (один мастер)'}, /tmp/journal-mobile.png`);

    // 7. Print.
    await page.setViewport({ width: 1400, height: 900 });
    await sleep(400);
    await showDay();
    await page.emulateMediaType('print');
    const toolbar = await page.$eval('.jr-toolbar', e => getComputedStyle(e).display);
    if (toolbar !== 'none') fail('при печати тулбар виден');
    const calH = await page.$eval('.jr-calendar', e => e.getBoundingClientRect().height);
    if (calH < 100) fail('при печати .jr-calendar схлопнулся: высота ' + calH);
    const appClip = await page.evaluate(() => { const a = document.getElementById('app'); return a ? a.scrollHeight - a.clientHeight : 0; });
    if (appClip > 4 && (await page.$eval('#app', e => getComputedStyle(e).overflow)) !== 'visible') fail('при печати #app обрезает содержимое на ' + appClip + 'px');
    ok('печать: высота календаря ' + Math.round(calH) + 'px');
    await page.screenshot({ path: '/tmp/journal-print.png', fullPage: true });
    await page.emulateMediaType(null);
    ok('печать: тулбар скрыт, /tmp/journal-print.png');

    if (writes.length) fail('не-GET запросы к журналу: ' + writes.join(', '));
    ok('не-GET запросов к /api/journal/ не было');
    if (badGets.length) fail('ответы 4xx/5xx журнала: ' + badGets.join('; '));
    ok('4xx/5xx на запросах журнала не было');
    if (errors.length) fail('ошибки в консоли браузера:\n' + errors.join('\n'));
    ok('ошибок в консоли браузера нет');
  } finally {
    await browser.close();
    await db.query(`DELETE FROM sessions WHERE user_agent = $1`, [UA]).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\x1b[31mFAIL\x1b[0m', e.message); process.exit(1); });
