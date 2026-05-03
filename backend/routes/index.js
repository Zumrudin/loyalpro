// ============================================================
// Routes — mount all routers onto Express app
// ============================================================
const config = require('../config');
const jwt    = require('jsonwebtoken');

module.exports = function mountRoutes(app) {
  // ── Webhook (no JWT required) ───────────────────────────────
  app.use('/yclients', require('./webhook'));

  // ── Mobile App API (separate auth) ────────────────────────
  app.use('/api/mobile/auth', require('./mobile-auth'));
  app.use('/api/mobile/client', require('./mobile-client'));

  // ── Global API auth + role middleware ──────────────────────
  app.use('/api', (req, res, next) => {
    const fullPath = '/api' + req.path;
    if (config.API_PUBLIC.includes(fullPath)) return next();
    if (fullPath.startsWith('/api/yclients/')) return next();

    if (!req.user) {
      const h = req.headers.authorization;
      const t = h?.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
      if (!t) return res.status(401).json({ error: 'Unauthorized' });
      try { req.user = jwt.verify(t, config.JWT_SECRET); }
      catch { return res.status(401).json({ error: 'Token expired or invalid' }); }
    }

    if (req.user.role === 'specialist') {
      const allowed = config.SPECIALIST_ALLOWED_PREFIXES.some(p => fullPath.startsWith(p));
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

  // ── Clients CRUD at /api/clients (has /:id — must be specific prefix) ──
  app.use('/api/clients',           require('./clients'));

  // ── Staff analytics, goods-sales, services-config, csv-import ──
  app.use('/api',                   require('./staff'));

  // ── All other API routes: records, analytics, sync, loyalty-settings, bulk-import etc ──
  app.use('/api',                   require('./api'));
};
