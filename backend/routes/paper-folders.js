'use strict';
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const folders = require('../services/paper-folders');
router.use(auth, requireRole('owner','admin','admin_cashier'));
router.use((req,res,next)=>{ if (res.set) res.set('Cache-Control','no-store'); next(); });
router.patch('/outbox/:id', async (req,res) => {
  const id=Number(req.params.id);
  if (!Number.isSafeInteger(id) || id<1) return res.status(400).json({error:'Некорректная папка'});
  try { res.json({paperFolder:await folders.updateOutbox(req.user.salonId,id,req.user.userId,req.body)}); }
  catch(e) { res.status(e.status || 500).json({error:e.status ? e.message : 'Не удалось изменить папку'}); }
});
router.get('/day', async (req,res) => {
  try { res.json(await folders.day(req.user.salonId, req.query.date)); }
  catch(e) { res.status(e.status || 500).json({error:e.status ? e.message : 'Не удалось загрузить папки'}); }
});
module.exports = router;
