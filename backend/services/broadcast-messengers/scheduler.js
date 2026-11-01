'use strict';
// Планировщик разовой рассылки через мессенджеры — чистая часть, без БД и сети (спека 2026-11-01 §5).
// Получатель ждёт СВОЙ мессенджер (решение владельца): за тик уходит не больше одного сообщения в
// каждый свободный мессенджер — первому в очереди этого мессенджера. Пауза и лимит считаются по
// отправкам ЭТОЙ рассылки; лимит исчерпан → по on_limit получатель идёт дальше по своему каскаду или
// пропускается. Окно 09:00–21:00 мск (конец исключающий, как у паузы темпа напоминаний).
const CHANNELS = ['tdlib', 'whatsapp', 'max'];
const WINDOW_START_MIN = 9 * 60;
const WINDOW_END_MIN = 21 * 60;

// Процесс и jest живут в Europe/Moscow — локальные часы = мск.
function inSendWindow(nowMs) {
  const d = new Date(nowMs);
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= WINDOW_START_MIN && m < WINDOW_END_MIN;
}

/** settings — broadcasts.channel_settings; stats — {ch:{lastSentAt(ms|null), sentCount}}. */
function channelStates(settings, stats, nowMs) {
  const out = {};
  for (const ch of CHANNELS) {
    const cfg = (settings && settings[ch]) || {};
    const st = (stats && stats[ch]) || {};
    const sent = Number(st.sentCount) || 0;
    const limit = cfg.limit == null || cfg.limit === '' ? null : Number(cfg.limit);
    if (!cfg.enabled) { out[ch] = { state: 'disabled', pausedUntil: null, sent, limit }; continue; }
    if (limit != null && sent >= limit) { out[ch] = { state: 'limit', pausedUntil: null, sent, limit }; continue; }
    const until = st.lastSentAt ? st.lastSentAt + (Number(cfg.delay_sec) || 0) * 1000 : null;
    if (until != null && nowMs < until) { out[ch] = { state: 'paused', pausedUntil: until, sent, limit }; continue; }
    out[ch] = { state: 'free', pausedUntil: null, sent, limit };
  }
  return out;
}

/** heads — {ch: первый ожидающий получатель этого мессенджера | null}. */
function pickSends(states, heads) {
  const out = [];
  for (const ch of CHANNELS) {
    const h = heads && heads[ch];
    if (h && states[ch] && states[ch].state === 'free') out.push({ id: h.id, channel: ch });
  }
  return out;
}

/** Следующий шаг каскада после step, мессенджер которого не в blocked. */
function nextStep(cascade, step, blocked) {
  const list = Array.isArray(cascade) ? cascade : [];
  for (let k = step + 1; k < list.length; k++) {
    if (!blocked.has(list[k])) return { step: k, channel: list[k] };
  }
  return null;
}

/** Что делать с получателем, чей текущий мессенджер упёрся в лимит. blocked — limit + disabled. */
function limitAction(rec, onLimit, blocked) {
  if (onLimit === 'next_channel') {
    const n = nextStep(rec.cascade, rec.step, blocked);
    if (n) return { action: 'advance', step: n.step, channel: n.channel };
  }
  return { action: 'skip', reason: 'limit' };
}

module.exports = { CHANNELS, inSendWindow, channelStates, pickSends, nextStep, limitAction, WINDOW_START_MIN, WINDOW_END_MIN };
