'use strict';
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const { getStore } = require('../services/agent/model-routing');
router.use(auth, requireRole('owner', 'admin'));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/', async (req, res) => {
  try { res.json(await getStore().status(req.user.salonId, req.user.userId)); }
  catch (_) { res.status(500).json({ error: 'Не удалось загрузить состояние модели' }); }
});
router.put('/', async (req, res) => {
  try {
    await getStore().manual(req.user.salonId, req.body?.active, req.body?.revision);
    res.json(await getStore().status(req.user.salonId, req.user.userId));
  } catch (e) {
    res.status(e.code === 'BAD_SELECTION' ? 400 : e.code === 'CONFLICT' ? 409 : 500)
      .json({ error: e.code === 'CONFLICT' ? 'Модель уже переключилась. Обновите настройки.' : 'Не удалось переключить модель' });
  }
});
router.post('/acknowledge', async (req, res) => {
  try {
    await getStore().acknowledge(req.user.salonId, req.user.userId, req.body?.revision);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.code === 'BAD_SELECTION' ? 400 : 500).json({ error: 'Не удалось подтвердить уведомление' });
  }
});
module.exports = router;
