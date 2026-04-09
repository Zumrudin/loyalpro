const router = require('express').Router();
const { db } = require('../db');
const { auth, authOrQuery } = require('../middleware/auth');
const { SEGMENT_DEFS, SEG_MAP, SEG_CLIENTS_SQL, refreshSegments } = require('../services/segments');

router.get('/', auth, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const { rows: [meta] } = await db.query(
      `SELECT MAX(updated_at) AS last_updated, COUNT(*) AS total FROM client_segments WHERE salon_id=$1`,
      [salonId]
    );
    const staleMinutes = meta?.last_updated
      ? (Date.now() - new Date(meta.last_updated).getTime()) / 60000
      : Infinity;
    if (staleMinutes > 60 || !meta?.total) await refreshSegments(salonId);

    const { rows: stats } = await db.query(`
      SELECT cs.segment_key, COUNT(*) AS client_count,
             COALESCE(SUM(c.total_spent),0) AS total_spent,
             COALESCE(AVG(c.total_spent),0) AS avg_spent,
             COALESCE(AVG(c.visits_count),0) AS avg_visits,
             MAX(cs.return_window) AS return_window
      FROM client_segments cs
      JOIN clients c ON c.id=cs.client_id AND c.salon_id=cs.salon_id
      WHERE cs.salon_id=$1 GROUP BY cs.segment_key
    `, [salonId]);

    const { rows: [totals] } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE visits_count>0) AS with_visits,
             COUNT(*) AS all_clients, COALESCE(SUM(total_spent),0) AS total_revenue
      FROM clients WHERE salon_id=$1
    `, [salonId]);

    const statsMap = Object.fromEntries(stats.map(s => [s.segment_key, s]));
    const segments = SEGMENT_DEFS.map(def => {
      const s = statsMap[def.key] || {};
      const count = parseInt(s.client_count || 0);
      return {
        key: def.key, label: def.label, emoji: def.emoji, color: def.color,
        zone: def.zone, rank: def.rank, client_count: count,
        pct: Math.round(count / parseInt(totals.all_clients || 1) * 100 * 10) / 10,
        total_spent: Math.round(parseFloat(s.total_spent || 0)),
        avg_check: Math.round(parseFloat(s.avg_spent || 0)),
        avg_visits: Math.round(parseFloat(s.avg_visits || 0) * 10) / 10,
        return_window: parseInt(s.return_window || 0),
      };
    });

    const salon = await db.one('SELECT yclients_company_id FROM salons WHERE id=$1', [salonId]);
    res.json({ segments, totals: {
      all_clients: parseInt(totals.all_clients || 0),
      with_visits: parseInt(totals.with_visits || 0),
      total_revenue: Math.round(parseFloat(totals.total_revenue || 0)),
      return_window: segments.find(s => s.return_window > 0)?.return_window || 45,
      last_updated: meta?.last_updated || null,
      yclients_company_id: salon?.yclients_company_id || null,
    }});
  } catch(e) { console.error('[Segments]', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/:key/clients', auth, async (req, res) => {
  try {
    const { key } = req.params;
    const { page = 1, limit = 30, search = '' } = req.query;
    const salonId = req.user.salonId;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { rows: clients } = await db.query(SEG_CLIENTS_SQL + ' LIMIT $4 OFFSET $5', [salonId, key, search, limit, offset]);
    const { rows: [cnt] } = await db.query(
      `SELECT COUNT(*) AS total FROM client_segments cs JOIN clients c ON c.id=cs.client_id AND c.salon_id=cs.salon_id
       WHERE cs.salon_id=$1 AND cs.segment_key=$2 AND ($3='' OR c.name ILIKE '%'||$3||'%' OR c.phone ILIKE '%'||$3||'%')`,
      [salonId, key, search]
    );
    res.json({ clients, total: parseInt(cnt.total), page: parseInt(page), limit: parseInt(limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:key/export', authOrQuery, async (req, res) => {
  try {
    const { key } = req.params;
    const { search = '' } = req.query;
    const salonId = req.user.salonId;
    const label = SEG_MAP[key]?.label || key;
    const { rows } = await db.query(SEG_CLIENTS_SQL, [salonId, key, search]);

    const cols = ['Имя','Телефон','Email','Визитов','Сумма (₽)','Дней с последнего визита','Уровень лояльности','Последний визит'];
    const toCsv = (v) => { const s = v == null ? '' : String(v); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s; };
    const lines = [cols.join(',')];
    for (const c of rows) {
      lines.push([c.name||'', c.phone||'', c.email||'', c.visits_count||0,
        Math.round(parseFloat(c.total_spent||0)),
        c.days_since_visit != null ? Math.round(c.days_since_visit) : '',
        c.loyalty_level||'',
        c.last_visit_at ? new Date(c.last_visit_at).toLocaleDateString('ru') : '',
      ].map(toCsv).join(','));
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    const filename = encodeURIComponent(`segment_${label}_${new Date().toISOString().slice(0,10)}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/refresh', auth, async (req, res) => {
  try { res.json({ ok: true, ...(await refreshSegments(req.user.salonId)) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Blacklist (lives here because it feeds the blacklist segment)
router.put('/blacklist/:id', auth, async (req, res) => {
  try {
    await db.query('UPDATE clients SET is_blacklisted=$1 WHERE id=$2 AND salon_id=$3', [req.body.blacklisted, req.params.id, req.user.salonId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
