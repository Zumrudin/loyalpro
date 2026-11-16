const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db');

const mobileAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    if (decoded.type !== 'client') return res.status(403).json({ error: 'Недостаточно прав' });
    if (!decoded.clientId || !decoded.salonId || !decoded.phone) {
      return res.status(401).json({ error: 'Неверный токен' });
    }

    const session = await db.oneOrNone(
      `SELECT ms.client_id AS "clientId",ms.phone,c.salon_id AS "salonId",
              c.yclients_client_id AS "yclientsClientId"
       FROM mobile_sessions ms
       JOIN clients c ON c.id=ms.client_id
       JOIN salons s ON s.id=c.salon_id AND s.is_active=TRUE
       WHERE ms.token=$1 AND ms.expires_at>NOW()
         AND ms.client_id=$2 AND ms.salon_id=c.salon_id
         AND c.salon_id=$3 AND ms.phone=$4`,
      [token, decoded.clientId, decoded.salonId, decoded.phone]
    );
    const configuredSalonId = Number(config.MOBILE_AUTH?.salonId);
    if (!session || String(session.clientId) !== String(decoded.clientId) ||
        String(session.salonId) !== String(decoded.salonId) ||
        session.salonId !== configuredSalonId) {
      return res.status(401).json({ error: 'Сессия истекла или отозвана' });
    }

    req.client = { ...session, type: 'client', phone: session.phone };
    req.token = token;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Неверный токен' });
  }
};

module.exports = { mobileAuth };
