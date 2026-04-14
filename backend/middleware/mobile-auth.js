const jwt = require('jsonwebtoken');
const config = require('../config');

const JWT_SECRET = config.JWT_SECRET;

const mobileAuth = (req, res, next) => {
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

    req.client = decoded;
    req.token = token;
    next();

  } catch (error) {
    return res.status(401).json({ error: 'Неверный токен' });
  }
};

module.exports = { mobileAuth };
