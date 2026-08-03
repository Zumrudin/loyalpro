// ============================================================
// «Отдел заботы»: программы + дашборд (страница «Забота»)
// ============================================================
//
// Mounted at /api/care. owner/admin only (плюс глобальный гейт в
// routes/index.js: /api/care не входит в SPECIALIST/CASHIER_ALLOWED_PREFIXES).
//
//   GET    /programs              → программы с касаниями и счётчиками
//   POST   /programs              → создать (title, conditions, touches[])
//   PUT    /programs/:id          → обновить + заменить цепочку (upsert по id)
//   POST   /programs/:id/toggle   → вкл/выкл
//   DELETE /programs/:id          → удалить (enrollments и журнал уходят каскадом!)
//   GET    /enrollments           → дашборд (?status=&program_id=)
//   GET    /enrollments/:id/sends → журнал касаний прохождения
//   POST   /enrollments/:id/stop  → ручная остановка
//
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const { createLogger } = require('../logger');

const log = createLogger('Care');
const guard = [auth, requireRole('owner', 'admin')];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Статусы (enum'ов в БД нет — whitelist здесь):
const ENROLLMENT_STATUSES = ['active', 'completed', 'declined', 'escalated', 'superseded', 'stopped'];

// Валидация тела программы → { error? } | { value } (значения нормализованы).
function parseProgramBody(body) {
  const b = body || {};
  const title = String(b.title || '').trim();
  if (!title) return { error: 'Название обязательно' };
  if (title.length > 255) return { error: 'Название слишком длинное' };

  const c = b.conditions || {};
  const logic = c.logic === 'or' ? 'or' : 'and';
  const items = (Array.isArray(c.items) ? c.items : [])
    .filter(it => it && ['staff', 'category', 'service'].includes(it.type))
    .map(it => ({ type: it.type, ids: (Array.isArray(it.ids) ? it.ids : []).map(Number).filter(Number.isFinite) }))
    .filter(it => it.ids.length);

  const rawTouches = Array.isArray(b.touches) ? b.touches : [];
  if (!rawTouches.length) return { error: 'Нужно хотя бы одно касание' };
  if (rawTouches.length > 20) return { error: 'Слишком много касаний (макс 20)' };
  const touches = [];
  for (const [i, t] of rawTouches.entries()) {
    const intent = String((t && t.intentText) || '').trim();
    if (!intent) return { error: `Касание ${i + 1}: текст-заготовка пуст` };
    if (intent.length > 2000) return { error: `Касание ${i + 1}: заготовка слишком длинная` };
    const delay = Number(t.delayDays);
    if (!Number.isInteger(delay) || delay < 0 || delay > 730)
      return { error: `Касание ${i + 1}: задержка 0–730 дней` };
    const sendTime = TIME_RE.test(String(t.sendTime || '')) ? t.sendTime : '10:30';
    touches.push({
      id: Number.isInteger(Number(t.id)) ? Number(t.id) : null,
      title: String((t && t.title) || '').trim().slice(0, 255),
      delayDays: delay, sendTime, intentText: intent, sortOrder: i,
    });
  }
  return { value: { title, conditions: { logic, items }, touches } };
}

// GET /programs — список со вложенными касаниями и счётчиками.
router.get('/programs', guard, async (req, res) => {
  try {
    const rows = await db.any(
      `SELECT p.*,
              COALESCE((SELECT json_agg(json_build_object(
                  'id', t.id, 'title', t.title, 'delayDays', t.delay_days,
                  'sendTime', t.send_time, 'intentText', t.intent_text
                ) ORDER BY t.sort_order, t.id)
                FROM care_touches t WHERE t.program_id = p.id), '[]'::json) AS touches,
              (SELECT COUNT(*) FROM care_enrollments e
                WHERE e.program_id = p.id AND e.status = 'active') AS active_count,
              (SELECT COUNT(*) FROM care_touch_sends s
                 JOIN care_enrollments e ON e.id = s.enrollment_id
                WHERE e.program_id = p.id AND s.status = 'sent') AS sent_count
         FROM care_programs p
        WHERE p.salon_id = $1
        ORDER BY p.id DESC`,
      [req.user.salonId]);
    res.json({ programs: rows });
  } catch (e) { log.error(`programs list: ${e.message}`); res.status(500).json({ error: 'Ошибка загрузки программ' }); }
});

// POST /programs
router.post('/programs', guard, async (req, res) => {
  const parsed = parseProgramBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  try {
    const p = await db.one(
      `INSERT INTO care_programs (salon_id, title, conditions, created_by)
       VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
      [req.user.salonId, v.title, JSON.stringify(v.conditions), req.user.userId]);
    for (const t of v.touches) {
      await db.query(
        `INSERT INTO care_touches (salon_id, program_id, title, delay_days, send_time, intent_text, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.salonId, p.id, t.title, t.delayDays, t.sendTime, t.intentText, t.sortOrder]);
    }
    res.json({ id: p.id });
  } catch (e) { log.error(`program create: ${e.message}`); res.status(500).json({ error: 'Ошибка создания' }); }
});

// PUT /programs/:id — upsert касаний по id: удалённые из формы касания
// удаляются из таблицы. Порядок важен: их scheduled-отправки отменяются ДО
// DELETE (после ON DELETE SET NULL связь send→touch потеряна); журнал
// отправленных сохраняется (touch_id станет NULL, отсюда LEFT JOIN в /sends).
//
// v1: правка delay/времени СУЩЕСТВУЮЩЕГО касания НЕ пересчитывает
// scheduled_at уже спланированных строк care_touch_sends — у зачисленных
// клиентов цепочка остаётся как была спланирована при зачислении. Это
// ожидаемое поведение (пересчёт — осознанно за рамками v1).
router.put('/programs/:id', guard, async (req, res) => {
  const pid = parseInt(req.params.id, 10);
  if (!pid) return res.status(400).json({ error: 'bad id' });
  const parsed = parseProgramBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  try {
    const owned = await db.oneOrNone(
      `SELECT id FROM care_programs WHERE id=$1 AND salon_id=$2`, [pid, req.user.salonId]);
    if (!owned) return res.status(404).json({ error: 'Программа не найдена' });

    await db.query(
      `UPDATE care_programs SET title=$2, conditions=$3::jsonb, updated_at=NOW() WHERE id=$1`,
      [pid, v.title, JSON.stringify(v.conditions)]);

    const keepIds = [];
    for (const t of v.touches) {
      if (t.id) {
        const r = await db.query(
          `UPDATE care_touches SET title=$3, delay_days=$4, send_time=$5, intent_text=$6, sort_order=$7
            WHERE id=$1 AND program_id=$2`,
          [t.id, pid, t.title, t.delayDays, t.sendTime, t.intentText, t.sortOrder]);
        if (r.rowCount) { keepIds.push(t.id); continue; }
      }
      const ins = await db.one(
        `INSERT INTO care_touches (salon_id, program_id, title, delay_days, send_time, intent_text, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.user.salonId, pid, t.title, t.delayDays, t.sendTime, t.intentText, t.sortOrder]);
      keepIds.push(ins.id);
    }
    // Сначала cancel scheduled-отправок удаляемых касаний (пока touch_id жив)…
    await db.query(
      `UPDATE care_touch_sends SET status='cancelled', decision_reason='касание удалено из программы'
        WHERE status='scheduled' AND touch_id IN
          (SELECT id FROM care_touches WHERE program_id=$1 AND NOT (id = ANY($2::int[])))`,
      [pid, keepIds]);
    // …и только потом DELETE (ON DELETE SET NULL занулит touch_id в журнале).
    await db.query(
      `DELETE FROM care_touches WHERE program_id=$1 AND NOT (id = ANY($2::int[]))`,
      [pid, keepIds]);
    res.json({ ok: true });
  } catch (e) { log.error(`program update: ${e.message}`); res.status(500).json({ error: 'Ошибка сохранения' }); }
});

// POST /programs/:id/toggle
router.post('/programs/:id/toggle', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const r = await db.oneOrNone(
      `UPDATE care_programs SET is_enabled = NOT is_enabled, updated_at=NOW()
        WHERE id=$1 AND salon_id=$2 RETURNING is_enabled`,
      [id, req.user.salonId]);
    if (!r) return res.status(404).json({ error: 'Программа не найдена' });
    res.json({ isEnabled: r.is_enabled });
  } catch (e) { log.error(`program toggle: ${e.message}`); res.status(500).json({ error: 'Ошибка' }); }
});

// DELETE /programs/:id — enrollments и журнал уходят каскадом.
router.delete('/programs/:id', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const r = await db.query(
      `DELETE FROM care_programs WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]);
    if (!r.rowCount) return res.status(404).json({ error: 'Программа не найдена' });
    res.json({ ok: true });
  } catch (e) { log.error(`program delete: ${e.message}`); res.status(500).json({ error: 'Ошибка удаления' }); }
});

// GET /enrollments — дашборд «Клиенты» (?status=&program_id=).
router.get('/enrollments', guard, async (req, res) => {
  try {
    const cond = ['e.salon_id = $1'];
    const params = [req.user.salonId];
    if (req.query.status) {
      const status = String(req.query.status);
      if (!ENROLLMENT_STATUSES.includes(status))
        return res.status(400).json({ error: 'bad status' });
      params.push(status); cond.push(`e.status = $${params.length}`);
    }
    if (req.query.program_id) {
      const programId = parseInt(req.query.program_id, 10);
      if (!programId) return res.status(400).json({ error: 'bad program_id' });
      params.push(programId); cond.push(`e.program_id = $${params.length}`);
    }
    const rows = await db.any(
      `SELECT e.id, e.status, e.status_reason, e.phone, e.visit_at, e.staff_name,
              e.services, e.created_at, p.title AS program_title,
              COALESCE(c.name, '') AS client_name,
              (SELECT MIN(s.scheduled_at) FROM care_touch_sends s
                WHERE s.enrollment_id = e.id AND s.status = 'scheduled') AS next_touch_at,
              (SELECT MAX(s.sent_at) FROM care_touch_sends s
                WHERE s.enrollment_id = e.id AND s.status = 'sent') AS last_sent_at
         FROM care_enrollments e
         JOIN care_programs p ON p.id = e.program_id
         LEFT JOIN clients c ON c.id = e.client_id
        WHERE ${cond.join(' AND ')}
        ORDER BY e.created_at DESC
        LIMIT 300`,
      params);
    res.json({ enrollments: rows });
  } catch (e) { log.error(`enrollments list: ${e.message}`); res.status(500).json({ error: 'Ошибка загрузки' }); }
});

// GET /enrollments/:id/sends — журнал касаний прохождения.
// LEFT JOIN на care_touches обязателен: touch_id NULL после удаления касания.
router.get('/enrollments/:id/sends', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const rows = await db.any(
      `SELECT s.id, s.status, s.scheduled_at, s.sent_at, s.decision_reason, s.error,
              s.rendered_text, s.channel_used, t.title AS touch_title, t.delay_days
         FROM care_touch_sends s
         LEFT JOIN care_touches t ON t.id = s.touch_id
         JOIN care_enrollments e ON e.id = s.enrollment_id
        WHERE s.enrollment_id = $1 AND e.salon_id = $2
        ORDER BY s.scheduled_at ASC`,
      [id, req.user.salonId]);
    res.json({ sends: rows });
  } catch (e) { log.error(`enrollment sends: ${e.message}`); res.status(500).json({ error: 'Ошибка загрузки' }); }
});

// POST /enrollments/:id/stop — ручная остановка прохождения.
router.post('/enrollments/:id/stop', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const r = await db.oneOrNone(
      `UPDATE care_enrollments SET status='stopped',
              status_reason='остановлено вручную', updated_at=NOW()
        WHERE id=$1 AND salon_id=$2 AND status IN ('active','escalated') RETURNING id`,
      [id, req.user.salonId]);
    if (!r) return res.status(404).json({ error: 'Прохождение не найдено или уже завершено' });
    await db.query(
      `UPDATE care_touch_sends SET status='cancelled', decision_reason='остановлено вручную'
        WHERE enrollment_id=$1 AND status='scheduled'`, [r.id]);
    res.json({ ok: true });
  } catch (e) { log.error(`enrollment stop: ${e.message}`); res.status(500).json({ error: 'Ошибка' }); }
});

module.exports = router;
