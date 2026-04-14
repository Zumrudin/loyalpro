const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { db }  = require('../db');
const { auth, requireRole } = require('../middleware/auth');

router.get('/', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const users = await db.any(
      `SELECT u.id,u.name,u.email,u.role,u.is_active,u.must_change_password,
              u.created_at,u.last_login_at
       FROM users u WHERE u.salon_id=$1 ORDER BY u.created_at`,
      [req.user.salonId]
    );
    const salon = await db.one('SELECT plan,max_users FROM salons WHERE id=$1', [req.user.salonId]);
    const activeCount = users.filter(u => u.is_active).length;
    res.json({ users, plan: salon.plan, max_users: salon.max_users, active_count: activeCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', auth, requireRole('owner'), async (req, res) => {
  try {
    const { name, email, role, password } = req.body;
    if (!name || !email || !role || !password)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (!['admin', 'specialist'].includes(role))
      return res.status(400).json({ error: 'Недопустимая роль' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const salon = await db.one('SELECT max_users FROM salons WHERE id=$1', [req.user.salonId]);
    const { rows: [{ count }] } = await db.query(
      'SELECT COUNT(*) FROM users WHERE salon_id=$1 AND is_active=TRUE', [req.user.salonId]
    );
    if (parseInt(count) >= salon.max_users)
      return res.status(403).json({ error: `Достигнут лимит пользователей (${salon.max_users}). Обратитесь в поддержку для увеличения лимита.` });

    const hash = await bcrypt.hash(password, 12);
    const user = await db.one(
      `INSERT INTO users (salon_id,email,password_hash,name,role,is_active,must_change_password,created_by)
       VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,$6) RETURNING id,name,email,role,is_active,must_change_password,created_at`,
      [req.user.salonId, email.toLowerCase().trim(), hash, name, role, req.user.userId]
    );
    res.json(user);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', auth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, is_active, password } = req.body;
    if (parseInt(id) === req.user.userId && is_active === false)
      return res.status(400).json({ error: 'Нельзя деактивировать свой аккаунт' });
    if (parseInt(id) === req.user.userId && role && role !== req.user.role)
      return res.status(400).json({ error: 'Нельзя изменить свою роль' });

    const updates = [], vals = [];
    let i = 1;
    if (name !== undefined) { updates.push(`name=$${i++}`); vals.push(name); }
    if (role !== undefined) {
      if (!['owner','admin','specialist'].includes(role))
        return res.status(400).json({ error: 'Недопустимая роль' });
      updates.push(`role=$${i++}`); vals.push(role);
    }
    if (is_active !== undefined) { updates.push(`is_active=$${i++}`); vals.push(is_active); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
      const hash = await bcrypt.hash(password, 12);
      updates.push(`password_hash=$${i++}`, `must_change_password=$${i++}`);
      vals.push(hash, true);
    }
    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });

    vals.push(id, req.user.salonId);
    const user = await db.oneOrNone(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${i++} AND salon_id=$${i}
       RETURNING id,name,email,role,is_active,must_change_password`,
      vals
    );
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', auth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.userId)
      return res.status(400).json({ error: 'Нельзя удалить свой аккаунт' });
    await db.query(
      'UPDATE users SET is_active=FALSE WHERE id=$1 AND salon_id=$2',
      [id, req.user.salonId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
