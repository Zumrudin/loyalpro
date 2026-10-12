'use strict';
// Разовая живая проверка Baileys 6.7.24: QR/код привязки, форма входящих
// (LID → senderPn), эхо своих отправок, статусы, медиа, onWhatsApp.
//   node scripts/whatsapp-spike.js [--pair 79200255591] [--to 79250177778]
// Сессия — в data/spike-wa (удалить после спайка). НИЧЕГО не пишет в БД.
const path = require('path');
const fs = require('fs');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, Browsers, getContentType } = baileys;

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const dir = path.join(__dirname, '../data/spike-wa');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { log('fetchLatestBaileysVersion:', e.message); }
  const sock = makeWASocket({ auth: state, version, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false });
  sock.ev.on('creds.update', saveCreds);
  let pairRequested = false;
  sock.ev.on('connection.update', async (u) => {
    const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
    log('connection.update', JSON.stringify({ connection: u.connection, code, hasQr: !!u.qr }));
    if (u.qr) {
      fs.writeFileSync('/tmp/wa-spike-qr.png', Buffer.from((await qrcode.toDataURL(u.qr)).split(',')[1], 'base64'));
      log('QR → /tmp/wa-spike-qr.png (scp и показать владельцу)');
      const pair = arg('--pair');
      if (pair && !pairRequested && !state.creds.registered) { pairRequested = true; log('pairing code:', await sock.requestPairingCode(pair)); }
    }
    if (u.connection === 'open') {
      log('OPEN user=', JSON.stringify(sock.user));
      const to = arg('--to');
      log('onWhatsApp(self)=', JSON.stringify(await sock.onWhatsApp(sock.user.id.split(':')[0].split('@')[0])));
      log('onWhatsApp(70000000000)=', JSON.stringify(await sock.onWhatsApp('70000000000')));
      if (to) {
        const sent = await sock.sendMessage(`${to}@s.whatsapp.net`, { text: 'spike ' + Date.now() });
        log('sent key=', JSON.stringify(sent.key), 'status=', sent.status);
      }
    }
    if (u.connection === 'close' && code === DisconnectReason.loggedOut) { log('LOGGED OUT'); process.exit(0); }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      const ct = getContentType(m.message || {});
      log('upsert', type, JSON.stringify({ key: m.key, pushName: m.pushName, ts: String(m.messageTimestamp), ct, text: m.message && (m.message.conversation || (m.message.extendedTextMessage || {}).text) }));
      if (type === 'notify' && !m.key.fromMe && /image|document|audio|video/.test(ct || '')) {
        const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reupload: sock.updateMediaMessage });
        log('media bytes=', buf.length, 'mimetype=', m.message[ct].mimetype);
      }
    }
  });
  sock.ev.on('messages.update', (ups) => log('messages.update', JSON.stringify(ups)));
  sock.ev.on('chats.phoneNumberShare', (e) => log('phoneNumberShare', JSON.stringify(e)));
})();
