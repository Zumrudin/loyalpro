// ============================================================
// Routes — mount all routers onto Express app
// ============================================================
const config = require('../config');
const jwt    = require('jsonwebtoken');
const { db } = require('../db');

module.exports = function mountRoutes(app) {
  // ── Webhook (no JWT required) ───────────────────────────────
  app.use('/yclients', require('./webhook'));

  // ── Chatpush webhook — входящие сообщения (no JWT) ──────────
  app.use('/chatpush', require('./chatpush-webhook'));

  // ── Публичная форма заявки на справку (БЕЗ JWT — монтируем до guard) ──
  app.use(require('./public-cert-request'));

  // ── Mobile App API (separate auth) ────────────────────────
  app.use('/api/mobile/auth', require('./mobile-auth'));
  app.use('/api/mobile/client', require('./mobile-client'));

  // ── Global API auth + role middleware ──────────────────────
  app.use('/api', async (req, res, next) => {
    const fullPath = '/api' + req.path;
    if (config.API_PUBLIC.includes(fullPath)) return next();

    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try { req.user = jwt.verify(token, config.JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Token expired or invalid' }); }

    // Token must still map to a live session — lets logout / forced sign-out
    // actually revoke a JWT before its 7-day expiry.
    try {
      const sess = await db.oneOrNone(
        'SELECT 1 FROM sessions WHERE token=$1 AND expires_at > NOW()',
        [token]
      );
      if (!sess) return res.status(401).json({ error: 'Session expired or revoked' });
    } catch { return res.status(401).json({ error: 'Session check failed' }); }

    if (req.user.role === 'specialist' || req.user.role === 'admin_cashier') {
      const prefixes = req.user.role === 'admin_cashier'
        ? config.CASHIER_ALLOWED_PREFIXES
        : config.SPECIALIST_ALLOWED_PREFIXES;
      const allowed = prefixes.some(p => fullPath.startsWith(p));
      if (!allowed) return res.status(403).json({ error: 'Нет доступа' });
    }
    next();
  });

  // ── Specific prefix routes (must come before wildcard routers) ──
  app.use('/api/auth',              require('./auth'));
  app.use('/api/users',             require('./users'));
  app.use('/api/salon',             require('./salon'));
  app.use('/api/segments',          require('./segments'));
  app.use('/api/home-care',         require('./home-care'));
  app.use('/api/template-settings', require('./home-care-template-settings'));
  app.use('/api/app-settings',      require('./app-settings'));
  app.use('/api/portfolio',         require('./portfolio'));
  app.use('/api/chat',              require('./chat'));
  app.use('/api/agent',             require('./agent-settings'));
  app.use('/api/kb',                require('./knowledge-base'));
  app.use('/api/patient-portfolio', require('./patient-portfolio'));
  app.use('/api/broadcasts',        require('./broadcasts'));
  app.use('/api/notification-rules', require('./notification-rules'));
  app.use('/api/care',              require('./care'));
  app.use('/api/reminders',         require('./reminders'));
  app.use('/api/medical-cert',      require('./medical-cert'));

  // ── Clients CRUD at /api/clients (has /:id — must be specific prefix) ──
  app.use('/api/clients',           require('./clients'));

  // ── Staff analytics, goods-sales, services-config, csv-import ──
  app.use('/api',                   require('./staff'));

  // ── All other API routes: records, analytics, sync, loyalty-settings, bulk-import etc ──
  app.use('/api',                   require('./api'));
};
