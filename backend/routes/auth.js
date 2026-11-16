const { resolveGivenName } = require('../utils/person-name');
const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, db, withTransaction } = require('../db');
const { auth } = require('../middleware/auth');
const config  = require('../config');
const resourceLimits = require('../services/resource-limits');
const registrationInvites = require('../services/registration-invites');
const JWT_SECRET = config.JWT_SECRET;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток входа. Повторите через 15 минут.' },
});

async function registerLimiter(req, res, next) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    await resourceLimits.register(req.ip, email);
    next();
  } catch (e) {
    res.status(e.status || 503).json({ error: e.status === 429 ? e.message : 'Регистрация временно недоступна' });
  }
}

router.post('/register', registerLimiter, async (req, res) => {
  let pg;
  try {
    const { salonName, city, email, password } = req.body || {};
    if (typeof salonName !== 'string' || typeof email !== 'string' || typeof password !== 'string'
        || !salonName.trim() || !email.trim() || !password)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Пароль минимум 8 символов' });
    if (salonName.length > 200 || email.length > 254 || (city && (typeof city !== 'string' || city.length > 200))
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Проверьте поля регистрации' });

    pg = await pool.connect();
    await pg.query('BEGIN');
    await registrationInvites.consume(pg, req.body.invitation, email);
    const salon = (await pg.query(
      'INSERT INTO salons (name,city) VALUES ($1,$2) RETURNING id',
      [salonName.trim(), city || null]
    )).rows[0];
    await pg.query('INSERT INTO loyalty_settings (salon_id) VALUES ($1)', [salon.id]);
    const hash = await bcrypt.hash(password, 12);
    const user = (await pg.query(
      `INSERT INTO users (salon_id,email,password_hash,name,role)
       VALUES ($1,$2,$3,$4,'owner') RETURNING id,name,email,role`,
      [salon.id, email.toLowerCase().trim(), hash, salonName]
    )).rows[0];
    const token = jwt.sign(
      { userId: user.id, salonId: salon.id, role: 'owner' },
      JWT_SECRET, { expiresIn: '7d' }
    );
    await pg.query(
      `INSERT INTO sessions (user_id,token,ip,user_agent,expires_at)
       VALUES ($1,$2,$3,$4,NOW()+INTERVAL '7 days')`,
      [user.id, token, req.ip, req.headers['user-agent'] || '']
    );
    await pg.query('COMMIT');
    res.json({ token, user: { ...user, salonName } });
  } catch (e) {
    if (pg) await pg.query('ROLLBACK');
    if (e.status === 403) return res.status(403).json({ error: 'Приглашение недействительно или истекло.' });
    if (e.code === '23505')
      return res.status(409).json({ error: 'Не удалось завершить регистрацию' });
    console.error('[auth/register] failed');
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  } finally { if (pg) pg.release(); }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Укажите email и пароль' });
    const user = await db.one(
      `SELECT u.*,s.name as salon_name FROM users u
       JOIN salons s ON s.id=u.salon_id
       WHERE u.email=$1 AND u.is_active=TRUE AND s.is_active=TRUE`,
      [email.toLowerCase().trim()]
    );
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });

    const token = jwt.sign(
      { userId: user.id, salonId: user.salon_id, role: user.role },
      JWT_SECRET, { expiresIn: '7d' }
    );
    await db.query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [user.id]);
    await db.query(
      `INSERT INTO sessions (user_id,token,ip,user_agent,expires_at)
       VALUES ($1,$2,$3,$4,NOW()+INTERVAL '7 days')`,
      [user.id, token, req.ip, req.headers['user-agent'] || '']
    );
    res.json({ token, user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, salonName: user.salon_name,
      must_change_password: user.must_change_password || false,
    }});
  } catch (e) { console.error('[auth]', e.message); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

router.post('/change-password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 8)
      return res.status(400).json({ error: 'Новый пароль минимум 8 символов' });
    const user = await db.one(
      'SELECT * FROM users WHERE id=$1 AND salon_id=$2',
      [req.user.userId, req.user.salonId]
    );
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    // Always require the current password, even on first activation.
    // The user just logged in with the temp password — they know it.
    if (!current_password) return res.status(400).json({ error: 'Укажите текущий пароль' });
    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Текущий пароль неверный' });
    const hash = await bcrypt.hash(new_password, 12);
    const updated = await withTransaction(async client => {
      const result = await client.query(
        'UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2 AND salon_id=$3 RETURNING id',
        [hash, req.user.userId, req.user.salonId]
      );
      if (!result.rows[0]) return false;
      // Own password change keeps only the server-derived current session.
      await client.query(
        'DELETE FROM sessions WHERE user_id=$1 AND token<>$2',
        [req.user.userId, req.token]
      );
      return true;
    });
    if (!updated) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ ok: true });
  } catch (e) { console.error('[auth]', e.message); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

router.post('/logout', auth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM sessions WHERE token=$1 AND user_id=$2',
      [req.token, req.user.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth/logout]', e.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = await db.one(
      `SELECT u.id,u.name,u.email,u.role,u.must_change_password,
              s.name as salon_name,s.yclients_company_id
       FROM users u JOIN salons s ON s.id=u.salon_id WHERE u.id=$1`,
      [req.user.userId]
    );
    // Личное имя для приветствия: в users.name бывает и «Имя Фамилия», и
    // «Фамилия Имя» — разбор тот же, что у обращения Милы к пациентам.
    if (user) user.given_name = resolveGivenName(user.name || '') || null;
    res.json(user);
  } catch (e) { console.error('[auth]', e.message); res.status(500).json({ error: 'Внутренняя ошибка сервера' }); }
});

module.exports = router;
