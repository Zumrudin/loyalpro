// backend/routes/public-cert-request.js
// Публичный роутер (БЕЗ JWT) — форма заявки на справку для встройки в Wix.
'use strict';

const path = require('path');
const router = require('express').Router();
const cfg = require('../config');
const { db } = require('../db');
const { createLogger } = require('../logger');
const svc = require('../services/cert-request');

const logger = createLogger('CertRequestPublic');

// Доступные отчётные годы: текущий и 2 предыдущих (TZ Москвы — сервер уже в ней).
function availableYears() {
  const y = new Date().getFullYear();
  return [y, y - 1, y - 2];
}

// Страница-форма: разрешаем встраивание в iframe для доменов из конфига.
router.get('/cert-request/:slug', async (req, res) => {
  const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
  if (!salon) return res.status(404).send('Форма не найдена');
  res.removeHeader('X-Frame-Options');
  const ancestors = ["'self'", ...cfg.CERT_REQUEST_FRAME_ANCESTORS].join(' ');
  res.setHeader('Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors ${ancestors}`);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../../frontend/cert-request.html'));
});

// Конфиг формы (публичный): название клиники, годы, степени родства, ссылка на политику.
router.get('/api/public/cert-requests/:slug/config', async (req, res) => {
  try {
    const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
    if (!salon) return res.status(404).json({ error: 'not_found' });
    res.json({
      clinicName: cfg.MEDICAL_CERT_CLINIC.org_name,
      years: availableYears(),
      relationships: Object.entries(svc.RELATIONSHIP_LABELS).map(([code, label]) => ({ code, label })),
      policyUrl: '/privacy-policy.html',
    });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'config_failed' }); }
});

module.exports = router;
