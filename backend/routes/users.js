const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { db }  = require('../db');
const { auth, requireRole } = require('../middleware/auth');

router.get('/', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const users = await db.any(
      `SELECT u.id,u.name,u.email,u.role,u.position,u.is_active,u.must_change_password,
              u.created_at,u.last_login_at,
              u.staff_member_id, sm.name AS staff_member_name
       FROM users u
       LEFT JOIN staff_members sm ON sm.id = u.staff_member_id
       WHERE u.salon_id=$1 ORDER BY u.created_at`,
      [req.user.salonId]
    );
    const salon = await db.one('SELECT plan,max_users FROM salons WHERE id=$1', [req.user.salonId]);
    const activeCount = users.filter(u => u.is_active).length;
    res.json({ users, plan: salon.plan, max_users: salon.max_users, active_count: activeCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Валидация привязки: для роли specialist можно указать staff_member_id (или null),
// для остальных ролей staff_member_id игнорируется. Возвращает либо валидный
// integer/null, либо бросает ошибку.
async function resolveStaffMemberId(role, raw, salonId) {
  if (role !== 'specialist') return null;
  if (raw === undefined || raw === null || raw === '') return null;
  const id = parseInt(raw);
  if (Number.isNaN(id) || id <= 0) {
    const e = new Error('Некорректный staff_member_id');
    e.statusCode = 400;
    throw e;
  }
  const row = await db.oneOrNone(
    `SELECT 1 FROM staff_members WHERE id=$1 AND salon_id=$2`, [id, salonId]);
  if (!row) {
    const e = new Error('Указанный YClients-сотрудник не найден в этом салоне');
    e.statusCode = 400;
    throw e;
  }
  return id;
}

router.post('/', auth, requireRole('owner'), async (req, res) => {
  try {
    const { name, email, role, password, position, staff_member_id } = req.body;
    if (!name || !email || !role || !password)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (!['admin', 'specialist'].includes(role))
      return res.status(400).json({ error: 'Недопустимая роль' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Пароль минимум 8 символов' });
    const sid = await resolveStaffMemberId(role, staff_member_id, req.user.salonId);

    const hash = await bcrypt.hash(password, 12);
    const user = await db.one(
      `INSERT INTO users (salon_id,email,password_hash,name,role,position,staff_member_id,is_active,must_change_password,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,TRUE,$8) RETURNING id,name,email,role,position,staff_member_id,is_active,must_change_password,created_at`,
      [req.user.salonId, email.toLowerCase().trim(), hash, name, role, position||null, sid, req.user.userId]
    );
    res.json(user);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', auth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, position, is_active, password, staff_member_id } = req.body;
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
    if (position !== undefined) { updates.push(`position=$${i++}`); vals.push(position || null); }
    // staff_member_id: только если роль specialist (текущая или обновляемая); иначе → NULL.
    if (staff_member_id !== undefined || (role !== undefined && role !== 'specialist')) {
      // определяем эффективную роль после обновления для валидации
      let effectiveRole = role;
      if (effectiveRole === undefined) {
        const cur = await db.oneOrNone(`SELECT role FROM users WHERE id=$1 AND salon_id=$2`, [id, req.user.salonId]);
        effectiveRole = cur?.role || 'specialist';
      }
      const sid = await resolveStaffMemberId(effectiveRole, staff_member_id, req.user.salonId);
      updates.push(`staff_member_id=$${i++}`); vals.push(sid);
    }
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });
      const hash = await bcrypt.hash(password, 12);
      updates.push(`password_hash=$${i++}`, `must_change_password=$${i++}`);
      vals.push(hash, true);
    }
    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });

    vals.push(id, req.user.salonId);
    const user = await db.oneOrNone(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${i++} AND salon_id=$${i}
       RETURNING id,name,email,role,position,staff_member_id,is_active,must_change_password`,
      vals
    );
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
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
