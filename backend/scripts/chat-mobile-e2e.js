'use strict';
// ============================================================
// Живая проверка мобильного чата и адресной строки (hash-роутинг).
// Гоняется против ЗАПУЩЕННОГО дев-сервера, поднимает headless-Chrome
// с экраном телефона (390×844), кладёт свежий токен в localStorage.
//
//   node scripts/chat-mobile-e2e.js
//
// Что проверяется на живом DOM (ничего не отправляет и не пишет в чат):
//   1. Список диалогов виден и ЛИСТАЕТСЯ (панель переписки скрыта).
//   2. Тап по диалогу открывает переписку на весь экран, список скрыт,
//      в адресе появляется /#chat/<ключ>.
//   3. Переписка и композер помещаются в экран (ничего не уезжает за сгиб).
//   4. Кнопка «‹ К списку чатов» возвращает к списку.
//   5. «Назад» браузера из переписки тоже возвращает к списку.
//   6. F5 на /#chat/<ключ> оставляет открытым ТОТ ЖЕ диалог.
//   7. F5 на любой странице не выбрасывает на Дашборд.
// Скриншоты — /tmp/chat-mobile-*.png.
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => { throw new Error(m); };

// Видимость считаем по реальному layout: display:none даёт нулевой прямоугольник.
const visible = (page, sel) => page.$eval(sel, el => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}).catch(() => false);

const hash = (page) => page.evaluate(() => location.hash);

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') ORDER BY id LIMIT 1`);
  if (!user) fail('нет ни одного owner/admin в базе');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '15m' });
  // Гейт /api требует живую строку в sessions — без неё все запросы страницы 401.
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'chat-mobile-e2e', NOW() + INTERVAL '15 minutes')`,
    [user.id, token]);

  // Свой Chrome puppeteer сюда не качали — берём системный.
  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(PHONE);
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);

    // ── 1. Список диалогов ────────────────────────────────────
    await page.goto(BASE + '/#chat', { waitUntil: 'networkidle2' });
    await page.waitForSelector('.chat-dialog', { timeout: 20000 });
    if (!await visible(page, '.chat-sidebar')) fail('список диалогов не виден');
    if (await visible(page, '.chat-main')) fail('панель переписки видна одновременно со списком');
    await page.screenshot({ path: '/tmp/chat-mobile-list.png' });

    // Список обязан листаться ВНУТРИ себя, а не уезжать за нижний край экрана.
    const list = await page.$eval('.chat-dialogs', el => ({
      bottom: el.getBoundingClientRect().bottom,
      scrollable: el.scrollHeight > el.clientHeight + 1,
      overflow: getComputedStyle(el).overflowY,
    }));
    if (list.bottom > PHONE.height + 1) fail(`список уезжает за экран (низ ${Math.round(list.bottom)}px)`);
    if (list.overflow !== 'auto' && list.overflow !== 'scroll') fail('у списка нет своего скролла');
    ok(`список диалогов виден и листается (низ ${Math.round(list.bottom)}px, скролл ${list.scrollable ? 'нужен' : 'не нужен'})`);

    // Скролл списка реально двигается (если диалогов больше одного экрана).
    if (list.scrollable) {
      const moved = await page.$eval('.chat-dialogs', el => { el.scrollTop = 400; return el.scrollTop; });
      if (moved <= 0) fail('список не прокручивается');
      await page.$eval('.chat-dialogs', el => { el.scrollTop = 0; });
      ok('прокрутка списка работает');
    }

    // ── 2. Открытие диалога ───────────────────────────────────
    const key = await page.$eval('.chat-dialog', el => el.dataset.key);
    await page.click('.chat-dialog');
    await page.waitForFunction(() => {
      const m = document.querySelector('.chat-main');
      return m && m.getBoundingClientRect().height > 0;
    }, { timeout: 10000 });
    if (await visible(page, '.chat-sidebar')) fail('список не скрылся при открытии переписки');
    if (!await visible(page, '.chat-back')) fail('нет кнопки возврата к списку');
    const h1 = await hash(page);
    if (h1 !== '#chat/' + encodeURIComponent(key)) fail(`в адресе нет открытого диалога: ${h1}`);
    ok(`диалог открыт на весь экран, адрес ${h1}`);

    // ── 3. Всё помещается в экран ─────────────────────────────
    const box = await page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
      const msgs = document.querySelector('.chat-messages');
      return {
        main: r('.chat-main').bottom,
        composer: r('.chat-composer').bottom,
        msgsOverflow: getComputedStyle(msgs).overflowY,
        msgsH: msgs.getBoundingClientRect().height,
      };
    });
    if (box.main > PHONE.height + 1) fail(`переписка уезжает за экран (низ ${Math.round(box.main)}px)`);
    if (box.composer > PHONE.height + 1) fail(`поле ввода за экраном (низ ${Math.round(box.composer)}px)`);
    if (box.msgsOverflow !== 'auto' && box.msgsOverflow !== 'scroll') fail('лента сообщений без своего скролла');
    if (box.msgsH < 120) fail(`лента сообщений схлопнулась (${Math.round(box.msgsH)}px)`);
    ok(`переписка и композер в экране (низ ${Math.round(box.composer)}px, лента ${Math.round(box.msgsH)}px)`);
    // Скриншот — после подгрузки истории, иначе на нём «Загрузка…» вместо переписки.
    // Ждём именно пузыри: спиннер «Загрузка…» — это тоже .empty, и по классу
    // ожидание завершалось бы мгновенно.
    await page.waitForFunction(
      () => !!document.querySelector('#chat-messages .chat-msg')
         || (document.querySelector('#chat-messages .empty') || {}).textContent === 'Нет сообщений',
      { timeout: 15000 });
    await page.screenshot({ path: '/tmp/chat-mobile-dialog.png' });

    // ── 4. Кнопка «‹ К списку чатов» ──────────────────────────
    await page.click('.chat-back');
    await page.waitForFunction(() => {
      const s = document.querySelector('.chat-sidebar');
      return s && s.getBoundingClientRect().height > 0;
    }, { timeout: 5000 });
    if (await visible(page, '.chat-main')) fail('переписка не закрылась по кнопке возврата');
    if (await hash(page) !== '#chat') fail('адрес не вернулся к #chat');
    ok('кнопка «‹ К списку чатов» возвращает к списку');

    // ── 5. «Назад» браузера ───────────────────────────────────
    await page.click('.chat-dialog');
    await page.waitForFunction(() => document.querySelector('.chat-main').getBoundingClientRect().height > 0);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('.chat-sidebar').getBoundingClientRect().height > 0,
      { timeout: 5000 });
    if (await visible(page, '.chat-main')) fail('«Назад» браузера не закрыло переписку');
    ok('«Назад» браузера возвращает к списку');

    // ── 6. F5 внутри диалога ──────────────────────────────────
    await page.click('.chat-dialog');
    await page.waitForFunction(() => document.querySelector('.chat-main').getBoundingClientRect().height > 0);
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.chat-dialog', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('.chat-main').getBoundingClientRect().height > 0,
      { timeout: 10000 });
    if (await hash(page) !== '#chat/' + encodeURIComponent(key)) fail('после F5 адрес диалога потерян');
    const activeKey = await page.$eval('.chat-dialog.active', el => el.dataset.key).catch(() => null);
    if (activeKey !== key) fail(`после F5 открыт другой диалог: ${activeKey}`);
    // Диалог, открытый по адресу, должен быть полноценным, а не заглушкой:
    // hashchange успевает сработать РАНЬШЕ загрузки списка, и композер тогда
    // остаётся без каналов — отправить из такого диалога нечего.
    await page.waitForFunction(() => {
      const s = document.getElementById('chat-chan-select');
      return s && s.options.length > 0;
    }, { timeout: 10000 }).catch(() => fail('после F5 композер без каналов отправки'));
    // Шапка рисуется ПОЗЖЕ композера (ждёт статус агента по сети) — ждём её отдельно.
    await page.waitForFunction(
      () => { const e = document.querySelector('.chat-header-name'); return !!e && e.textContent.trim().length > 0; },
      { timeout: 10000 }).catch(() => fail('после F5 в шапке диалога нет имени собеседника'));
    ok('F5 внутри диалога оставляет открытым тот же диалог (с каналами и шапкой)');

    // ── 7. F5 на произвольной странице ────────────────────────
    for (const p of ['clients', 'chat', 'settings']) {
      const has = await page.$('#page-' + p);
      if (!has) continue;
      await page.evaluate((x) => navTo(x), p);
      await page.waitForFunction((x) => location.hash === '#' + x, {}, p);
      await page.reload({ waitUntil: 'networkidle2' });
      await page.waitForFunction((x) => {
        const el = document.getElementById('page-' + x);
        return el && el.classList.contains('active');
      }, { timeout: 15000 }, p);
      ok(`F5 на «${p}» оставляет на этой же странице`);
    }

    // ── 8. Переход «Забота» → чат (careOpenChat) ──────────────
    // Тот же контракт: страница ставит window._deepLinkArg, пишет хвост в hash
    // и зовёт navTo('chat'). Роутер обязан хвост СОХРАНИТЬ, а не срезать.
    await page.evaluate(() => navTo('clients'));
    await page.waitForFunction(() => location.hash === '#clients');
    await page.evaluate((k) => { window._deepLinkArg = k; location.hash = '#chat/' + k; navTo('chat'); }, key);
    await page.waitForFunction(() => {
      const s = document.getElementById('chat-chan-select');
      return document.querySelector('.chat-main').getBoundingClientRect().height > 0 && s && s.options.length > 0;
    }, { timeout: 15000 });
    if (await hash(page) !== '#chat/' + encodeURIComponent(key)) fail('переход из «Заботы» потерял диалог в адресе');
    ok('переход «Забота» → чат открывает нужный диалог');

    // ── 9. Чужой раздел в адресе не открывается ───────────────
    // Hash теперь переживает выход из аккаунта: оставшийся «#users» не должен
    // открывать специалисту чужой раздел. Проверяем зеркально — страницу
    // специалиста под owner/admin (роль подопытного пользователя тут заведомо не
    // 'specialist', см. выборку выше).
    await page.goto(BASE + '/#staff-dashboard', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !!document.body.dataset.page, { timeout: 15000 });
    const landed = await page.evaluate(() => ({ page: document.body.dataset.page, hash: location.hash }));
    if (landed.page === 'staff-dashboard') fail('открылся раздел, недоступный этой роли');
    if (landed.hash === '#staff-dashboard') fail('в адресе остался недоступный раздел');
    ok(`недоступный раздел в адресе игнорируется (осталось ${landed.hash})`);

    // ── 10. Десктоп не сломан ─────────────────────────────────
    // Мобильные правила живут в @media и не должны протекать на широкий экран:
    // там по-прежнему видны ОБЕ панели, а кнопки возврата нет вовсе.
    const wide = await browser.newPage();
    await wide.setViewport({ width: 1280, height: 900 });
    await wide.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);
    await wide.goto(BASE + '/#chat/' + encodeURIComponent(key), { waitUntil: 'networkidle2' });
    await wide.waitForSelector('.chat-dialog', { timeout: 20000 });
    await wide.waitForFunction(() => document.querySelector('.chat-main').getBoundingClientRect().height > 0);
    if (!await visible(wide, '.chat-sidebar')) fail('десктоп: список диалогов пропал');
    if (!await visible(wide, '.chat-main')) fail('десктоп: панель переписки пропала');
    if (await visible(wide, '.chat-back')) fail('десктоп: кнопка «К списку чатов» не должна быть видна');
    if (!await visible(wide, '.chat-page-head')) fail('десктоп: шапка страницы пропала');
    const wideBox = await wide.$eval('.chat-layout', el => el.getBoundingClientRect().height);
    if (wideBox < 400) fail(`десктоп: чат схлопнулся (${Math.round(wideBox)}px)`);
    await wide.screenshot({ path: '/tmp/chat-desktop.png' });
    ok(`десктоп: обе панели на месте, чат ${Math.round(wideBox)}px`);

    console.log('\n\x1b[32mВСЁ ПРОШЛО\x1b[0m · скриншоты: /tmp/chat-mobile-list.png, /tmp/chat-mobile-dialog.png, /tmp/chat-desktop.png');
  } finally {
    await browser.close();
    await db.query(`DELETE FROM sessions WHERE user_agent = 'chat-mobile-e2e'`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('\x1b[31m' + e.message + '\x1b[0m'); process.exit(1); });
