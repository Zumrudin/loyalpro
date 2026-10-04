'use strict';
// ============================================================
// Визуальная проверка блока «Переписки в мессенджерах» на дашборде.
// Гоняется против ЗАПУЩЕННОГО дев-сервера, поднимает headless-Chrome,
// кладёт свежий токен в localStorage и открывает «Обзор».
//
//   node scripts/dashboard-messengers-visual.js
//
// Проверяет: блок отрисован на периоде «Месяц» (плитки с числами, в таблице
// каналы + итог, таблица содержит колонки статусов), переключение на «Сегодня» перерисовывает
// без ошибок страницы, тёмная тема не ломает вёрстку, на телефоне (390x844)
// карточки не шире страницы. Скриншоты:
//   /tmp/dashboard-messengers-light.png, -today.png, -dark.png, -mobile.png
// Ничего не пишет в БД, кроме временной строки sessions под токен.
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

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') ORDER BY id LIMIT 1`);
  if (!user) fail('нет ни одного owner/admin в базе');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '10m' });
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'dashboard-messengers-visual', NOW() + INTERVAL '10 minutes')`,
    [user.id, token]);

  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);
    await page.goto(BASE + '/#dashboard', { waitUntil: 'networkidle2' });

    const tilesFilled = () => page.waitForFunction(
      () => ['msgDialogs', 'msgFirst', 'msgBooked'].every(id => /^\d/.test((document.getElementById(id) || {}).textContent || '')),
      { timeout: 20000, polling: 200 });
    // cascadeCards анимирует .sc с opacity 0 — ждём, пока последняя плитка проявится
    // Загрузка дашборда может перезапускать каскад (opacity 0 → 1) уже ПОСЛЕ появления чисел,
    // и счётчики плиток ещё считают до итога — ждём, пока ВСЕ .sc проявятся, и даём паузу.
    const cascaded = async () => {
      await sleep(600);
      await page.waitForFunction(() => {
        const t = [...document.querySelectorAll('#page-dashboard .sc')];
        return t.length && t.every(el => getComputedStyle(el).opacity === '1');
      }, { timeout: 15000, polling: 200 });
      await sleep(1500);
    };
    const shot = async (name) => {
      await page.$eval('.msg-head', el => el.scrollIntoView());
      await page.screenshot({ path: `/tmp/dashboard-messengers-${name}.png`, fullPage: true });
    };

    // ── Месяц (светлая тема) ──
    await page.click('#page-dashboard .pb-btn[data-preset="month"]');
    await tilesFilled();
    await cascaded();
    const month = await page.evaluate(() => ({
      tiles: ['msgDialogs', 'msgFirst', 'msgBooked'].map(id => document.getElementById(id).textContent),
      rows: document.querySelectorAll('#msgTbody tr').length,
      ths: document.querySelectorAll('#msgThead th').length,
      sub: document.getElementById('msgPeriodSub').textContent,
    }));
    if (month.rows < 2) fail(`в таблице ${month.rows} строк — ожидались каналы + итог`);
    if (month.ths !== 14) fail('нет 14 колонок таблицы');
    if (!/за .+·/.test(month.sub)) fail(`подпись периода пуста: «${month.sub}»`);
    ok(`месяц: плитки ${month.tiles.join(' / ')}, строк в таблице ${month.rows}, подпись «${month.sub}»`);
    await shot('light');

    // ── Сегодня: перерисовка без ошибок, допустимы нули ──
    await page.click('#page-dashboard .pb-btn[data-preset="today"]');
    await page.waitForFunction(() => /^(\d|—)/.test(document.getElementById('msgDialogs').textContent), { timeout: 20000, polling: 200 });
    await cascaded();
    const today = await page.evaluate(() => document.getElementById('msgDialogs').textContent);
    ok(`сегодня: диалогов «${today}»`);
    await shot('today');

    // ── Тёмная тема ──
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('lp_dark', '1'); });
    await page.click('#page-dashboard .pb-btn[data-preset="month"]');
    await tilesFilled();
    await cascaded();
    await shot('dark');
    ok('тёмная тема отрисована');

    // ── Телефон 390x844 ──
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.click('#page-dashboard .pb-btn[data-preset="month"]');
    await tilesFilled();
    await cascaded();
    const mob = await page.evaluate(() => {
      const pw = document.getElementById('page-dashboard').getBoundingClientRect().width;
      const cards = [...document.querySelectorAll('.msg-card')].map(c => c.getBoundingClientRect().width);
      const tbl = document.querySelector('.msg-tbl');
      return { pw, cards, tblScroll: tbl ? tbl.scrollWidth : 0, tblClient: tbl ? tbl.clientWidth : 0 };
    });
    if (!mob.cards.length) fail('на телефоне нет карточек .msg-card');
    const wide = mob.cards.filter(w => w > mob.pw + 1);
    if (wide.length) fail(`на телефоне карточки шире страницы (${mob.pw}px): ${wide.join(', ')}`);
    ok(`телефон: страница ${mob.pw}px, карточки ${mob.cards.map(Math.round).join('/')}px, таблица scroll ${mob.tblScroll} / client ${mob.tblClient}`);
    await shot('mobile');

    if (pageErrors.length) fail('ошибки страницы: ' + pageErrors.join(' | '));
    ok('ошибок страницы нет');
    console.log('\nСкриншоты: /tmp/dashboard-messengers-{light,today,dark,mobile}.png');
  } finally {
    await browser.close();
    await db.query(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\x1b[31m✗\x1b[0m ' + e.message); process.exit(1); });
