// backend/services/messenger-stats.js
'use strict';
// ============================================================
// Статистика переписок в мессенджерах для дашборда.
// Спека: docs/superpowers/specs/2026-10-03-dashboard-messenger-stats-design.md
//
// Единица счёта — ДИАЛОГ-ДЕНЬ (собеседник + московская дата), автоуведомления
// (authored_by='system') и групповые чаты не считаются. «Клиент написал
// первым» — первое неслужебное сообщение дня входящее. «Записался в тот же
// день» — у клиента с этим телефоном есть запись YClients, СОЗДАННАЯ в этот
// день (raw_payload->>'create_date', московское локальное время), статус не
// 'deleted'. records.created_at для этого не годится: это время вставки нашей
// строки (у source='sync' — время синка).
// ============================================================

const CHANNEL_LABELS = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };

function channelLabel(channel) {
  if (channel == null || channel === '') return '—';
  return CHANNEL_LABELS[channel] || String(channel);
}

// Перечисление дат включительно; арифметика в UTC, чтобы DST не съел день.
function eachDate(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function dateKey(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

const n = v => Number(v) || 0;

function emptyStat() {
  return { dialogs: 0, clientFirst: 0, clientFirstNoPhone: 0, bookedSameDay: 0, bookedByAgent: 0 };
}

function addRow(acc, r) {
  acc.dialogs += n(r.dialogs);
  acc.clientFirst += n(r.client_first);
  acc.clientFirstNoPhone += n(r.client_first_no_phone);
  acc.bookedSameDay += n(r.booked_same_day);
  acc.bookedByAgent += n(r.booked_by_agent);
}

// rows: [{date, channel, dialogs, client_first, client_first_no_phone, booked_same_day, booked_by_agent}]
function summarize(rows, { from, to }) {
  const totals = emptyStat();
  const byChannelMap = new Map();
  const byDay = new Map(eachDate(from, to).map(d => [d, { date: d, clientFirst: 0, bookedSameDay: 0 }]));

  for (const r of rows || []) {
    addRow(totals, r);
    const ch = r.channel == null ? '' : String(r.channel);
    if (!byChannelMap.has(ch)) byChannelMap.set(ch, { channel: ch, label: channelLabel(ch), ...emptyStat() });
    addRow(byChannelMap.get(ch), r);
    const day = byDay.get(dateKey(r.date));
    if (day) { day.clientFirst += n(r.client_first); day.bookedSameDay += n(r.booked_same_day); }
  }

  const byChannel = [...byChannelMap.values()]
    .sort((a, b) => (b.dialogs - a.dialogs) || a.channel.localeCompare(b.channel));

  return { period: { from, to }, totals, byChannel, daily: [...byDay.values()] };
}

module.exports = { summarize, channelLabel, eachDate, CHANNEL_LABELS };
