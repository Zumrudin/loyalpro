'use strict';
// ============================================================
// Живая проверка вкладки «Экономика → Оплата труда» (схемы и назначения)
// против ЗАПУЩЕННОГО дев-сервера: headless-Chrome, владелец салона, свежий токен.
//
//   node scripts/economics-pay-ui-e2e.js
//
//   1. «+ Схема» «Тест»: линия 1 — 15 %, 2 категории через поиск (чипы);
//      линия 2 — 20 %, «выручка − материалы», ФОТ 1,494, 1 услуга → карточка с двумя подписями.
//   2. Одна категория в двух линиях → уведомление, запрос НЕ уходит.
//   3. «+ Назначить» свободному сотруднику с 2026-10-01 → строка; повтор без дат → пересечение.
//   4. Удаление назначенной схемы → отказ; снять назначение → удалить схему → карточки нет.
//   5. Скриншоты /tmp/eco-pay-{light,dark,390}.png; на 390px линии не шире карточки.
// Пишет в дев-БД ТОЛЬКО схему «Тест» и её назначение и убирает их в finally (и SQL-ом
// на случай падения посреди прогона). Чужие схемы/назначения не трогает.
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const TITLE = 'Тест';
const UA = 'economics-pay-ui-e2e';
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => { throw new Error(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function cleanupDb(salonId) {
  await db.query(`DELETE FROM pay_scheme_assignments WHERE salon_id = $1 AND scheme_id IN (SELECT id FROM pay_schemes WHERE salon_id = $1 AND title = $2)`, [salonId, TITLE]);
  await db.query(`DELETE FROM pay_schemes WHERE salon_id = $1 AND title = $2`, [salonId, TITLE]);
}

async function main() {
  const user = await db.oneOrNone(`SELECT id, salon_id, role FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`);
  if (!user) fail('нет владельца в базе');
  const pre = await db.oneOrNone(`SELECT count(*)::int AS n FROM pay_schemes WHERE salon_id = $1 AND title = $2`, [user.salon_id, TITLE]);
  if (pre.n) fail(`в дев-БД уже есть схема «${TITLE}» — не наша, прогон её не трогает; уберите вручную`);
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role }, config.JWT_SECRET, { expiresIn: '15m' });
  await db.query(`INSERT INTO sessions (user_id, token, ip, user_agent, expires_at) VALUES ($1, $2, '127.0.0.1', $3, NOW() + INTERVAL '15 minutes')`, [user.id, token, UA]);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'], executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
  const errors = [];
  const writes = [];   // не-GET запросы к /pay-schemes и /pay-assignments
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('dialog', d => d.accept());
    page.on('request', r => { if (r.method() !== 'GET' && /\/api\/economics\/pay-(schemes|assignments)/.test(r.url())) writes.push(`${r.method()} ${r.url().replace(/^.*\/api/, '/api')}`); });

    await page.goto(BASE + '/#economics', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#ecoTabBtn-pay', { timeout: 20000 });
    await page.click('#ecoTabBtn-pay');
    await page.waitForFunction(() => document.querySelector('#ecoPay .bc-head') && typeof _eco !== 'undefined' && _eco.payDicts, { timeout: 30000 });

    const notif = () => page.$eval('#notif', e => e.textContent);
    const clearNotif = () => page.evaluate(() => { document.getElementById('notif').textContent = ''; });
    const clickBtn = (sel, text) => page.$$eval(sel, (bs, t) => { const b = bs.find(x => x.textContent.trim() === t); if (!b) throw new Error('нет кнопки ' + t); b.click(); }, text);
    const schemeCard = () => page.$$eval('#ecoPay .eco-scheme', (cs, t) => { const c = cs.find(x => x.querySelector('.eco-strong').textContent === t); return c ? [...c.querySelectorAll('.eco-lines li')].map(li => li.textContent) : null; }, TITLE);
    const clickInCard = (text) => page.$$eval('#ecoPay .eco-scheme', (cs, [t, b]) => [...cs.find(x => x.querySelector('.eco-strong').textContent === t).querySelectorAll('button')].find(x => x.textContent === b).click(), [TITLE, text]);
    const typeInto = async (sel, v) => { await page.click(sel, { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type(sel, v); };
    const lineSel = (i, inner) => `#ecoSchemeForm .eco-line:nth-child(${i + 2}) ${inner}`;
    const pick = async (i, kind, item) => {
      await typeInto(`#ecoPkQ-${i}-${kind}`, item.title.slice(0, 20));
      await page.waitForSelector(`#ecoPk-${i}-${kind} input[onchange*=",${item.id})"]`);
      await page.click(`#ecoPk-${i}-${kind} input[onchange*=",${item.id})"]`);
    };

    // Данные для прогона — из справочников страницы
    const d = await page.evaluate(() => ({ staff: _eco.payDicts.staff, categories: _eco.payDicts.categories, services: _eco.payDicts.services, assignments: _eco.assignments }));
    if (d.categories.length < 2 || !d.services.length) fail('в справочниках меньше 2 категорий или нет услуг');
    const busy = new Set(d.assignments.map(a => String(a.staff_yc_id)));
    const staff = d.staff.find(s => s.is_active !== false && !busy.has(String(s.id)));
    if (!staff) fail('нет активного сотрудника без назначений');
    const [cat1, cat2] = d.categories;
    const svc = d.services[0];

    // ── 1. Создание схемы ──
    await clickBtn('#ecoPay button', '+ Схема');
    await page.waitForSelector('#ecoSchTitle');
    await page.type('#ecoSchTitle', TITLE);
    await typeInto(lineSel(0, '.fg:nth-child(1) input'), '15');
    await pick(0, 'categories', cat1);
    await pick(0, 'categories', cat2);
    const chips = await page.$$eval('#ecoChips-0-categories .eco-chip', e => e.length);
    if (chips !== 2) fail(`чипов категорий ${chips}, ждали 2`);
    await clickBtn('#ecoSchemeForm button', '+ Линия');
    await page.waitForSelector(lineSel(1, 'select'));
    if (await page.$eval('#ecoSchTitle', e => e.value) !== TITLE) fail('название потерялось при перерисовке');
    if (await page.$$eval('#ecoChips-0-categories .eco-chip', e => e.length) !== 2) fail('чипы линии 1 потерялись при перерисовке');
    await typeInto(lineSel(1, '.fg:nth-child(1) input'), '20');
    await page.select(lineSel(1, 'select'), 'net_of_materials');
    await typeInto(lineSel(1, '.fg:nth-child(3) input'), '1,494');
    await pick(1, 'services', svc);
    if (await page.$$eval('#ecoChips-1-services .eco-chip', e => e.length) !== 1) fail('чип услуги не появился');
    await clickBtn('#ecoSchemeForm button', 'Сохранить');
    await page.waitForFunction((t) => [...document.querySelectorAll('#ecoPay .eco-scheme .eco-strong')].some(e => e.textContent === t), { timeout: 15000 }, TITLE);
    const lines = await schemeCard();
    if (!lines || lines.length !== 2) fail('в карточке не две линии: ' + JSON.stringify(lines));
    if (!/^15 % от выручки · 2 категории$/.test(lines[0])) fail('подпись линии 1: ' + lines[0]);
    if (!/^20 % от выручки − материалы · ФОТ ×1,494 · 1 услуга$/.test(lines[1])) fail('подпись линии 2: ' + lines[1]);
    ok(`1. схема «${TITLE}» создана: «${lines[0]}» / «${lines[1]}»`);

    // ── 2. Конфликт: категория в двух линиях ──
    await clickInCard('Изменить');
    await page.waitForSelector(lineSel(1, 'select'));
    await pick(1, 'categories', cat1);
    const before = writes.length;
    await clearNotif();
    await clickBtn('#ecoSchemeForm button', 'Сохранить');
    await sleep(500);
    const conflictMsg = await notif();
    const expected = `Категория «${cat1.title}» стоит в линиях 1 и 2 — оставьте её в одной`;
    if (conflictMsg !== expected) fail(`уведомление: «${conflictMsg}», ждали «${expected}»`);
    if (writes.length !== before) fail('запрос ушёл несмотря на конфликт: ' + writes.slice(before).join(', '));
    ok('2. конфликт категории: «' + conflictMsg + '», запрос не ушёл');

    // ── 5. Скриншоты (форма и схема на экране) ──
    await page.evaluate(() => document.getElementById('ecoSchemeForm').scrollIntoView());
    await page.screenshot({ path: '/tmp/eco-pay-light.png', fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(800);
    await page.screenshot({ path: '/tmp/eco-pay-dark.png', fullPage: true });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });   // без isMobile/hasTouch: их смена перезагружает страницу и стирает форму
    await sleep(800);
    const over = await page.$$eval('#ecoSchemeForm .eco-line', ls => ls.map(l => ({ sw: l.scrollWidth, cw: l.clientWidth })));
    if (!over.length || over.some(o => o.sw > o.cw)) fail('на 390px линия шире карточки: ' + JSON.stringify(over));
    const pageOver = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (pageOver > 0) fail(`на 390px страница шире экрана на ${pageOver}px`);
    const chipsOut = await page.$$eval('#ecoSchemeForm .eco-chip, #ecoSchemeForm .eco-picker-list', es => es.filter(e => { const r = e.getBoundingClientRect(), p = e.closest('.eco-line').getBoundingClientRect(); return r.right > p.right + 0.5; }).length);
    if (chipsOut) fail(`на 390px ${chipsOut} чипов/списков вылезают за карточку`);
    await page.screenshot({ path: '/tmp/eco-pay-390.png', fullPage: true });
    await page.setViewport({ width: 1400, height: 900 });
    ok('5. скриншоты /tmp/eco-pay-light.png, /tmp/eco-pay-dark.png, /tmp/eco-pay-390.png; на 390px линии не шире карточки ' + JSON.stringify(over));
    await clickBtn('#ecoSchemeForm button', 'Отмена');

    // ── 3. Назначение ──
    const schemeId = await page.evaluate((t) => (_eco.schemes.find(s => s.title === t) || {}).id, TITLE);
    const assign = async (from) => {
      await clickBtn('#ecoPay button', '+ Назначить');
      await page.waitForSelector('#ecoAStaff');
      await page.select('#ecoAStaff', String(staff.id));
      await page.select('#ecoAScheme', String(schemeId));
      await page.$eval('#ecoAFrom', (e, v) => { e.value = v; }, from);
      await clearNotif();
      await clickBtn('#ecoAssignForm button', 'Сохранить');
    };
    await assign('2026-10-01');
    await page.waitForFunction((t) => [...document.querySelectorAll('#ecoPay tbody tr')].some(r => r.children[1] && r.children[1].textContent === t), { timeout: 15000 }, TITLE);
    const row = await page.$$eval('#ecoPay tbody tr', (rs, t) => rs.filter(r => r.children[1] && r.children[1].textContent === t).map(r => [...r.children].slice(0, 3).map(c => c.textContent).join(' | ')), TITLE);
    if (row.length !== 1 || !row[0].includes(staff.name) || !row[0].includes('2026-10-01 — …')) fail('строка назначения: ' + JSON.stringify(row));
    ok('3a. назначение: ' + row[0]);
    const nPost = writes.filter(w => w.startsWith('POST /api/economics/pay-assignments')).length;
    await assign('');
    await sleep(500);
    const ovMsg = await notif();
    if (!/^Период пересекается с назначением «Тест» \(2026-10-01 — …\)$/.test(ovMsg)) fail('уведомление о пересечении: ' + ovMsg);
    if (writes.filter(w => w.startsWith('POST /api/economics/pay-assignments')).length !== nPost) fail('повторное назначение ушло на сервер');
    ok('3b. повтор без дат: «' + ovMsg + '», запрос не ушёл');
    await clickBtn('#ecoAssignForm button', 'Отмена');

    // ── 4. Удаление ──
    const nDel = writes.filter(w => w.startsWith('DELETE')).length;
    await clearNotif();
    await clickInCard('Удалить');
    await sleep(500);
    const delMsg = await notif();
    if (!/назначена специалистам/.test(delMsg)) fail('удаление назначенной схемы: ' + delMsg);
    if (writes.filter(w => w.startsWith('DELETE')).length !== nDel) fail('DELETE ушёл для назначенной схемы');
    ok('4a. удаление назначенной схемы: «' + delMsg + '»');
    await page.$$eval('#ecoPay tbody tr', (rs, t) => [...rs.find(r => r.children[1] && r.children[1].textContent === t).querySelectorAll('button')].find(b => b.textContent === 'Удалить').click(), TITLE);
    await page.waitForFunction((t) => ![...document.querySelectorAll('#ecoPay tbody tr')].some(r => r.children[1] && r.children[1].textContent === t), { timeout: 15000 }, TITLE);
    await clickInCard('Удалить');
    await page.waitForFunction((t) => ![...document.querySelectorAll('#ecoPay .eco-scheme .eco-strong')].some(e => e.textContent === t), { timeout: 15000 }, TITLE);
    const left = await page.$$eval('#ecoPay .eco-scheme', e => e.length);
    ok(`4b. назначение снято, схема удалена; карточек схем осталось: ${left}${left ? ' (чужие, не трогали)' : ' — список пуст'}`);
    ok('запросы записи: ' + writes.join(', '));

    if (errors.length) fail('ошибки в консоли браузера:\n' + errors.join('\n'));
    ok('ошибок в консоли браузера нет');
  } finally {
    await browser.close();
    await cleanupDb(user.salon_id).catch(e => console.error('cleanup:', e.message));
    await db.query(`DELETE FROM sessions WHERE user_agent = $1`, [UA]).catch(() => {});
    const n = await db.oneOrNone(`SELECT count(*)::int AS n FROM pay_schemes WHERE salon_id = $1 AND title = $2`, [user.salon_id, TITLE]);
    console.log(`  SQL: схем «${TITLE}» после прогона: ${n.n}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\x1b[31mFAIL\x1b[0m', e.message); process.exit(1); });
