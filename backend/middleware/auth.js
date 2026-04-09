// ============================================================
// Auth Middleware
// ============================================================
const jwt = require('jsonwebtoken');
const config = require('../config');

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(h.slice(7), config.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' });
  }
}

// Roles: owner > admin > specialist
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ error: 'Нет доступа' });
    next();
  };
}

// Auth supporting both Bearer header and ?token= query param (for direct downloads)
function authOrQuery(req, res, next) {
  const h = req.headers.authorization;
  const t = h?.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(t, config.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token expired' }); }
}

module.exports = { auth, requireRole, authOrQuery };
