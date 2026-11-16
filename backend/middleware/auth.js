// ============================================================
// Auth Middleware
// ============================================================
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db');

function requestToken(req) {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : '';
  return typeof token === 'string' ? token : '';
}

async function authenticateStaff(req, res, next) {
  const token = requestToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (req.token === token && req.user) return next();

  let claims;
  try { claims = jwt.verify(token, config.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token expired or invalid' }); }
  if (!claims || typeof claims !== 'object' || claims.userId == null || claims.salonId == null) {
    return res.status(401).json({ error: 'Token expired or invalid' });
  }

  let staff;
  try {
    staff = await db.oneOrNone(
      `SELECT u.id AS "userId",u.salon_id AS "salonId",u.role
       FROM sessions s
       JOIN users u ON u.id=s.user_id AND u.is_active=TRUE
       JOIN salons sl ON sl.id=u.salon_id AND sl.is_active=TRUE
       WHERE s.token=$1 AND s.expires_at>NOW() AND s.user_id=$2 AND u.salon_id=$3`,
      [token, claims.userId, claims.salonId]
    );
  } catch { return res.status(401).json({ error: 'Session check failed' }); }

  if (!staff || String(staff.userId) !== String(claims.userId) ||
      String(staff.salonId) !== String(claims.salonId)) {
    return res.status(401).json({ error: 'Session expired or revoked' });
  }

  req.token = token;
  req.user = { ...claims, userId: staff.userId, salonId: staff.salonId, role: staff.role };
  return next();
}

function auth(req, res, next) {
  return authenticateStaff(req, res, next);
}

// Roles: owner > admin > specialist
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ error: 'Нет доступа' });
    next();
  };
}

module.exports = { auth, requireRole };
