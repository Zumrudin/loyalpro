'use strict';
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const service = require('../services/journal');
const m = require('../services/journal/model');
const payments = require('../services/journal/payments');
const paymentsLocal = require('../services/journal/payments-local');
const sessions = require('../services/journal/sessions');
const dispatch = require('../services/journal/dispatch');
const month = require('../services/journal/month');
const history = require('../services/journal/history');
const clientSummary = require('../services/journal/client-summary');
const visitHistory = require('../services/journal/visit-history');
router.use(auth, requireRole('owner', 'admin'));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const handle = fn => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    // Never return upstream messages (they can contain client data / credentials).
    if (e instanceof m.JournalError) return res.status(e.status).json({ error: e.message, code: e.code });
    res.status(502).json({ error: 'Не удалось загрузить данные. Обновите журнал.', code: 'unavailable' });
  }
};
router.get('/operations/pending', requireRole('owner'), handle(req => service.pending(req.user.salonId)));
router.post('/operations/review', requireRole('owner'), handle(req => {
  if (req.body?.checkedInYclients !== true || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.body.operationId || '')) m.fail('Подтвердите сверку операции в YClients.');
  return service.review(req.user.salonId, req.user.userId || req.user.id, req.body.operationId);
}));
router.get('/payments/:id', handle(req => req.query.local === '1'
  ? paymentsLocal.localPaymentOptions(req.user.salonId, m.nonZeroId(req.params.id))
  : payments.options(req.user.salonId, m.positiveId(req.params.id))));
router.post('/payments', handle(req => payments.pay(req.user.salonId, req.user.userId || req.user.id, payments.parse(req.body))));
router.post('/payments/review', requireRole('owner'), handle(req => payments.review(req.user.salonId, req.user.userId || req.user.id, req.body)));
// Local-first form sessions: validated on local data, executed by the outbox worker.
router.post('/sessions/validate', handle(async req => {
  const { options, overlay } = await sessions.validate(req.user.salonId, sessions.parseSession(req.body));
  return { ok: true, options, overlay };
}));
// Saved locally only: YClients is updated by «Отправить в YClients» (dispatch).
router.post('/sessions', handle(req => sessions.enqueue(req.user.salonId, req.user.userId || req.user.id, sessions.parseSession(req.body))));
router.get('/dispatch/summary', handle(req => dispatch.summary(req.user.salonId)));
router.get('/dispatch/preview', handle(req => dispatch.preview(req.user.salonId, req.query)));
router.post('/dispatch', handle(async req => {
  const out = await dispatch.release(req.user.salonId, req.body);
  if (out.packages) require('../services/journal/outbox-worker').kick();
  return out;
}));
router.get('/dispatch/:id', handle(req => dispatch.progress(req.user.salonId, req.params.id)));
router.post('/sessions/:id/retry', handle(req => sessions.retry(req.user.salonId, m.positiveId(req.params.id))));
router.post('/sessions/:id/dismiss', handle(req => sessions.dismiss(req.user.salonId, m.positiveId(req.params.id))));
router.get('/day', handle(req => service.day(req.user.salonId, m.dateKey(req.query.date))));
router.get('/week', handle(req => service.week(req.user.salonId, m.dateKey(req.query.date), req.query.staffId ? m.positiveId(req.query.staffId) : null)));
router.get('/month', handle(req => month.month(req.user.salonId, req.query.month)));
router.get('/records/:id', handle(req => service.detail(req.user.salonId, m.nonZeroId(req.params.id))));
router.get('/records/:id/history', handle(req => history.load(req.user.salonId, m.nonZeroId(req.params.id))));
router.get('/clients/summary', handle(req => clientSummary.summary(req.user.salonId, req.query)));
router.get('/clients/visits', handle(req => visitHistory.load(req.user.salonId, req.query)));
router.get('/slots', handle(req => {
  const draft = { date: m.dateKey(req.query.date), staffId: m.positiveId(req.query.staffId) };
  if (req.query.recordId) draft.recordId = m.positiveId(req.query.recordId);
  else {
    const values = String(req.query.serviceIds || '').split(',');
    if (values.length > 10) m.fail('Слишком много услуг.');
    draft.serviceIds = [...new Set(values.map(m.positiveId))];
    if (req.query.serviceSource !== undefined) {
      if (req.query.serviceSource !== 'internal') m.fail('Неизвестный источник услуг.');
      draft.serviceSource = 'internal';
      if (req.query.quantities !== undefined) {
        const quantities = String(req.query.quantities).split(',').map(Number);
        if (quantities.length !== draft.serviceIds.length || quantities.some(n => !Number.isInteger(n) || n < 1 || n > 100)) m.fail('Некорректное количество услуг.');
        draft.quantities = Object.fromEntries(draft.serviceIds.map((id,i) => [id,quantities[i]]));
      }
    }
  }
  return service.slots(req.user.salonId, draft);
}));
for (const action of ['create', 'move', 'cancel', 'confirm']) {
  router.post('/' + action, handle(req => service.mutate(req.user.salonId, req.user.userId || req.user.id, m.parseDraft(req.body, action))));
}
module.exports = router;
