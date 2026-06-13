// ============================================================
// Telegram Broadcasts API
// ============================================================
//
// Mounted at /api/broadcasts. owner/admin only.
//
//   GET    /subscribers/preview?filters=<json>
//          → { total, sample: [...] } — для live-counter в UI до отправки
//   GET    /                            → история рассылок салона
//   POST   /                            → { messageTemplate, filters } — создать
//   GET    /:id                         → статус (для polling)
//   POST   /:id/cancel                  → запросить отмену
//
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const broadcast = require('../services/broadcast');
const { createLogger } = require('../logger');

const log = createLogger('BroadcastRoute');

const guard = [auth, requireRole('owner', 'admin')];

// Превью получателей для текущих фильтров. JSON отдаётся в query.filters
// (URLencoded) — чтобы UI мог дешёво опрашивать, не отправляя POST.
router.get('/subscribers/preview', guard, async (req, res) => {
  try {
    let filters = {};
    if (req.query.filters) {
      try { filters = JSON.parse(req.query.filters); }
      catch { return res.status(400).json({ error: 'Bad filters JSON' }); }
    }
    const r = await broadcast.previewAudience(req.user.salonId, filters);
    res.json(r);
  } catch (e) {
    log.error(`preview: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// История рассылок
router.get('/', guard, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '30', 10), 100);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    const items = await broadcast.listBroadcasts(req.user.salonId, { limit, offset });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Создание новой рассылки
router.post('/', guard, async (req, res) => {
  try {
    const { messageTemplate, filters } = req.body || {};
    if (!messageTemplate || typeof messageTemplate !== 'string' || !messageTemplate.trim()) {
      return res.status(400).json({ error: 'messageTemplate required' });
    }
    if (messageTemplate.length > 4000) {
      return res.status(400).json({ error: 'Сообщение слишком длинное (макс 4000 символов)' });
    }
    const b = await broadcast.createBroadcast({
      salonId:         req.user.salonId,
      authorUserId:    req.user.id,
      messageTemplate,
      filters:         filters || {},
    });
    res.json({ ok: true, broadcast: b });
  } catch (e) {
    log.error(`create: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

// Статус одной рассылки (для polling из UI)
router.get('/:id', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const b = await broadcast.getBroadcast(req.user.salonId, id);
    if (!b) return res.status(404).json({ error: 'not found' });
    res.json(b);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Отмена ещё не доставленных сообщений
router.post('/:id/cancel', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const ok = await broadcast.cancelBroadcast(req.user.salonId, id);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
