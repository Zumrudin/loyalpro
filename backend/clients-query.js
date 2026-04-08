'use strict';

const CLIENT_SORT_MAP = {
  name:          'c.name',
  phone:         'c.phone',
  loyalty_level: 'c.loyalty_level',
  bonus_balance: 'c.bonus_balance',
  total_spent:   'c.total_spent',
  visits_count:  'c.visits_count',
  last_visit_at: 'c.last_visit_at',
};

/**
 * Builds the WHERE clause, ORDER BY, and parameter list for GET /api/clients.
 * Returns { orderCol, orderDir, whereSql, params, nextIdx }
 */
function buildClientsQuery(query, salonId) {
  const {
    search, level, status,
    sort = 'last_visit_at', sort_dir = 'desc',
    name, phone,
    bonus_min, bonus_max,
    spent_min, spent_max,
    visits_min, visits_max,
    last_visit_from, last_visit_to,
  } = query;

  const orderCol = CLIENT_SORT_MAP[sort] || 'c.last_visit_at';
  const orderDir = sort_dir === 'asc' ? 'ASC' : 'DESC';

  const where = ['c.salon_id=$1'];
  const params = [salonId];
  let i = 2;

  if (search) {
    where.push(`(c.name ILIKE $${i} OR c.phone ILIKE $${i})`);
    params.push('%' + search + '%'); i++;
  }
  if (name)  { where.push(`c.name ILIKE $${i}`);  params.push('%' + name + '%');  i++; }
  if (phone) { where.push(`c.phone ILIKE $${i}`); params.push('%' + phone + '%'); i++; }
  if (level) { where.push(`c.loyalty_level=$${i}`); params.push(level); i++; }

  if (status === 'sleeping') where.push(`c.last_visit_at < NOW()-INTERVAL '60 days' AND c.visits_count>0`);
  if (status === 'risk')     where.push(`c.last_visit_at < NOW()-INTERVAL '30 days' AND c.last_visit_at > NOW()-INTERVAL '60 days'`);
  if (status === 'new')      where.push(`c.created_at > NOW()-INTERVAL '30 days'`);

  if (bonus_min != null && bonus_min !== '') { where.push(`c.bonus_balance >= $${i}`); params.push(parseFloat(bonus_min)); i++; }
  if (bonus_max != null && bonus_max !== '') { where.push(`c.bonus_balance <= $${i}`); params.push(parseFloat(bonus_max)); i++; }
  if (spent_min != null && spent_min !== '') { where.push(`c.total_spent >= $${i}`); params.push(parseFloat(spent_min)); i++; }
  if (spent_max != null && spent_max !== '') { where.push(`c.total_spent <= $${i}`); params.push(parseFloat(spent_max)); i++; }
  if (visits_min != null && visits_min !== '') { where.push(`c.visits_count >= $${i}`); params.push(parseInt(visits_min)); i++; }
  if (visits_max != null && visits_max !== '') { where.push(`c.visits_count <= $${i}`); params.push(parseInt(visits_max)); i++; }
  if (last_visit_from) { where.push(`c.last_visit_at >= $${i}::date`); params.push(last_visit_from); i++; }
  if (last_visit_to)   { where.push(`c.last_visit_at < $${i}::date + INTERVAL '1 day'`); params.push(last_visit_to); i++; }

  return { orderCol, orderDir, whereSql: where.join(' AND '), params, nextIdx: i };
}

module.exports = { buildClientsQuery, CLIENT_SORT_MAP };
