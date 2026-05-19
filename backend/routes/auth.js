const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { pool, db } = require('../db');
const { auth } = require('../middleware/auth');
const config  = require('../config');
const JWT_SECRET = config.JWT_SECRET;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток входа. Повторите через 15 минут.' },
});

router.post('/register', async (req, res) => {
  const pg = await pool.connect();
  try {
    const { salonName, city, email, password } = req.body;
    if (!salonName || !email || !password)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    await pg.query('BEGIN');
    const salon = (await pg.query(
      'INSERT INTO salons (name,city) VALUES ($1,$2) RETURNING id',
      [salonName, city || null]
    )).rows[0];
    await pg.query('INSERT INTO loyalty_settings (salon_id) VALUES ($1)', [salon.id]);
    const hash = await bcrypt.hash(password, 12);
    const user = (await pg.query(
      `INSERT INTO users (salon_id,email,password_hash,name,role)
       VALUES ($1,$2,$3,$4,'owner') RETURNING id,name,email,role`,
      [salon.id, email.toLowerCase().trim(), hash, salonName]
    )).rows[0];
    await pg.query('COMMIT');

    const token = jwt.sign(
      { userId: user.id, salonId: salon.id, role: 'owner' },
      JWT_SECRET, { expiresIn: '7d' }
    );
    await db.query(
      `INSERT INTO sessions (user_id,token,ip,user_agent,expires_at)
       VALUES ($1,$2,$3,$4,NOW()+INTERVAL '7 days')`,
      [user.id, token, req.ip, req.headers['user-agent'] || '']
    );
    res.json({ token, user: { ...user, salonName } });
  } catch (e) {
    await pg.query('ROLLBACK');
    if (e.code === '23505')
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    res.status(500).json({ error: e.message });
  } finally { pg.release(); }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Укажите email и пароль' });
    const user = await db.one(
      `SELECT u.*,s.name as salon_name FROM users u
       JOIN salons s ON s.id=u.salon_id
       WHERE u.email=$1 AND u.is_active=TRUE`,
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/change-password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 6)
      return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
    const user = await db.one('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    // Always require the current password, even on first activation.
    // The user just logged in with the temp password — they know it.
    if (!current_password) return res.status(400).json({ error: 'Укажите текущий пароль' });
    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Текущий пароль неверный' });
    const hash = await bcrypt.hash(new_password, 12);
    await db.query(
      'UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2',
      [hash, req.user.userId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', auth, async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  await db.query('DELETE FROM sessions WHERE token=$1', [token]).catch(() => {});
  res.json({ ok: true });
});

router.get('/me', auth, async (req, res) => {
  try {
    const user = await db.one(
      `SELECT u.id,u.name,u.email,u.role,u.must_change_password,
              s.name as salon_name,s.yclients_company_id
       FROM users u JOIN salons s ON s.id=u.salon_id WHERE u.id=$1`,
      [req.user.userId]
    );
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
