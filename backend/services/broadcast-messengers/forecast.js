'use strict';
// Прогноз разовой рассылки через мессенджеры — чистая часть, без БД и сети (спека 2026-11-01 §4).
// Это ОЦЕНКА для формы («кому уйдёт в какой мессенджер и когда закончится»), а не симуляция тиков:
// получатель занимает первый мессенджер каскада, где лимит ещё не исчерпан; мессенджеры шлют
// параллельно, длительность — максимум из (n−1) пауз; расходуется только внутри окна отправки.
const { CHANNELS, WINDOW_START_MIN, WINDOW_END_MIN } = require('./scheduler');

const DAY_MS = 24 * 3600 * 1000;

function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
// Границы окна на дату ms (локальное = московское время).
function windowOf(ms) {
  const d0 = dayStart(ms);
  return { start: d0 + WINDOW_START_MIN * 60000, end: d0 + WINDOW_END_MIN * 60000 };
}

/** Момент, когда набежит activeSec секунд отправки, если считать только окна. */
function finishWithWindows(nowMs, activeSec) {
  let t = nowMs;
  let w = windowOf(t);
  if (t < w.start) t = w.start;
  else if (t >= w.end) { t = windowOf(t + DAY_MS).start; }
  let left = activeSec * 1000;
  for (;;) {
    w = windowOf(t);
    const room = w.end - t;
    if (left <= room) return t + left;
    left -= room;
    t = windowOf(w.start + DAY_MS + 3600000).start; // следующий день, 09:00 (запас часа против перехода DST)
  }
}

function forecast({ firstSteps, settings, onLimit, nowMs }) {
  const cfg = settings || {};
  const count = { tdlib: 0, whatsapp: 0, max: 0 };
  let none = 0;
  const full = (ch) => {
    const c = cfg[ch] || {};
    if (!c.enabled) return true;
    const lim = c.limit == null || c.limit === '' ? null : Number(c.limit);
    return lim != null && count[ch] >= lim;
  };
  for (const r of firstSteps || []) {
    const cascade = Array.isArray(r.cascade) ? r.cascade : [];
    if (!cascade.length) { none++; continue; }
    let target = null;
    if (!full(cascade[0])) target = cascade[0];
    else if (onLimit === 'next_channel') target = cascade.slice(1).find(ch => !full(ch)) || null;
    if (target) count[target]++; else none++;
  }
  let activeSec = 0;
  for (const ch of CHANNELS) {
    const n = count[ch];
    if (n >= 1) activeSec = Math.max(activeSec, (n - 1) * (Number((cfg[ch] || {}).delay_sec) || 0));
  }
  const finishAt = finishWithWindows(nowMs, activeSec);
  return {
    byChannel: { tdlib: count.tdlib, whatsapp: count.whatsapp, max: count.max, none },
    durationMin: Math.round((finishAt - nowMs) / 60000),
    finishAt,
    nextDay: dayStart(finishAt) !== dayStart(nowMs),
  };
}

module.exports = { forecast, finishWithWindows };
