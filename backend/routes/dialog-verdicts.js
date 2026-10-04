// backend/routes/dialog-verdicts.js
'use strict';
// Ручки вердиктов ИИ по перепискам. Монтируется на /api/analytics/messengers/verdicts
// РАНЬШЕ общего роутера /api (routes/index.js). Роли: специалист и кассир
// отсекаются allowlist-префиксами в index.js, остальное — owner/admin.
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const store = require('../services/dialog-verdicts/store');
const { runVerdicts } = require('../services/dialog-verdicts/run');
const { STATUS_CODES, UNANALYZED } = require('../services/dialog-verdicts/taxonomy');
const { periodDays, MAX_PERIOD_DAYS } = require('../services/messenger-stats');
const { createLogger } = require('../logger');
const logger = createLogger('DialogVerdictsAPI');

router.use(auth, requireRole('owner', 'admin'));

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CHANNEL_RE = /^[\w-]{0,20}$/;

// Период берётся ТОЛЬКО явными датами (кнопка и детализация всегда шлют from/to).
function parsePeriod(src) {
  let { from, to } = src || {};
  if (!ISO.test(String(from || '')) || !ISO.test(String(to || ''))) return { error: 'нужны from и to в формате YYYY-MM-DD' };
  if (![from, to].every(v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v)) return { error: 'некорректная дата' };
  if (from > to) [from, to] = [to, from];
  const d = periodDays(from, to);
  if (!(d >= 1 && d <= MAX_PERIOD_DAYS)) return { error: `период не больше ${MAX_PERIOD_DAYS} дней` };
  return { from, to };
}

// GET /?from&to&status[&channel] — список диалог-дней для уровня 1.
router.get('/', auth, async (req, res) => {
  try {
    const p = parsePeriod(req.query);
    if (p.error) return res.status(400).json({ error: p.error });
    const status = String(req.query.status || '');
    const channel = String(req.query.channel || '');
    if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'битый канал' });
    if (status !== UNANALYZED && !STATUS_CODES.includes(status)) return res.status(400).json({ error: 'неизвестный статус' });
    const sid = req.user.salonId;
    const out = status === UNANALYZED
      ? await store.listUnanalyzed(sid, { from: p.from, to: p.to, channel })
      : await store.listVerdicts(sid, { from: p.from, to: p.to, channel, status });
    res.json(out);
  } catch (e) {
    logger.warn('verdict list failed');
    res.status(500).json({ error: 'Не удалось выполнить запрос анализа' });
  }
});

// GET /runs?limit=5
router.get('/runs', auth, async (req, res) => {
  try {
    const runs = await store.listRuns(req.user.salonId, Number(req.query.limit) || 5);
    res.json({ runs });
  } catch (e) { res.status(500).json({ error: 'Не удалось выполнить запрос анализа' }); }
});

// POST /run {from, to, recompute?, onlyStale?} → 202 {runId}; 409 пока идёт прогон.
router.post('/run', auth, async (req, res) => {
  try {
    const p = parsePeriod(req.body);
    if (p.error) return res.status(400).json({ error: p.error });
    if (['recompute', 'onlyStale'].some(k => req.body[k] !== undefined && typeof req.body[k] !== 'boolean')) return res.status(400).json({ error: 'флаги должны быть boolean' });
    const r = await runVerdicts({
      salonId: req.user.salonId, from: p.from, to: p.to, trigger: 'manual',
      recompute: !!(req.body && req.body.recompute), onlyStale: !!(req.body && req.body.onlyStale),
    });
    logger.info(`ручной прогон salon=${req.user.salonId} user=${req.user.userId} ${p.from}..${p.to} run=${r.runId}`);
    res.status(202).json({ runId: r.runId });
  } catch (e) {
    if (e.code === 'RUN_IN_PROGRESS') return res.status(409).json({ error: 'Анализ уже идёт, дождитесь окончания' });
    logger.warn('verdict run failed');
    res.status(500).json({ error: 'Не удалось выполнить запрос анализа' });
  }
});

module.exports = router;
module.exports._internals = { parsePeriod };
