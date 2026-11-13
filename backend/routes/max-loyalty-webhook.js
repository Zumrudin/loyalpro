'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { sameSecret, configured, normalizeUpdate } = require('../services/max-loyalty/protocol');

function createRouter({ config, enqueue }) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
  router.post('/webhook', (req, res, next) => {
    if (!configured(config)) return res.sendStatus(503);
    if (!sameSecret(req.get('X-Max-Bot-Api-Secret'), config.webhookSecret)) return res.sendStatus(403);
    next();
  }, limiter, async (req, res) => {
    const event = normalizeUpdate(req.body, config.token);
    if (!event) return res.sendStatus(200); // Ignore groups, bot echoes, unsupported updates.
    try {
      await enqueue(config.salonId, event);
      // ACK only after durable acceptance; YClients and MAX calls run in worker.
      res.sendStatus(200);
    } catch {
      res.sendStatus(503); // Let MAX redeliver; never acknowledge a lost event.
    }
  });
  return router;
}
module.exports = createRouter({
  config: require('../config').MAX_LOYALTY_BOT,
  enqueue: (...args) => require('../services/max-loyalty/store').enqueue(...args),
});
module.exports.createRouter = createRouter;
