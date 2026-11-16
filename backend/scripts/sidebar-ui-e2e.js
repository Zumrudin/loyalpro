'use strict';
// Isolated actual app shell + journal; all requests intercepted with synthetic data.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../frontend');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
async function main() {
  const original = read('index.html');
  const scripts = ['js/core/nav.js', 'js/core/sidebar.js', 'js/core/sidebar-calendar.js', ...Array.from(original.matchAll(/<script src="(js\/pages\/journal[^"?]*\.js)[^"]*"><\/script>/g), m => m[1])];
  const html = original.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace('<html lang="ru">', '<html lang="ru" data-skin="ivory">').replace('</body>', `<script>const TOKEN='synthetic';let ME={role:'owner'};function notify(){};</script>${scripts.map(f => `<script src="/${f}"></script>`).join('')}<script>document.getElementById('loginScreen').style.display='none';document.getElementById('app').style.display='flex';applyRoleNav('owner');sidebarInit();sideCalendarInit();navTo('journal');</script></body>`);
  const browser = await puppeteer.launch({headless:true, executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome', args:['--no-sandbox','--disable-dev-shm-usage']});
  const errors = [], writes = [], days = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({width:1440,height:1000});
    page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = new URL(req.url());
      if (req.method() !== 'GET') writes.push(url.pathname);
      if (url.origin !== 'https://sidebar.test') return req.abort();
      const send = (body, type='application/json') => req.respond({status:200,contentType:type,body:typeof body === 'string' ? body : JSON.stringify(body)});
      if (url.pathname === '/') return send(html, 'text/html');
      if (/^\/(js|css|fonts|img)\//.test(url.pathname)) {
        const file = path.join(root, url.pathname);
        if (!fs.existsSync(file)) return req.respond({status:404});
        const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'image/png';
        return req.respond({status:200,contentType:type,body:fs.readFileSync(file)});
      }
      if (url.pathname === '/api/journal/day') {
        days.push(url.searchParams.get('date'));
        return send({date:url.searchParams.get('date'),staff:[],records:[],unsent:0,fetchedAt:'2030-04-02T06:00:00Z'});
      }
      if (url.pathname.startsWith('/api/')) return send({days:[],staff:[],records:[]});
      return req.respond({status:204});
    });
    await page.goto('https://sidebar.test/', {waitUntil:'networkidle0'});
    assert.equal(await page.$$eval('#sidebarCalendar [data-date]', els=>els.length),42);
    const initial = days.length;
    await page.click('#sidebarCalendar [data-shift="1"]');
    assert.equal(days.length,initial,'browsing must not load journal');
    const selected = await page.$eval('#sidebarCalendar [data-date]:not(.outside)',el=>el.dataset.date);
    await page.click('#sidebarCalendar [data-date]:not(.outside)');
    await page.waitForFunction(d=>document.getElementById('jrDate').value===d,{},selected);
    assert.equal(days.length,initial+1,'one load per selection');
    assert.equal(await page.$eval('#sidebarCalendar .selected',el=>el.dataset.date),selected);
    await page.click('.jr-today');
    await page.click('#sidebarCalendar [data-shift="1"]');
    await page.click('.jr-today');
    assert.equal(await page.$eval('#sidebarCalendar .selected',el=>el.dataset.date),await page.evaluate(()=>jrToday()));
    await page.screenshot({path:'/tmp/sidebar-expanded.png'});
    // Toggle selector is shared by aria-controls, independent of styling.
    await page.click('#sidebarToggle');
    assert(await page.$eval('#app',el=>el.classList.contains('sidebar-collapsed')));
    assert(await page.$eval('.sidebar-brand-mark',el=>el.getBoundingClientRect().width>0),'clinic logo remains visible');
    await page.click('#sidebarCalendar .side-calendar-trigger');
    assert(await page.$eval('#sidebarCalendar .side-calendar-panel',el=>el.getBoundingClientRect().width>200));
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#sidebarCalendar',el=>el.classList.contains('calendar-open')),false);
    await page.screenshot({path:'/tmp/sidebar-collapsed.png'});
    await page.reload({waitUntil:'networkidle0'});
    assert(await page.$eval('#app',el=>el.classList.contains('sidebar-collapsed')),'collapse survives reload');
    await page.click('#mainNav [data-grp="manage"] > .nav-grp-t');
    const visible = await page.$eval('#mainNav [data-grp="manage"] .tn[data-p="stock"]',el=>{const r=el.getBoundingClientRect();return r.width>0 && r.left>=64 && r.right<innerWidth;});
    assert(visible,'nested menu accessible in rail');
    await page.keyboard.press('Escape');
    await page.setViewport({width:1100,height:480});
    await page.click('#mainNav [data-grp="manage"] > .nav-grp-t');
    assert(await page.$eval('#mainNav [data-grp="manage"] .nav-grp-b',el=>{const r=el.getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight;}),'flyout fits short viewport');
    await page.keyboard.press('Escape');
    await page.evaluate(()=>document.documentElement.removeAttribute('data-skin'));
    assert(await page.$$eval('#mainNav .sidebar-icon',els=>els.every(el=>!el.getClientRects().length)),'classic navigation icons stay hidden');
    await page.evaluate(()=>document.documentElement.dataset.skin='ivory');
    await page.setViewport({width:390,height:844});
    await page.evaluate(()=>openMenu());
    await page.waitForSelector('#mnavDrawer.open');
    assert.equal(await page.$$eval('#mobileSidebarCalendar [data-date]',els=>els.length),42);
    await page.screenshot({path:'/tmp/sidebar-mobile.png'});
    await page.click('#mobileSidebarCalendar [data-date]:not(.outside)');
    assert.equal(await page.$eval('#mnavDrawer',el=>el.classList.contains('open')),false,'selecting date closes mobile drawer');
    await page.evaluate(()=>{ME={role:'specialist'};applyRoleNav('specialist');sidebarInit();sideCalendarInit();});
    assert(await page.$eval('#sidebarCalendar',el=>el.hidden));
    assert(await page.$eval('#mobileSidebarCalendar',el=>el.hidden));
    assert.deepEqual(writes,[]);
    assert.deepEqual(errors,[]);
    console.log('PASS sidebar browser: date selection, today, collapse, reload, group, mobile, role guard; no writes');
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
