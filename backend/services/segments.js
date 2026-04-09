// ============================================================
// Segments Engine Service
// ============================================================
const { db } = require('../db');

const SEGMENT_DEFS = [
  { key: 'blacklist',         zone: 'blacklist',  rank: null, label: 'Чёрный список',      emoji: '🚫', color: '#6b7280' },
  { key: 'waiting_champion',  zone: 'waiting',    rank: 3,    label: 'Ожидаем чемпиона',  emoji: '⏳', color: '#8b5cf6' },
  { key: 'waiting_growing',   zone: 'waiting',    rank: 2,    label: 'Ожидаем растущего', emoji: '⏳', color: '#7c3aed' },
  { key: 'waiting_newcomer',  zone: 'waiting',    rank: 1,    label: 'Ожидаем новичка',   emoji: '⏳', color: '#6d28d9' },
  { key: 'post_visit',        zone: 'post_visit', rank: null, label: 'После визита',       emoji: '✅', color: '#10b981' },
  { key: 'champion',          zone: 'active',     rank: 3,    label: 'Чемпион',            emoji: '🏆', color: '#f59e0b' },
  { key: 'growing',           zone: 'active',     rank: 2,    label: 'Растущий',           emoji: '📈', color: '#3b82f6' },
  { key: 'newcomer',          zone: 'active',     rank: 1,    label: 'Новичок',            emoji: '🌱', color: '#06b6d4' },
  { key: 'champion_risk',     zone: 'risk',       rank: 3,    label: 'Чемпион в риске',   emoji: '⚠️', color: '#f97316' },
  { key: 'growing_risk',      zone: 'risk',       rank: 2,    label: 'Растущий в риске',  emoji: '⚠️', color: '#fb923c' },
  { key: 'newcomer_risk',     zone: 'risk',       rank: 1,    label: 'Новичок в риске',   emoji: '⚠️', color: '#fbbf24' },
  { key: 'sleeping_champion', zone: 'sleeping',   rank: 3,    label: 'Спящий чемпион',    emoji: '💤', color: '#6366f1' },
  { key: 'sleeping_growing',  zone: 'sleeping',   rank: 2,    label: 'Спящий растущий',   emoji: '💤', color: '#818cf8' },
  { key: 'sleeping_newcomer', zone: 'sleeping',   rank: 1,    label: 'Спящий новичок',    emoji: '💤', color: '#a5b4fc' },
  { key: 'no_visit',          zone: 'no_visit',   rank: 0,    label: 'Без визитов',        emoji: '👤', color: '#9ca3af' },
];

const SEG_MAP = Object.fromEntries(SEGMENT_DEFS.map(s => [s.key, s]));

// SQL for listing clients in a segment (used in both /clients and /export routes)
const SEG_CLIENTS_SQL = `
  SELECT
    c.id, c.yclients_client_id, c.name, c.phone, c.email,
    c.visits_count, c.total_spent, c.bonus_balance, c.loyalty_level, c.last_visit_at,
    cs.days_since_visit, cs.zone
  FROM client_segments cs
  JOIN clients c ON c.id = cs.client_id AND c.salon_id = cs.salon_id
  WHERE cs.salon_id = $1
    AND cs.segment_key = $2
    AND ($3 = '' OR c.name ILIKE '%'||$3||'%' OR c.phone ILIKE '%'||$3||'%')
  ORDER BY c.total_spent DESC NULLS LAST
`;

async function calcReturnWindow(salonId) {
  const { rows } = await db.query(`
    SELECT ROUND(AVG(gap_days))::int AS w FROM (
      SELECT client_id,
        (visit_date - LAG(visit_date) OVER (PARTITION BY client_id ORDER BY visit_date)) AS gap_days
      FROM records
      WHERE salon_id = $1
        AND status IN ('completed','confirmed')
        AND visit_date < CURRENT_DATE
        AND visit_date IS NOT NULL
    ) t
    WHERE gap_days > 1 AND gap_days < 365
  `, [salonId]);
  const w = rows[0]?.w;
  return (w && w > 7) ? w : 45;
}

function classifyClient(c, returnWindow) {
  if (c.is_blacklisted) return 'blacklist';
  const rank = c.visits_count >= 5 ? 3 : c.visits_count >= 3 ? 2 : c.visits_count >= 1 ? 1 : 0;
  if (rank === 0) return 'no_visit';
  if (c.has_future_appointment) {
    return rank === 3 ? 'waiting_champion' : rank === 2 ? 'waiting_growing' : 'waiting_newcomer';
  }
  const daysSince = c.days_since_visit ?? 9999;
  if (daysSince <= 7) return 'post_visit';
  if (daysSince <= returnWindow) return rank === 3 ? 'champion' : rank === 2 ? 'growing' : 'newcomer';
  if (daysSince <= returnWindow * 2.5) return rank === 3 ? 'champion_risk' : rank === 2 ? 'growing_risk' : 'newcomer_risk';
  return rank === 3 ? 'sleeping_champion' : rank === 2 ? 'sleeping_growing' : 'sleeping_newcomer';
}

async function refreshSegments(salonId) {
  const returnWindow = await calcReturnWindow(salonId);

  const { rows: clients } = await db.query(`
    SELECT
      c.id, c.name, c.phone, c.visits_count, c.total_spent,
      c.bonus_balance, c.loyalty_level,
      COALESCE(c.is_blacklisted, FALSE) AS is_blacklisted,
      COALESCE(
        MAX(r.visit_date) FILTER (
          WHERE r.visit_date < CURRENT_DATE
            AND r.status IN ('completed','confirmed','no_show')
        ),
        c.last_visit_at
      ) AS actual_last_visit,
      CASE
        WHEN MAX(r.visit_date) FILTER (WHERE r.visit_date < CURRENT_DATE AND r.status IN ('completed','confirmed','no_show')) IS NOT NULL
          THEN (CURRENT_DATE - MAX(r.visit_date) FILTER (WHERE r.visit_date < CURRENT_DATE AND r.status IN ('completed','confirmed','no_show')))::float
        WHEN c.last_visit_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (NOW() - c.last_visit_at))/86400
        ELSE NULL
      END AS days_since_visit,
      BOOL_OR(
        r.visit_date >= CURRENT_DATE
        AND r.status IN ('waiting','confirmed','completed')
      ) AS has_future_appointment,
      COALESCE(c.visits_count, 0) AS visits_count
    FROM clients c
    LEFT JOIN records r ON r.client_id = c.id AND r.salon_id = $1
    WHERE c.salon_id = $1
    GROUP BY c.id, c.name, c.phone, c.visits_count, c.last_visit_at,
             c.total_spent, c.bonus_balance, c.loyalty_level, c.is_blacklisted
  `, [salonId]);

  if (!clients.length) return { total: 0, returnWindow };

  const values = clients.map(c => {
    const segKey = classifyClient(c, returnWindow);
    const def = SEG_MAP[segKey];
    return {
      salon_id: salonId, client_id: c.id, segment_key: segKey,
      rank: def?.rank ?? null, zone: def?.zone ?? 'unknown',
      days_since_visit: c.days_since_visit != null ? Math.round(c.days_since_visit) : null,
      return_window: returnWindow,
    };
  });

  const BATCH = 500;
  for (let i = 0; i < values.length; i += BATCH) {
    const batch = values.slice(i, i + BATCH);
    const placeholders = batch.map((_, j) => {
      const base = j * 7;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},NOW())`;
    }).join(',');
    const params = batch.flatMap(v => [v.salon_id, v.client_id, v.segment_key, v.rank, v.zone, v.days_since_visit, v.return_window]);
    await db.query(`
      INSERT INTO client_segments
        (salon_id, client_id, segment_key, rank, zone, days_since_visit, return_window, updated_at)
      VALUES ${placeholders}
      ON CONFLICT (salon_id, client_id) DO UPDATE SET
        segment_key      = EXCLUDED.segment_key,
        rank             = EXCLUDED.rank,
        zone             = EXCLUDED.zone,
        days_since_visit = EXCLUDED.days_since_visit,
        return_window    = EXCLUDED.return_window,
        updated_at       = NOW()
    `, params);
  }

  await db.query(`
    DELETE FROM client_segments
    WHERE salon_id = $1
      AND client_id NOT IN (SELECT id FROM clients WHERE salon_id = $1)
  `, [salonId]);

  return { total: values.length, returnWindow };
}

module.exports = {
  SEGMENT_DEFS, SEG_MAP, SEG_CLIENTS_SQL,
  calcReturnWindow, classifyClient, refreshSegments,
};
