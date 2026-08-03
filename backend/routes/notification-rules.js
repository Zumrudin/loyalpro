// ============================================================
// Автоуведомления: правила (вкладка на странице «Рассылки»)
// ============================================================
//
// Mounted at /api/notification-rules. owner/admin only.
//
//   GET    /               → правила салона со счётчиками sent/failed
//   GET    /dictionaries   → специалисты + категории/услуги для пикеров условий
//   POST   /               → создать правило
//   PUT    /:id            → обновить правило
//   POST   /:id/toggle     → включить/выключить
//   DELETE /:id            → удалить (журнал уходит каскадом)
//   GET    /:id/sends      → журнал отправок правила
//
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const { ycGet } = require('../services/yclients');
const { ALLOWED_CHANNELS } = require('../services/notifications');
const { createLogger } = require('../logger');

const log = createLogger('NotificationRules');

const guard = [auth, requireRole('owner', 'admin')];

// Валидация тела правила → { ok, error?, value? } (значения уже нормализованы).
function parseRuleBody(body) {
  const b = body || {};
  const title = String(b.title || '').trim();
  if (!title) return { error: 'Название обязательно' };
  if (title.length > 255) return { error: 'Название слишком длинное' };

  const template = String(b.messageTemplate || '').trim();
  if (!template) return { error: 'Текст сообщения пуст' };
  if (template.length > 4000) return { error: 'Сообщение слишком длинное (макс 4000 символов)' };

  const c = b.conditions || {};
  const logic = c.logic === 'or' ? 'or' : 'and';
  const rawItems = Array.isArray(c.items) ? c.items : [];
  const items = [];
  for (const it of rawItems) {
    if (!it || !['staff', 'category', 'service'].includes(it.type)) {
      return { error: 'Неизвестный тип условия' };
    }
    const ids = (Array.isArray(it.ids) ? it.ids : [])
      .map(v => parseInt(v, 10)).filter(Number.isFinite);
    if (ids.length) items.push({ type: it.type, ids });
  }

  const channels = (Array.isArray(b.channels) ? b.channels : [])
    .filter(ch => ALLOWED_CHANNELS.includes(ch));
  if (!channels.length) return { error: 'Выберите хотя бы один канал отправки' };

  return {
    value: {
      title,
      messageTemplate: template,
      conditions: { logic, items },
      channels,
      preferLastChannel: b.preferLastChannel !== false,
      isEnabled: b.isEnabled !== false,
    },
  };
}

// Список правил со счётчиками журнала.
router.get('/', guard, async (req, res) => {
  try {
    const items = await db.any(
      `SELECT r.*, u.name AS author_name,
              COALESCE(s.sent, 0)    AS sent_count,
              COALESCE(s.failed, 0)  AS failed_count,
              COALESCE(s.skipped, 0) AS skipped_count,
              COALESCE(s.pending, 0) AS pending_count
         FROM notification_rules r
         LEFT JOIN users u ON u.id = r.created_by
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE status = 'sent')    AS sent,
                  COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
                  COUNT(*) FILTER (WHERE status = 'skipped') AS skipped,
                  COUNT(*) FILTER (WHERE status = 'pending') AS pending
             FROM notification_sends ns WHERE ns.rule_id = r.id
         ) s ON TRUE
        WHERE r.salon_id = $1
        ORDER BY r.created_at DESC`,
      [req.user.salonId]
    );
    res.json({ items });
  } catch (e) {
    log.error(`list: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Справочники для пикеров условий: специалисты из staff_members, категории и
// услуги — из booking-каталога YClients (полный список, включая неактивные:
// записи в вебхуке ссылаются и на выключенные услуги).
router.get('/dictionaries', guard, async (req, res) => {
  try {
    const salon = await db.oneOrNone(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
         FROM salons WHERE id = $1`,
      [req.user.salonId]
    );
    if (!salon) return res.status(404).json({ error: 'salon not found' });

    const staff = await db.any(
      `SELECT yclients_staff_id AS id, name, specialization
         FROM staff_members
        WHERE salon_id = $1 AND is_active = TRUE
        ORDER BY name`,
      [req.user.salonId]
    );

    let categories = [];
    let services = [];
    const cid = salon.yclients_company_id;
    if (cid) {
      const [cats, svcs] = await Promise.all([
        ycGet(salon, `/service_categories/${cid}`).catch(() => []),
        ycGet(salon, `/services/${cid}`).catch(() => []),
      ]);
      categories = (Array.isArray(cats) ? cats : [])
        .map(c => ({ id: c.id, title: c.title }));
      services = (Array.isArray(svcs) ? svcs : [])
        .map(s => ({ id: s.id, title: s.title, category_id: s.category_id }));
    }

    res.json({ staff, categories, services, channels: ALLOWED_CHANNELS });
  } catch (e) {
    log.error(`dictionaries: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', guard, async (req, res) => {
  try {
    const { error, value } = parseRuleBody(req.body);
    if (error) return res.status(400).json({ error });
    const rule = await db.one(
      `INSERT INTO notification_rules
         (salon_id, title, is_enabled, conditions, message_template, channels, prefer_last_channel, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8)
       RETURNING *`,
      [req.user.salonId, value.title, value.isEnabled,
       JSON.stringify(value.conditions), value.messageTemplate,
       JSON.stringify(value.channels), value.preferLastChannel, req.user.id]
    );
    res.json({ ok: true, rule });
  } catch (e) {
    log.error(`create: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const { error, value } = parseRuleBody(req.body);
    if (error) return res.status(400).json({ error });
    const rule = await db.oneOrNone(
      `UPDATE notification_rules
          SET title=$3, is_enabled=$4, conditions=$5::jsonb, message_template=$6,
              channels=$7::jsonb, prefer_last_channel=$8, updated_at=NOW()
        WHERE id=$1 AND salon_id=$2
        RETURNING *`,
      [id, req.user.salonId, value.title, value.isEnabled,
       JSON.stringify(value.conditions), value.messageTemplate,
       JSON.stringify(value.channels), value.preferLastChannel]
    );
    if (!rule) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, rule });
  } catch (e) {
    log.error(`update: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/toggle', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const rule = await db.oneOrNone(
      `UPDATE notification_rules
          SET is_enabled = NOT is_enabled, updated_at = NOW()
        WHERE id=$1 AND salon_id=$2
        RETURNING *`,
      [id, req.user.salonId]
    );
    if (!rule) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, rule });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const r = await db.query(
      `DELETE FROM notification_rules WHERE id=$1 AND salon_id=$2`,
      [id, req.user.salonId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Журнал отправок правила (свежие сверху).
router.get('/:id/sends', guard, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const items = await db.any(
      `SELECT ns.id, ns.yclients_record_id, ns.phone, ns.status, ns.attempts,
              ns.error, ns.rendered_text, ns.routing, ns.channel_used,
              ns.created_at, ns.sent_at, c.name AS client_name
         FROM notification_sends ns
         LEFT JOIN clients c ON c.id = ns.client_id
        WHERE ns.rule_id = $1 AND ns.salon_id = $2
        ORDER BY ns.id DESC
        LIMIT $3`,
      [id, req.user.salonId, limit]
    );
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
