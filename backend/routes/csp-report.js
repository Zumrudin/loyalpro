'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createLogger } = require('../logger');

const router = express.Router();
const logger = createLogger('CSPReport');
const DIRECTIVES = new Set(['script-src', 'script-src-elem', 'script-src-attr']);
const reportLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'too_many_requests' }),
});
const reportJson = express.json({
  limit: '4kb',
  type: ['application/json', 'application/csp-report'],
});

router.post('/api/csp-report', reportJson, reportLimit, (req, res) => {
  const report = req.body?.['csp-report'];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return res.status(400).json({ error: 'invalid_report' });
  }
  const directive = DIRECTIVES.has(report['effective-directive'])
    ? report['effective-directive']
    : DIRECTIVES.has(report['violated-directive']) ? report['violated-directive'] : 'other';
  const blocked = report['blocked-uri'] === 'inline' ? 'inline'
    : report['blocked-uri'] === 'eval' ? 'eval' : 'other';
  logger.info(`violation directive=${directive} blocked=${blocked}`);
  res.status(204).end();
});
router.use('/api/csp-report', (err, _req, res, _next) => {
  res.status(err?.type === 'entity.too.large' ? 413 : 400).json({ error: 'invalid_report' });
});

module.exports = router;
module.exports.REPORT_ONLY_CSP = "script-src 'self' cdn.jsdelivr.net; report-uri /api/csp-report";
