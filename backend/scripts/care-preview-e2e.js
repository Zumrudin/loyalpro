'use strict';
// ============================================================
// Живая проверка «сухого прогона» программы заботы + режима
// «готовый текст» у касания. Против запущенного дев-сервера:
//
//   node scripts/care-preview-e2e.js
//
// Прогон:
//   A. API черновика   — POST /api/care/preview без programId (условия из тела);
//   B. режим текста     — создать программу с касанием text_mode='strict',
//                         прочитать её обратно (textMode доезжает до фронта);
//   C. API программы    — POST /api/care/preview с programId (условия из БД);
//   D. UI               — модалка «👁 Выборка» рисует статистику и таблицу,
//                         переключатель режима касания работает, консоль чиста;
//                         скриншоты /tmp/care-preview-*.png.
// Ничего не отправляет пациентам (превью — read-only по определению).
// Чистит за собой: тестовая программа удаляется в finally.
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

const TITLE = 'E2E-превью (тест, удалить)';
const TEMPLATE = 'Здравствуйте! Напоминаем, что через неделю самое время повторить процедуру.';

async function main() {
  const user = await db.oneOrNone(
    `SELECT id, salon_id, role FROM users WHERE role IN ('owner','admin') AND salon_id = 1 ORDER BY id LIMIT 1`);
  if (!user) fail('нет owner/admin в салоне 1');
  const token = jwt.sign({ userId: user.id, salonId: user.salon_id, role: user.role },
    config.JWT_SECRET, { expiresIn: '15m' });
  await db.query(
    `INSERT INTO sessions (user_id, token, ip, user_agent, expires_at)
     VALUES ($1, $2, '127.0.0.1', 'care-preview-e2e', NOW() + INTERVAL '15 minutes')`,
    [user.id, token]);

  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) fail(`${method} ${path} → ${r.status}: ${data.error || ''}`);
    return data;
  };

  let programId = null;
  const consoleErrors = [];
  let browser = null;
  try {
    // ── A. превью черновика ─────────────────────────────────────
    const draft = await call('POST', '/api/care/preview', {
      days: 30,
      conditions: { logic: 'and', items: [] },
      touches: [{ title: 'Т+1', delayDays: 1, sendTime: '10:30' },
                { title: 'Т+14', delayDays: 14, sendTime: '12:00' }],
    });
    if (!draft.totals) fail('превью черновика без totals');
    if (draft.totals.records == null) fail('превью не вернуло счётчик записей');
    if (draft.totals.matched < draft.totals.willEnroll) fail('willEnroll не может превышать matched');
    ok(`черновик: записей ${draft.totals.records}, состоялось ${draft.totals.completed}, ` +
       `подошло ${draft.totals.matched}, цепочек ${draft.totals.willEnroll} (${draft.from} → ${draft.to})`);

    const live = (draft.rows || []).find(r => !r.skipReason);
    if (live && !(live.touches || []).length) fail('у живой строки нет расписания касаний');
    if (live) ok(`расписание считается: ${live.touches.map(t => `Т+${t.delayDays}→${(t.scheduledAt || '').slice(0, 16)}`).join(', ')}`);
    const skipped = (draft.rows || []).filter(r => r.skipReason);
    ok(`отсев виден в выдаче: ${skipped.length} строк (${[...new Set(skipped.map(r => r.skipReason))].join(', ') || '—'})`);

    // ── B. режим «готовый текст» доезжает до БД и обратно ───────
    const created = await call('POST', '/api/care/programs', {
      title: TITLE,
      conditions: { logic: 'and', items: [] },
      touches: [
        { title: 'Свободное', delayDays: 1, sendTime: '10:30', intentText: 'Узнать самочувствие', textMode: 'free' },
        { title: 'Шаблон',    delayDays: 7, sendTime: '11:00', intentText: TEMPLATE, textMode: 'strict' },
      ],
    });
    programId = created.id;
    const { programs } = await call('GET', '/api/care/programs');
    const mine = (programs || []).find(p => p.id === programId);
    if (!mine) fail('созданная программа не вернулась в списке');
    const modes = (mine.touches || []).map(t => t.textMode);
    if (modes.join(',') !== 'free,strict') fail(`textMode не сохранился: [${modes}]`);
    ok('режим текста касания сохраняется и читается обратно (free, strict)');

    const row = await db.one(
      `SELECT text_mode, intent_text FROM care_touches WHERE program_id=$1 AND text_mode='strict'`, [programId]);
    if (row.intent_text !== TEMPLATE) fail('готовый текст изменился при сохранении');
    ok('готовый текст лежит в care_touches дословно');

    // ── C. превью сохранённой программы ─────────────────────────
    const saved = await call('POST', '/api/care/preview', { programId, days: 7 });
    if (!saved.totals) fail('превью программы без totals');
    ok(`превью по programId: подошло ${saved.totals.matched}, цепочек ${saved.totals.willEnroll}`);

    // ── D. UI ───────────────────────────────────────────────────
    browser = await puppeteer.launch({
      headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900 });
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    await page.evaluateOnNewDocument(t => localStorage.setItem('lp_tk', t), token);

    await page.goto(BASE + '/#care', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#page-care.active', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('#carePrograms .bc-row').length > 0, { timeout: 20000 });

    // кнопка «Выборка» в карточке нашей программы
    await page.evaluate(id => careOpenPreview(id), programId);
    await page.waitForFunction(
      () => document.getElementById('carePreviewOv').classList.contains('open') &&
            !/Загрузка|Считаю/.test(document.getElementById('carePreviewBody').textContent),
      { timeout: 60000 });
    const stats = await page.$$eval('#carePreviewBody .care-pv-stat b', els => els.map(e => e.textContent));
    if (stats.length !== 4) fail(`ожидались 4 счётчика в превью, получено ${stats.length}`);
    ok(`модалка превью отрисована, счётчики: [${stats.join(', ')}]`);
    await page.screenshot({ path: '/tmp/care-preview-modal.png' });

    await page.evaluate(() => careClosePreview());
    await sleep(400);   // дать оверлею догаснуть, иначе на скриншоте призрак

    // переключатель режима в редакторе касания
    await page.evaluate(id => careOpenProgramModal(id), programId);
    await page.waitForSelector('#careEditorOv.open', { timeout: 10000 });
    await sleep(300);
    const chips = await page.$$eval('#careTouches .care-touch', els => els.map(el => {
      const on = el.querySelector('.bc-chip.on');
      return on ? on.textContent.trim() : '';
    }));
    if (!/сама/.test(chips[0] || '') || !/Готовый/.test(chips[1] || ''))
      fail(`режимы в редакторе отрисованы неверно: ${JSON.stringify(chips)}`);
    ok(`переключатель режима в редакторе: [${chips.join(' | ')}]`);
    await page.screenshot({ path: '/tmp/care-preview-editor.png' });

    // превью прямо из редактора (черновик, без сохранения)
    await page.evaluate(() => careOpenPreview());
    await page.waitForFunction(
      () => document.getElementById('carePreviewOv').classList.contains('open') &&
            !/Загрузка|Считаю/.test(document.getElementById('carePreviewBody').textContent),
      { timeout: 60000 });
    const title = await page.$eval('#carePreviewTitle', e => e.textContent);
    if (!/текущим условиям/.test(title)) fail(`заголовок черновика неверен: ${title}`);
    ok('превью открывается из редактора по текущим (несохранённым) условиям');
    await sleep(300);
    await page.screenshot({ path: '/tmp/care-preview-draft.png' });

    if (consoleErrors.length) fail('ошибки в консоли: ' + consoleErrors.join(' | '));
    ok('консоль браузера чиста');
    console.log('\n\x1b[32mВСЁ ЗЕЛЁНОЕ\x1b[0m — скриншоты: /tmp/care-preview-{modal,editor,draft}.png');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (programId) {
      await db.query(`DELETE FROM care_programs WHERE id=$1`, [programId]).catch(() => {});
    }
    await db.query(`DELETE FROM sessions WHERE user_agent='care-preview-e2e'`).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('\x1b[31m✗ ' + e.message + '\x1b[0m'); process.exit(1); });
