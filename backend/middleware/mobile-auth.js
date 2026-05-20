const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db');

const JWT_SECRET = config.JWT_SECRET;

const mobileAuth = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check that token is for a client (not a staff member)
    if (decoded.type !== 'client') {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }

    // Token must still map to a live session so logout can revoke it.
    const sess = await db.oneOrNone(
      'SELECT 1 FROM mobile_sessions WHERE token=$1 AND expires_at > NOW()',
      [token]
    );
    if (!sess) {
      return res.status(401).json({ error: 'Сессия истекла или отозвана' });
    }

    req.client = decoded;
    req.token = token;
    next();

  } catch (error) {
    return res.status(401).json({ error: 'Неверный токен' });
  }
};

module.exports = { mobileAuth };
