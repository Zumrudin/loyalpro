'use strict';
const crypto = require('crypto');

function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function configured(c) {
  return c?.enabled === true && Number.isSafeInteger(c.salonId) && c.salonId > 0
    && c.salonId <= 2147483647 && Boolean(c.token)
    && /^[A-Za-z0-9_-]{32,256}$/.test(c.webhookSecret || '');
}
function id(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const s = String(value ?? '');
  return /^[1-9]\d{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n ? s : null;
}
function phone(value) {
  let p = String(value || '').replace(/[\s()+-]/g, '');
  if (/^8\d{10}$/.test(p)) p = '7' + p.slice(1);
  return /^[1-9]\d{9,14}$/.test(p) ? p : null;
}
function birthday(value, now = new Date()) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value || '');
  if (!m) return null;
  const [, d, mo, y] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  const iso = `${y}-${mo}-${d}`;
  const today = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  return +y >= 1900 && date.getUTCFullYear() === +y && date.getUTCMonth() === +mo - 1
    && date.getUTCDate() === +d && iso <= today ? iso : null;
}

// Only a contact shared by request_contact is an identity assertion. Reject
// forwarded contacts and mismatched owners even if the original HMAC is valid.
function verifiedPhone(message, userId, token) {
  if (message?.link?.type === 'forward') return null;
  const contacts = (Array.isArray(message?.body?.attachments) ? message.body.attachments : [])
    .filter(a => a?.type === 'contact');
  if (contacts.length !== 1) return null;
  const p = contacts[0].payload;
  if (!p || typeof p.vcf_info !== 'string' || p.vcf_info.length > 8192
    || id(p.max_info?.user_id) !== userId || !token) return null;
  // JSON parsing normally already decoded CRLF. Some clients provide escaped
  // sequences; MAX explicitly requires actual CRLF for signature verification.
  const vcf = p.vcf_info.replace(/\\r\\n/g, '\r\n');
  const digest = crypto.createHmac('sha256', token).update(vcf).digest();
  let supplied;
  if (typeof p.hash !== 'string') return null;
  if (/^[a-fA-F0-9]{64}$/.test(p.hash)) supplied = Buffer.from(p.hash, 'hex');
  else if (/^[A-Za-z0-9+/]{43}=$/.test(p.hash)) supplied = Buffer.from(p.hash, 'base64');
  else return null;
  if (supplied.length !== digest.length || !crypto.timingSafeEqual(supplied, digest)) return null;
  const lines = vcf.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const tels = lines.filter(l => /^TEL(?:;[^:]*)?:/i.test(l));
  return tels.length === 1 ? phone(tels[0].slice(tels[0].indexOf(':') + 1).replace(/^tel:/i, '')) : null;
}

// Store only the fields needed by the registration workflow, never raw MAX
// payloads, contact signatures, profile data, or arbitrary deep-link arguments.
function normalizeUpdate(u, token) {
  if (!u || typeof u !== 'object') return null;
  let user, eventId, text = '', verified = null;
  if (u.update_type === 'bot_started' || u.update_type === 'bot_stopped') {
    user = u.user;
    if (!Number.isSafeInteger(u.timestamp) || u.timestamp < 0) return null;
    eventId = String(u.timestamp);
  } else if (u.update_type === 'message_created') {
    const m = u.message;
    if (m?.recipient?.chat_type !== 'dialog') return null;
    user = m.sender;
    eventId = m.body?.mid;
    text = typeof m.body?.text === 'string' ? m.body.text.trim().slice(0, 512) : '';
    verified = verifiedPhone(m, id(user?.user_id), token);
  } else return null;
  const userId = id(user?.user_id);
  if (!userId || user?.is_bot || typeof eventId !== 'string' || !eventId || eventId.length > 256) return null;
  const key = crypto.createHash('sha256').update(`${u.update_type}:${userId}:${eventId}`).digest('hex');
  return { key, userId, type: u.update_type, text, phone: verified };
}

const keyboard = buttons => [{ type: 'inline_keyboard', payload: { buttons } }];
const menu = () => keyboard([[{ type: 'message', text: '💳 Бонусный баланс' }]]);
const contactButton = () => keyboard([[{ type: 'request_contact', text: '📱 Поделиться номером' }]]);
const response = (text, attachments = menu()) => ({ text, attachments });

module.exports = { sameSecret, configured, id, phone, birthday, verifiedPhone, normalizeUpdate, menu, contactButton, response };
