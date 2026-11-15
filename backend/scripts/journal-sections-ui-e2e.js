'use strict';
// Offline browser acceptance for the five client sections in the appointment
// window. The page is assembled from the real journal stylesheet and the
// journal classic scripts in index.html order. All API reads are mocked in the
// browser; this script never starts a server, touches a database, or sends a
// patient/external request.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const frontend = path.resolve(__dirname, '../../frontend');
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
const index = read('index.html');
const journalScripts = [...index.matchAll(/<script src="(js\/pages\/journal[^"?]*\.js)(?:\?[^"']+)?"><\/script>/g)]
  .map(match => match[1]);
const journalStyles = ['css/journal.css', 'css/base.css', 'css/features.css', 'css/ivory-brass.css'];

const RECORD = {
  id: 701,
  staffId: 11,
  staffName: 'Специалист Тест',
  clientName: 'Синтетический клиент',
  clientPhone: '+7 900 000-00-01',
  date: '2030-04-02',
  time: '11:00',
  duration: 60,
  attendance: 0,
  paid: false,
  paidFull: false,
  comment: 'Исходный комментарий',
  servicesVersion: 'synthetic-v1',
  services: [{ id: 1001, title: 'Тестовая услуга', quantity: 1, unitPrice: 1500, cost: 1500 }],
  paymentSummary: { due: 1500, paidConfirmed: 0 },
};
const SUMMARY = {
  name: RECORD.clientName,
  phone: '79000000001',
  visits: { success: 4, fail: 1 },
  bonusBalance: 300,
  loyaltyLevel: 'Постоянный клиент',
  totalSpent: 42000,
  lastVisits: [],
  abonements: [],
};
const LOYALTY = {
  cards: [{ kind: 'card', id: 1, title: 'samotsale', number: '0065', network: 'Peri Clinic', active: true, balance: 300, maxDiscountPercent: 0, maxDiscountAmount: 0, points: 0, soldAmount: 42000, paidAmount: 42000, visits: 5, history: [] }],
  abonements: [],
  certificates: [],
};
const VISITS = {
  salonName: 'Тестовый салон',
  entries: [{ kind: 'visit', recordId: RECORD.id, date: RECORD.date, time: RECORD.time, staffName: RECORD.staffName, attendance: 0, services: [{ title: 'Тестовая услуга', cost: 1500, paid: 0, consumables: [] }], purchases: [] }],
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const scripts = journalScripts.map(file => `<script>${read(file)}\n</script>`).join('\n');
const styles = journalStyles.map(file => `<style data-source="${file}">${read(file)}</style>`).join('\n');
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="https://journal-sections.test/">${styles}</head><body data-page="journal">
  <dialog id="jrModal" class="jr-dialog" aria-labelledby="jrModalTitle">
    <div class="jr-dialog-head"><h2 id="jrModalTitle">Запись</h2><button class="btn btn-sec" aria-label="Закрыть карточку" onclick="jrClose()">✕</button></div>
    <div id="jrModalBody"></div><div id="jrModalError" class="jr-error" role="alert"></div><div id="jrCloseAsk" class="jr-close-ask" role="alertdialog" aria-live="assertive" hidden></div>
  </dialog>
  <script>const TOKEN='synthetic-token'; const ME={role:'owner'}; function notify(){};</script>
  ${scripts}
</body></html>`;

function sectionCloseSelector() {
  return '[data-jr-section-back], #jrLyBack, #jrVhBack, .jr-section-close';
}

async function waitForSection(page, title) {
  await page.waitForFunction(expected => {
    const section = journal?.section;
    const detail = section?.content;
    return !!(section && detail?.isConnected && detail.getAttribute('aria-label') === expected);
  }, { timeout: 3000 }, title);
  await page.waitForFunction(() => document.querySelector('.jr-section-track')?.classList.contains('is-section-open') || document.querySelector('.jr-section-track'), { timeout: 1000 });
}

async function closeSection(page) {
  const button = await page.$(sectionCloseSelector());
  if (button) await button.click();
  else await page.evaluate(() => jrClose());
  await page.waitForFunction(() => !journal?.section, { timeout: 1500 });
  await sleep(430);
}

async function assertOpenMotion(page, initialX) {
  await sleep(75);
  const motion = await page.$eval('.jr-section-track', track => {
    const style = getComputedStyle(track);
    const matrix = new DOMMatrix(style.transform);
    const card = track.querySelector('.jr-section-record');
    return { tx: matrix.m41, cardX: card?.getBoundingClientRect().x ?? 0, transition: style.transitionDuration };
  });
  assert(motion.tx < -1 || motion.cardX < initialX - 1, `open transition did not move the record pane: ${JSON.stringify(motion)}`);
  return motion;
}

async function assertCloseMotion(page, openTx, openCardX) {
  await sleep(150);
  const motion = await page.$eval('.jr-section-track', track => {
    const matrix = new DOMMatrix(getComputedStyle(track).transform);
    return { tx: matrix.m41, cardX: track.querySelector('.jr-section-record')?.getBoundingClientRect().x ?? 0, classes: track.parentElement?.className, transition: getComputedStyle(track).transitionDuration };
  });
  assert(motion.tx > openTx + 1 || motion.cardX > openCardX + 1, `close transition did not reverse from ${JSON.stringify({ openTx, openCardX })}: ${JSON.stringify(motion)}`);
}

async function main() {
  assert(journalScripts.length >= 8, 'index.html must expose the complete journal script set in order');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', error => errors.push(error.message));
    const unexpectedRequests = [];
    await page.setRequestInterception(true);
    page.on('request', request => { unexpectedRequests.push(`${request.method()} ${request.url()}`); request.abort(); });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate((record, summary, loyalty, visits) => {
      window.__jrCalls = [];
      window.__delayLoyalty = false;
      window.__resolveLoyalty = null;
      window.__loyaltyError = false;
      if (typeof crypto.randomUUID !== 'function') {
        let sequence = 0;
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => `synthetic-${++sequence}` });
      }
      jrStockBind = () => {};
      jrApi = async request => {
        window.__jrCalls.push(String(request));
        if (String(request).startsWith('records/')) return structuredClone(record);
        if (String(request).startsWith('clients/summary')) return structuredClone(summary);
        if (String(request).startsWith('clients/loyalty')) {
          if (window.__loyaltyError) throw new Error('synthetic loyalty read failure');
          if (window.__delayLoyalty) return new Promise(resolve => { window.__resolveLoyalty = () => resolve(structuredClone(loyalty)); });
          return structuredClone(loyalty);
        }
        if (String(request).startsWith('clients/visits')) return structuredClone(visits);
        if (String(request).startsWith('day-summary')) return { date: '2030-04-02', total: 0 };
        return {};
      };
    }, RECORD, SUMMARY, LOYALTY, VISITS);

    await page.evaluate(() => jrOpen(701));
    await page.waitForSelector('#jrModal[open] #jrCommentEdit', { timeout: 3000 });
    const initial = await page.evaluate(() => ({
      comment: document.getElementById('jrCommentEdit'),
      x: document.getElementById('jrModalBody').getBoundingClientRect().x,
      ids: ['jrTreatmentPlansOpen', 'jrMedicalCardOpen', 'jrVisitsOpen', 'jrLoyaltyOpen', 'jrClientAccountsOpen'].map(id => document.getElementById(id)?.id || null),
    }));
    assert.deepEqual(initial.ids, ['jrTreatmentPlansOpen', 'jrMedicalCardOpen', 'jrVisitsOpen', 'jrLoyaltyOpen', 'jrClientAccountsOpen']);
    const commentHandle = await page.$('#jrCommentEdit');
    assert(commentHandle, 'record comment control is missing');
    const initialSession = await page.evaluate(() => journal.session?.sessionId);
    assert(initialSession, 'record card did not create an edit session');

    const tiles = [
      ['jrTreatmentPlansOpen', 'Планы лечения'],
      ['jrMedicalCardOpen', 'Медкарта'],
      ['jrVisitsOpen', 'История посещений'],
      ['jrLoyaltyOpen', 'Лояльность'],
      ['jrClientAccountsOpen', 'Счета клиента'],
    ];
    for (const [id, title] of tiles) {
      await page.click('#' + id);
      await waitForSection(page, title);
      const open = await assertOpenMotion(page, initial.x);
      assert(await page.$eval('#jrCommentEdit', el => el.isConnected), `${title}: record form disappeared while opening`);
      assert.equal(await page.evaluate(() => journal.session?.sessionId), initialSession, `${title}: session changed while opening`);
      if (id === 'jrLoyaltyOpen') assert.match(await page.$eval('.jr-section-content-body', el => el.textContent), /Кэшбэк|samotsale/);
      if (id === 'jrVisitsOpen') assert.match(await page.$eval('.jr-section-content-body', el => el.textContent), /Тестовая услуга|Визитов/);
      await sleep(350);
      const layout = await page.evaluate(() => {
        const client = document.querySelector('.jr-section-client')?.getBoundingClientRect();
        const content = document.querySelector('.jr-section-content')?.getBoundingClientRect();
        const footer = document.querySelector('.jr-booking-footer')?.getBoundingClientRect();
        return { clientLeft: client?.left, contentLeft: content?.left, clientWidth: client?.width, contentWidth: content?.width, footerHeight: footer?.height };
      });
      assert(layout.clientWidth > 0 && layout.contentWidth > 0 && layout.clientLeft < layout.contentLeft, `${title}: split sidebar/content geometry is invalid: ${JSON.stringify(layout)}`);
      assert(layout.footerHeight > 0, `${title}: record footer disappeared during section transition`);
      if (id === 'jrLoyaltyOpen') await page.screenshot({ path: '/tmp/journal-section-desktop.png', fullPage: true });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      const darkColor = await page.$eval('.jr-section-content', el => getComputedStyle(el).backgroundColor);
      assert(darkColor && darkColor !== 'rgba(0, 0, 0, 0)', `${title}: dark theme section has no background`);
      await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
      const closeButton = await page.$(sectionCloseSelector());
      assert(closeButton, `${title}: section has no visible back/close control`);
      await closeButton.click();
      await assertCloseMotion(page, open.tx, open.cardX);
      await page.waitForFunction(() => !journal.section, { timeout: 1500 });
      await sleep(430);
      assert(await page.$eval('#jrCommentEdit', el => el.isConnected), `${title}: record form was lost after close`);
      assert.equal(await page.$eval('#jrModalTitle', el => el.textContent), 'Карточка записи');
      assert.equal(await page.evaluate(() => journal.session?.sessionId), initialSession, `${title}: session changed after close`);
    }

    // A late response from one tile must not overwrite a newer tile opened in
    // the same split pane. The client sidebar remains interactive while the
    // right-hand request is pending.
    await page.evaluate(() => { window.__delayLoyalty = true; });
    await page.click('#jrLoyaltyOpen');
    await waitForSection(page, 'Лояльность');
    await page.click('#jrVisitsOpen');
    await waitForSection(page, 'История посещений');
    await page.evaluate(() => { window.__resolveLoyalty?.(); window.__resolveLoyalty = null; window.__delayLoyalty = false; });
    await sleep(100);
    assert.equal(await page.$eval('.jr-section-content', el => el.getAttribute('aria-label')), 'История посещений');
    assert.match(await page.$eval('.jr-section-content-body', el => el.textContent), /Тестовая услуга/);
    await page.click('.jr-section-close');
    await page.waitForFunction(() => !journal.section, { timeout: 1500 });
    await sleep(430);

    // Read errors stay inside the new page and the retry uses the same tile.
    await page.evaluate(() => { window.__loyaltyError = true; });
    await page.click('#jrLoyaltyOpen');
    await waitForSection(page, 'Лояльность');
    await page.waitForSelector('#jrLyReload', { timeout: 1500 });
    // Wait for the entering button to stop moving before a coordinate click.
    await sleep(350);
    await page.evaluate(() => { window.__loyaltyError = false; });
    await page.click('#jrLyReload');
    await page.waitForFunction(() => /Кэшбэк|samotsale/.test(document.querySelector('.jr-section-content-body')?.textContent || ''), { timeout: 2000 });
    await page.click('.jr-section-close');
    await page.waitForFunction(() => !journal.section, { timeout: 1500 });
    await sleep(430);

    // A delayed loyalty response must not repopulate the record after the
    // section has been closed.
    await page.evaluate(() => { window.__delayLoyalty = true; });
    await page.click('#jrLoyaltyOpen');
    await waitForSection(page, 'Лояльность');
    const delayedSession = await page.evaluate(() => journal.session?.sessionId);
    await page.evaluate(() => jrClose());
    await page.waitForFunction(() => !journal.section, { timeout: 1500 });
    await page.evaluate(() => { window.__resolveLoyalty?.(); window.__resolveLoyalty = null; window.__delayLoyalty = false; });
    await sleep(80);
    assert(await page.$eval('#jrCommentEdit', el => el.isConnected), 'stale loyalty response replaced the record form');
    assert.equal(await page.evaluate(() => journal.session?.sessionId), delayedSession);
    assert.equal(await page.$('.jr-section-content'), null, 'stale loyalty response reopened a detail page');

    // Opening and closing a section with an edit keeps the exact control and
    // the exact session. Escape backs out once, then invokes the normal guard.
    await page.$eval('#jrCommentEdit', (el) => { el.value = 'Изменено в тесте'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const editedSession = await page.evaluate(() => ({ id: journal.session?.sessionId, comment: document.getElementById('jrCommentEdit') }));
    assert.equal(await page.evaluate(() => journal.session?.edit?.comment), 'Изменено в тесте');
    const editedHandle = await page.$('#jrCommentEdit');
    await page.click('#jrLoyaltyOpen');
    await waitForSection(page, 'Лояльность');
    assert(await page.evaluate(() => journal.session?.edit?.comment === 'Изменено в тесте'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !journal.section, { timeout: 1500 });
    await sleep(430);
    assert(await page.evaluate(() => journal.session?.edit?.comment === 'Изменено в тесте'));
    assert.equal(await page.evaluate(() => journal.session?.sessionId), editedSession.id);
    assert(await page.evaluate(el => el.isConnected, editedHandle), 'Escape lost the original comment DOM node');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('jrCloseAsk').hidden, { timeout: 1500 });
    assert(await page.$eval('#jrModal', el => el.open), 'second Escape closed the card instead of showing unsaved guard');
    assert.match(await page.$eval('#jrCloseAsk', el => el.textContent), /несохранённ/);

    // A narrow reduced-motion window must remain within the viewport.
    await page.evaluate(() => jrClose(true));
    await page.evaluate(() => jrOpen(701));
    await page.waitForSelector('#jrModal[open] #jrCommentEdit', { timeout: 3000 });
    // Width alone keeps the setContent fixture and its in-page API mock alive;
    // the responsive CSS uses the viewport width and does not need touch mode.
    await page.setViewport({ width: 390, height: 844 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.waitForSelector('#jrLoyaltyOpen', { timeout: 3000 });
    await page.click('#jrLoyaltyOpen');
    await waitForSection(page, 'Лояльность');
    const mobile = await page.evaluate(() => {
      const track = document.querySelector('.jr-section-track');
      return { width: document.documentElement.scrollWidth, viewport: innerWidth, duration: getComputedStyle(track).transitionDuration };
    });
    assert(mobile.width <= mobile.viewport + 1, `mobile section overflows horizontally: ${JSON.stringify(mobile)}`);
    assert.equal(mobile.duration, '0s', 'prefers-reduced-motion did not disable section transition');

    const calls = await page.evaluate(() => window.__jrCalls.slice());
    assert(calls.some(call => call.startsWith('clients/loyalty')) && calls.some(call => call.startsWith('clients/visits')));
    assert.deepEqual(unexpectedRequests, [], `unexpected browser requests: ${unexpectedRequests.join('; ')}`);
    assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
    console.log('PASS: five client tiles, desktop open/reverse motion, dark theme, preserved comment/session, stale response guard, Escape close guard, 390px overflow, reduced motion; offline mocked API only.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error('FAIL', error.stack || error.message); process.exitCode = 1; });
