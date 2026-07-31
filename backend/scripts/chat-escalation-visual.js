'use strict';
// ============================================================
// Визуальная проверка красной подсветки эскалированных диалогов.
// Гоняется против ЗАПУЩЕННОГО дев-сервера, поднимает headless-Chrome,
// кладёт свежий токен в localStorage и открывает страницу «Чат».
//
//   node scripts/chat-escalation-visual.js
//
// Проверяет на живом DOM: до эскалации диалог обычный → после перевода
// на оператора у карточки класс chat-dialog-escalated и она ПЕРВАЯ в
// списке (порядок прилетает по SSE, без перезагрузки) → после возврата
// боту класс снят. Скриншоты кладёт в /tmp/chat-escalation-*.png.
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const config = require('../config');
const { db } = require('../db');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3001';
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = (m) => { throw new Error(m); };

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') ORDER BY id LIMIT 1`);
  if (!user) fail('нет ни одного owner/admin в базе');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '10m' });
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'chat-escalation-visual', NOW() + INTERVAL '10 minutes')`,
    [user.id, token]);

  const api = async (method, path, body) => {
    const r = await fetch(BASE + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) fail(`${method} ${path} → ${r.status} ${await r.text()}`);
    return r.json();
  };

  // Свой Chrome puppeteer сюда не качали — берём системный.
  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  });
  let key, before;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token);
    await page.goto(BASE + '/#chat', { waitUntil: 'networkidle2' });
    await page.waitForSelector('.chat-dialog', { timeout: 20000 });

    // Берём диалог ПОГЛУБЖЕ в списке: всплытие с позиции 2 на 1 — слабое
    // доказательство закрепления, с десятой на первую — уже наглядное.
    const cards = await page.$$eval('.chat-dialog', els => els.map(e => e.dataset.key));
    key = cards.slice(9).find(k => k && !k.startsWith('g:'))
       || cards.slice(1).find(k => k && !k.startsWith('g:'))
       || cards[cards.length - 1];
    if (!key) fail('не нашёл подходящий диалог');
    const idx0 = cards.indexOf(key);
    ok(`подопытный диалог ${key} — позиция ${idx0 + 1} из ${cards.length}`);

    const escalatedNow = () => page.$$eval('.chat-dialog',
      els => els.filter(e => e.classList.contains('chat-dialog-escalated')).map(e => e.dataset.key));
    if ((await escalatedNow()).includes(key)) fail('диалог уже подсвечен до начала проверки');
    before = (await api('GET', `/api/chat/dialogs/${encodeURIComponent(key)}/agent`)).status;

    await page.screenshot({ path: '/tmp/chat-escalation-before.png' });

    // ── Эскалация: подсветка и всплытие наверх должны прийти по SSE ──
    await api('POST', `/api/chat/dialogs/${encodeURIComponent(key)}/agent`, { status: 'escalated' });
    await page.waitForFunction((k) => {
      const el = document.querySelector('.chat-dialog');
      return el && el.dataset.key === k && el.classList.contains('chat-dialog-escalated');
    }, { timeout: 15000, polling: 200 }, key);
    ok('после эскалации диалог ПЕРВЫЙ в списке и помечен chat-dialog-escalated (без перезагрузки)');

    const badge = await page.$eval('.chat-dialog:first-child .chat-badge-esc', e => e.textContent.trim())
      .catch(() => null);
    if (!badge) fail('нет бейджа .chat-badge-esc на карточке');
    ok(`бейдж на карточке: «${badge}»`);

    const color = await page.$eval('.chat-dialog:first-child',
      e => getComputedStyle(e).borderLeftColor);
    if (!/^rgb\(220,\s*38,\s*38\)$/.test(color)) fail(`левая полоса не красная: ${color}`);
    ok(`красная полоса слева: ${color}`);
    await page.screenshot({ path: '/tmp/chat-escalation-red.png' });

    // Тёмная тема: заливка полупрозрачная, надо убедиться что она читается и там.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: '/tmp/chat-escalation-red-dark.png' });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    ok('снят скриншот тёмной темы');

    // ── Возврат боту: подсветка снимается, диалог уходит на своё место ──
    await api('POST', `/api/chat/dialogs/${encodeURIComponent(key)}/agent`, { status: 'bot' });
    await page.waitForFunction((k) => {
      const el = document.querySelector(`.chat-dialog[data-key="${CSS.escape(k)}"]`);
      return el && !el.classList.contains('chat-dialog-escalated');
    }, { timeout: 15000, polling: 200 }, key);
    const idx1 = (await page.$$eval('.chat-dialog', els => els.map(e => e.dataset.key))).indexOf(key);
    if (idx1 === 0 && idx0 !== 0) fail('после возврата боту диалог остался закреплён сверху');
    ok(`после возврата боту подсветка снята, диалог вернулся на позицию ${idx1 + 1}`);
    await page.screenshot({ path: '/tmp/chat-escalation-after.png' });
  } finally {
    await browser.close().catch(() => {});
    if (key && before && before !== 'bot') {
      await api('POST', `/api/chat/dialogs/${encodeURIComponent(key)}/agent`, { status: before }).catch(() => {});
    }
    await db.query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
  }
  console.log('  скриншоты: /tmp/chat-escalation-{before,red,after}.png');
}

main()
  .then(() => { console.log('\nВСЁ ЗЕЛЁНОЕ'); process.exit(0); })
  .catch(e => { console.error('\n\x1b[31mПРОВАЛ:\x1b[0m ' + e.message); process.exit(1); });
