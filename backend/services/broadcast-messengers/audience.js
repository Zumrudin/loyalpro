'use strict';
// Аудитория разовой рассылки через мессенджеры клиники (спека 2026-11-01 §3–§4): по фильтрам клиентов
// салона ИЛИ по списку «имя+телефон», с каскадом мессенджеров на КАЖДОГО получателя.
// Фильтры повторяют семантику services/broadcast.js (бот-путь заморожен, там связка идёт через подписчиков
// бота, здесь — через мессенджеры клиники, поэтому свой SQL и своя чистая matchesFilters). Каскад, адресаты
// и канонизация номера — общие с модулем уведомлений (cascade.js), второй копии правил нет.
const { db } = require('../../db');
const notifSettings = require('../notifications/settings');
const { lastConversation } = require('../notifications/rules');
const { buildCascade, recipientFor, canonPhone } = require('../notifications/cascade');

// lastConversation — 2 запроса на номер; 5 000 номеров подряд — минуты, поэтому пачками параллельно.
const CONV_BATCH = 8;

const digits = (raw) => String(raw == null ? '' : raw).replace(/\D+/g, '');

const CLIENT_COLS = `c.id AS client_id, c.name AS name, c.phone AS phone, c.bonus_balance AS bonus_balance,
           c.birthday AS birthday, c.gender AS gender, c.is_blacklisted AS is_blacklisted,
           c.last_visit_at AS last_visit_at,
           EXTRACT(EPOCH FROM (NOW() - c.last_visit_at))/86400 AS days_since_visit`;

/** Чистый фильтр одного клиента: segments, bonusMin/Max, lastVisitDays{gte,lte}, birthMonth, gender, phone-фрагмент. */
function matchesFilters(c, filters) {
  const f = filters || {};
  const segKeys = Array.isArray(f.segments) ? f.segments.filter(Boolean) : [];
  if (segKeys.length && (!c.segment_key || !segKeys.includes(c.segment_key))) return false;

  const bonus = Number(c.bonus_balance || 0);
  if (f.bonusMin != null && bonus < Number(f.bonusMin)) return false;
  if (f.bonusMax != null && bonus > Number(f.bonusMax)) return false;

  if (f.lastVisitDays && typeof f.lastVisitDays === 'object') {
    const d = c.days_since_visit;
    const { gte, lte } = f.lastVisitDays;
    if (gte != null && (d == null || Number(d) < Number(gte))) return false;
    if (lte != null && (d == null || Number(d) > Number(lte))) return false;
  }

  if (f.birthMonth) {
    // pg отдаёт DATE полуночью ЛОКАЛЬНОЙ зоны (мск): getUTCMonth дал бы для 1-го числа прошлый месяц.
    const m = c.birthday ? new Date(c.birthday).getMonth() + 1 : null;
    if (m !== Number(f.birthMonth)) return false;
  }

  if (f.gender && c.gender && String(c.gender).toLowerCase() !== String(f.gender).toLowerCase()) return false;

  const frag = f.phone ? digits(f.phone) : '';
  if (frag && !digits(c.phone).includes(frag)) return false;
  return true;
}

async function loadSalonName(salonId) {
  const s = await db.oneOrNone(
    `SELECT COALESCE(NULLIF(template_logo_line1,''), name) AS salon_name FROM salons WHERE id = $1`, [salonId]);
  return (s && s.salon_name) || '';
}

async function loadByFilters(salonId, filters) {
  const rows = await db.any(
    `SELECT ${CLIENT_COLS}, cs.segment_key AS segment_key,
            COALESCE(NULLIF(s.template_logo_line1,''), s.name) AS salon_name
       FROM clients c
       LEFT JOIN client_segments cs ON cs.client_id = c.id AND cs.salon_id = c.salon_id
       LEFT JOIN salons s ON s.id = c.salon_id
      WHERE c.salon_id = $1 AND c.phone IS NOT NULL
      ORDER BY c.id`, [salonId]);
  const skipped = { blacklist: 0, no_recipient: 0 };
  const out = [];
  const seen = new Set();
  for (const c of rows) {
    if (!matchesFilters(c, filters)) continue;
    if (c.is_blacklisted) { skipped.blacklist++; continue; }
    const phone = canonPhone(c.phone);
    if (!phone || seen.has(phone)) continue; // негодный номер — без счёта; общий номер двух карточек — один получатель
    seen.add(phone);
    out.push({ client_id: c.client_id, name: c.name || '', phone, bonus_balance: Number(c.bonus_balance || 0), salon_name: c.salon_name || '' });
  }
  return { people: out, skipped };
}

async function loadByList(salonId, list) {
  const items = (Array.isArray(list) ? list : []).map(i => ({ name: i && i.name ? String(i.name).trim() : '', phone: canonPhone(i && i.phone) })).filter(i => i.phone);
  const skipped = { blacklist: 0, no_recipient: 0 };
  if (!items.length) return { people: [], skipped };
  const forms = [];
  for (const i of items) forms.push(i.phone, '8' + i.phone.slice(1));
  const rows = await db.any(
    `SELECT ${CLIENT_COLS}, COALESCE(NULLIF(s.template_logo_line1,''), s.name) AS salon_name
       FROM clients c LEFT JOIN salons s ON s.id = c.salon_id
      WHERE c.salon_id = $1 AND regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') = ANY($2::text[])
      ORDER BY c.id`, [salonId, forms]);
  const byPhone = new Map();
  for (const c of rows) {
    const k = canonPhone(c.phone);
    if (!k) continue;
    // Несколько карточек на номер: не ЧС главнее (рассылку остановит только если ЧС все).
    const prev = byPhone.get(k);
    if (!prev || (prev.is_blacklisted && !c.is_blacklisted)) byPhone.set(k, c);
  }
  let salonName = null;
  const people = [];
  for (const i of items) {
    const c = byPhone.get(i.phone);
    if (c) {
      if (c.is_blacklisted) { skipped.blacklist++; continue; }
      people.push({ client_id: c.client_id, name: i.name || c.name || '', phone: i.phone, bonus_balance: Number(c.bonus_balance || 0), salon_name: c.salon_name || '' });
    } else {
      if (salonName == null) salonName = await loadSalonName(salonId);
      people.push({ client_id: null, name: i.name, phone: i.phone, bonus_balance: 0, salon_name: salonName });
    }
  }
  return { people, skipped };
}

async function resolveAudience(salonId, { source, filters, list, channelSettings, cascadeEnabled } = {}) {
  const { people, skipped } = source === 'list' ? await loadByList(salonId, list) : await loadByFilters(salonId, filters);
  const cfg = await notifSettings.getSettings(salonId);
  const chans = channelSettings || {};

  const convs = new Array(people.length);
  for (let i = 0; i < people.length; i += CONV_BATCH) {
    const slice = people.slice(i, i + CONV_BATCH);
    const res = await Promise.all(slice.map(p => lastConversation(salonId, p.phone).catch(() => ({ lastChannel: null, chats: {} }))));
    res.forEach((r, k) => { convs[i + k] = r || { lastChannel: null, chats: {} }; });
  }

  const recipients = [];
  people.forEach((p, idx) => {
    const conv = convs[idx];
    let cascade = buildCascade(cfg.default_channels, { preferLast: cfg.prefer_last_channel !== false, lastChannel: conv.lastChannel })
      .filter(ch => chans[ch] && chans[ch].enabled && recipientFor(ch, p.phone, conv.chats) != null);
    if (cascadeEnabled === false) cascade = cascade.slice(0, 1);
    if (!cascade.length) { skipped.no_recipient++; return; }
    recipients.push({ ...p, cascade, sort_order: recipients.length });
  });
  return { recipients, skipped };
}

module.exports = { resolveAudience, matchesFilters, CONV_BATCH };
