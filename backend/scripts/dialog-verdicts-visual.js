'use strict';
// Isolated browser regression: real markup/CSS/navigation/renderers, synthetic API.
// No sessions, DB, providers, notifications or background workers are used.
// node scripts/dialog-verdicts-visual.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');

async function main() {
  const frontend = path.resolve(__dirname, '../../frontend');
  const index = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const start = index.indexOf('      <!-- ── Переписки в мессенджерах');
  const block = index.slice(start, index.indexOf('      <div class="g32 mb">', start));
  const row = { dialog_key: 'fixture-dialog', channel: 'tdlib', day: '2026-10-03', status: 'booked', name: 'Тестовый контакт', note: 'Тестовый итог', notified: true, booked_crm: true };
  const stat = { dialogs: 1, clientFirst: 1, bookedSameDay: 1, verdicts: { booked: 1 } };
  let run = null, runCalls = 0, delayed = false;
  const app = express(); app.use(express.json());
  app.get('/api/analytics/messengers', (_req, res) => res.json({ totals: stat, byChannel: [{ ...stat, channel: 'tdlib', label: 'Telegram' }] }));
  app.get('/api/analytics/messengers/verdicts/runs', (_req, res) => res.json({ runs: run ? [run] : [] }));
  app.post('/api/analytics/messengers/verdicts/run', (_req, res) => {
    runCalls++; run = { status: 'running', requested: 1, analyzed: 0 }; res.status(202).json({ runId: 1 });
    setTimeout(() => { run = { status: 'done', requested: 1, analyzed: 1, model: 'fixture' }; }, 100);
  });
  app.get('/api/analytics/messengers/verdicts', (_req, res) => {
    const send = () => res.json({ rows: [row], truncated: false });
    if (delayed) setTimeout(send, 350); else send();
  });
  app.get('/api/chat/dialogs/:key/messages', (_req, res) => res.json({ messages: [
    { id: 1, direction: 'incoming', channel: 'tdlib', text: 'Тестовый контекст', msg_type: 'text', msg_ts: Date.parse('2026-10-02T10:00:00Z') / 1000 },
    { id: 2, direction: 'outgoing', channel: 'tdlib', text: 'Тестовое сообщение дня', msg_type: 'text', msg_ts: Date.parse('2026-10-03T10:00:00Z') / 1000 },
  ] }));
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/features.css"></head>
  <body><nav id="mainNav"><a class="tn" data-p="dashboard">Обзор</a></nav><main style="padding:20px;max-width:1400px;margin:auto"><div id="page-dashboard" class="page active">${block}</div></main>
  <script src="/js/core/utils.js"></script><script src="/js/core/nav.js"></script><script src="/js/pages/chat.js"></script><script src="/js/pages/dashboard.js"></script><script src="/js/pages/dashboard-messengers.js"></script><script src="/js/pages/dashboard-verdicts.js"></script>
  <script>var ME={role:'owner'};function loadLs(){};function notify(){};
  async function api(method,url,body){const res=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body&&JSON.stringify(body)});return res.json();}
  animateCount=(el,n)=>{if(el)el.textContent=n};
  dashRange={from:'2026-10-01',to:'2026-10-04'};
  loadDashboard=()=>loadMessengerStats('?from='+dashRange.from+'&to='+dashRange.to,'тестовый период');
  if(!location.hash) history.replaceState(null,'','#dashboard');navTo('dashboard',{keepHash:true});</script></body></html>`));
  app.use(express.static(frontend));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1280, height: 900 });
    const base = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(base + '#dashboard', { waitUntil: 'networkidle0' });
    assert.equal(await page.$$eval('#msgThead th', els => els.length), 14);
    await page.click('#msgTbody .vd-cell'); await page.waitForSelector('#vdList .vd-row');
    const h1 = await page.evaluate(() => location.hash);
    await page.screenshot({ path: '/tmp/dialog-verdicts-list.png', fullPage: true });
    await page.click('#vdList .vd-row'); await page.waitForSelector('#vdMsgs .chat-msg');
    const h2 = await page.evaluate(() => location.hash);
    assert.equal(await page.$$eval('#vdMsgs .vd-dim', els => els.length), 1);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('page-dashboard')).opacity === '1');
    // Freeze the completed entry animation for deterministic screenshot capture.
    await page.evaluate(() => document.getElementById('page-dashboard').classList.remove('page-enter'));
    await page.screenshot({ path: '/tmp/dialog-verdicts-dialog.png', fullPage: true });
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('#vdMsgs .chat-msg');
    assert.equal(await page.evaluate(() => location.hash), h2);
    await page.goBack(); await page.waitForFunction(() => document.getElementById('vdPanel').style.display === 'none');
    assert.equal(await page.evaluate(() => location.hash), h1);
    await page.goBack(); await page.waitForFunction(() => document.getElementById('vdWrap').style.display === 'none');
    assert.equal(await page.evaluate(() => location.hash), '#dashboard');
    console.log('PASS: columns, list, day context, F5, browser Back');
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(base + h2, { waitUntil: 'networkidle0' }); await page.waitForSelector('#vdMsgs .chat-msg');
    assert.equal(await page.$eval('#vdPanel', el => Math.round(el.getBoundingClientRect().width)), 390);
    await page.screenshot({ path: '/tmp/dialog-verdicts-mobile.png' });
    await page.click('#vdPanel .vd-close'); await page.waitForFunction(() => document.getElementById('vdPanel').style.display === 'none');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.click('#vdList .vd-close'); await page.waitForFunction(() => document.getElementById('vdWrap').style.display === 'none');
    console.log('PASS: mobile panel, close controls, no page overflow');
    await page.evaluate(() => setPreset('today'));
    await page.waitForFunction(() => document.querySelectorAll('#msgThead th').length === 14 && dashRange.from === dashRange.to);
    console.log('PASS: period switch');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: '/tmp/dialog-verdicts-dark.png', fullPage: true });
    await page.click('#vdRunBtn');
    await page.waitForFunction(() => document.getElementById('vdRunBtn').disabled);
    await page.waitForFunction(() => document.getElementById('vdRunSt').textContent.includes('fixture'), { timeout: 10000 });
    assert.equal(runCalls, 1);
    console.log('PASS: run button and completion polling');
    delayed = true;
    await page.evaluate(h => { location.hash = h; }, h2);
    await page.waitForFunction(() => document.getElementById('vdList').textContent.includes('Загрузка'));
    await page.evaluate(() => { location.hash = 'dashboard'; });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await page.$eval('#vdPanel', el => el.style.display), 'none');
    assert.equal(await page.$eval('#vdWrap', el => el.style.display), 'none');
    assert.ok(!(await page.evaluate(() => document.body.classList.contains('vd-dialog-open'))));
    console.log('PASS: late list response cannot reopen a closed panel');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
