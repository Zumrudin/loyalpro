'use strict';
// Настройки модуля уведомлений по салону (notification_settings). Строки нет →
// дефолты (режим off). Кэш 30 с: читается на каждом вебхуке и каждом входящем.
const { db } = require('../../db');
const { CASCADE_CHANNELS } = require('./cascade');

const DEFAULTS = Object.freeze({
  mode: 'off',
  default_channels: ['tdlib', 'whatsapp', 'max'],
  prefer_last_channel: true,
  quiet_from: '21:00',
  quiet_to: '09:00',
  confirm_reply_text: '✅ Ваша запись подтверждена.\nБудем ждать вас!',
  rating_high_text: 'Спасибо за отличную оценку нашей работы! 🙏🏻',
  rating_mid_text: 'Спасибо за оценку! Подскажите, пожалуйста, что нам стоит улучшить? Мы обязательно учтём.',
  rating_low_text: 'Благодарим Вас за оценку.\nНе могли бы Вы рассказать, что именно Вас не устроило? Мы постараемся принять меры и, по возможности, исправить данную ситуацию.',
  rating_escalate_low: true,
});
const MODES = ['off', 'shadow', 'live'];
const TTL_MS = 30 * 1000;
const cache = new Map();

async function getSettings(salonId) {
  const hit = cache.get(salonId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const row = await db.oneOrNone('SELECT * FROM notification_settings WHERE salon_id = $1', [salonId]);
  const value = Object.freeze({ ...DEFAULTS, ...(row || {}), salon_id: salonId });
  cache.set(salonId, { at: Date.now(), value });
  return value;
}

function hm(v) {
  if (v == null || v === '') return null;
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(v))) { const e = new Error('bad time'); e.code = 'BAD_TIME'; throw e; }
  return String(v);
}

async function updateSettings(salonId, patch) {
  const p = patch || {};
  const cur = await getSettings(salonId);
  const next = {
    mode: MODES.includes(p.mode) ? p.mode : cur.mode,
    // Порядок каскада: только мессенджеры шлюза, без дублей. Пустой список законен
    // (воркер тогда не шлёт и пишет причину), но не через «не передано».
    default_channels: Array.isArray(p.default_channels)
      ? [...new Set(p.default_channels.map(String))].filter((c) => CASCADE_CHANNELS.includes(c))
      : cur.default_channels,
    prefer_last_channel: typeof p.prefer_last_channel === 'boolean' ? p.prefer_last_channel : cur.prefer_last_channel,
    quiet_from: 'quiet_from' in p ? hm(p.quiet_from) : cur.quiet_from,
    quiet_to: 'quiet_to' in p ? hm(p.quiet_to) : cur.quiet_to,
    confirm_reply_text: typeof p.confirm_reply_text === 'string' ? p.confirm_reply_text.slice(0, 2000) : cur.confirm_reply_text,
    rating_high_text: typeof p.rating_high_text === 'string' ? p.rating_high_text.slice(0, 2000) : cur.rating_high_text,
    rating_mid_text: typeof p.rating_mid_text === 'string' ? p.rating_mid_text.slice(0, 2000) : cur.rating_mid_text,
    rating_low_text: typeof p.rating_low_text === 'string' ? p.rating_low_text.slice(0, 2000) : cur.rating_low_text,
    rating_escalate_low: typeof p.rating_escalate_low === 'boolean' ? p.rating_escalate_low : cur.rating_escalate_low,
  };
  await db.query(
    `INSERT INTO notification_settings (salon_id, mode, default_channels, quiet_from, quiet_to,
        confirm_reply_text, rating_high_text, rating_mid_text, rating_low_text, rating_escalate_low, prefer_last_channel, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET mode=EXCLUDED.mode, default_channels=EXCLUDED.default_channels,
        prefer_last_channel=EXCLUDED.prefer_last_channel,
        quiet_from=EXCLUDED.quiet_from, quiet_to=EXCLUDED.quiet_to, confirm_reply_text=EXCLUDED.confirm_reply_text,
        rating_high_text=EXCLUDED.rating_high_text, rating_mid_text=EXCLUDED.rating_mid_text,
        rating_low_text=EXCLUDED.rating_low_text, rating_escalate_low=EXCLUDED.rating_escalate_low, updated_at=NOW()`,
    [salonId, next.mode, JSON.stringify(next.default_channels), next.quiet_from, next.quiet_to,
     next.confirm_reply_text, next.rating_high_text, next.rating_mid_text, next.rating_low_text, next.rating_escalate_low,
     next.prefer_last_channel]);
  cache.delete(salonId);
  return getSettings(salonId);
}

function invalidate() { cache.clear(); }
module.exports = { getSettings, updateSettings, invalidate, DEFAULTS, MODES };
