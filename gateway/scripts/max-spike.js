'use strict';
// Разовая живая проверка веб-протокола MAX через НАШ клиент: QR в файл, сырые
// push-кадры в лог, по флагу — одна отправка. Ничего не пишет в БД (repo/deliveries
// подменены), вебхук печатает в консоль.
//   node scripts/max-spike.js [--to 79250177778] [--text 'spike'] [--file /path/a.jpg]
// Сессия — data/spike-max (удалить после спайка).
const path = require('path');
const fs = require('fs');
const { MaxClient } = require('../lib/max-client');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dataDir = path.join(__dirname, '../data/spike-max');
const config = { ...require('../config'), DATA_DIR: dataDir, PUBLIC_FILES_DIR: path.join(dataDir, 'pub'), PUBLIC_FILES_URL: '/spike' };
const deps = {
  config,
  repo: { setAuth: async (id, st, x) => log('setAuth', st, JSON.stringify(x || {})), rememberContact: async (...a) => log('rememberContact', a.slice(1)), contactUserId: async () => null, phoneByUserId: async () => null },
  deliveries: { STATUS: { ACCEPTED: [1, 'Принято'], SENT: [2, 'Отправлено'], FAILED: [5, 'Невозможно доставить'] }, create: async (r) => { log('delivery create', JSON.stringify(r)); return 1; }, setStatus: async (...a) => log('delivery status', JSON.stringify(a)), setStatusIf: async (...a) => { log('delivery statusIf', JSON.stringify(a)); return true; }, setProviderMessageId: async (...a) => log('delivery pmid', JSON.stringify(a)), failStale: async () => 0 },
  webhook: { sendSafe: async (b) => log('WEBHOOK', JSON.stringify(b)) },
};
const client = new MaxClient({ id: 0, channel: 'max', phone: null }, deps);
(async () => {
  await client.start();
  // Сырые кадры — через транспорт клиента (после connect).
  const attach = () => { const t = client.transport; if (t && !t._spike) { t._spike = true; t.on('raw', (f) => { if (f.cmd === 0 || f.opcode === 128 || f.opcode === 135 || f.opcode === 136) log('RAW', JSON.stringify(f).slice(0, 1500)); }); } };
  const timer = setInterval(async () => {
    attach();
    const st = client.status();
    if (st.qr && !fs.existsSync('/tmp/max-spike-qr.png')) { fs.writeFileSync('/tmp/max-spike-qr.png', Buffer.from(st.qr.split(',')[1], 'base64')); log('QR → /tmp/max-spike-qr.png (показать владельцу: MAX → Профиль → Устройства → Подключить устройство)'); }
    if (st.authState === 'ready' && !timer.sent) {
      timer.sent = true;
      log('READY', JSON.stringify(st), 'ownerId=', client.ownerId, 'chats=', client.chats.size, 'contacts=', client.contacts.size);
      const to = arg('--to');
      if (to) {
        try { log('sendText →', await client.sendText({ text: arg('--text') || 'spike ' + Date.now(), phone: to })); } catch (e) { log('sendText ERR', e.status, e.message); }
        const file = arg('--file');
        if (file) { const tmp = path.join(dataDir, 'tmp-' + path.basename(file)); fs.copyFileSync(file, tmp); try { log('sendFile →', await client.sendFile({ filePath: tmp, fileName: path.basename(file), caption: 'spike file', type: /\.(jpe?g|png|webp)$/i.test(file) ? 'image' : 'document', phone: to })); } catch (e) { log('sendFile ERR', e.status, e.message); } }
      }
    }
    if (st.authState === 'error' || st.authState === 'logged_out') { log('STOP', st.authState, st.error); process.exit(0); }
  }, 2000);
  process.on('SIGINT', async () => { await client.close(); process.exit(0); });
})().catch(e => { log('FATAL', e.message); process.exit(1); });
