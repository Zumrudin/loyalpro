'use strict';
// Month calendar of the journal (spec 2026-11-12 §3.1): records per day from
// the mirror and working staff from the cached schedules — no YClients.
// A day with NO schedule rows at all (cache does not cover the date) has
// density null: the frontend draws it neutrally instead of «full».
const { db } = require('../../db');
const m = require('./model');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// A day is «full» at 8 visits per working master (owner's rule of thumb).
const VISITS_PER_MASTER = 8;

function monthRange(month) {
  if (typeof month !== 'string' || !MONTH.test(month)) m.fail('Укажите месяц в формате ГГГГ-ММ.');
  const [y, mo] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, '0')}`, days };
}
function density(records, workingStaff) {
  const n = Number(records) || 0, staff = Number(workingStaff) || 0;
  if (n <= 0) return 0;
  // Nobody on the schedule but records exist: count as one master, not as «full».
  const share = n / (Math.max(staff, 1) * VISITS_PER_MASTER);
  return share < 1 / 3 ? 1 : share < 2 / 3 ? 2 : 3;
}
function monthDays(month, recordRows, staffRows) {
  const { days } = monthRange(month);
  const rec = new Map((recordRows || []).map(r => [String(r.date), Number(r.n) || 0]));
  const st = new Map((staffRows || []).map(r => [String(r.date), { working: Number(r.n) || 0, total: r.total == null ? Number(r.n) || 0 : Number(r.total) || 0 }]));
  return Array.from({ length: days }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const records = rec.get(date) || 0, row = st.get(date);
    const workingStaff = row ? row.working : 0;
    return { date, records, workingStaff, density: row && row.total > 0 ? density(records, workingStaff) : null };
  });
}
const RECORDS_SQL = `SELECT to_char(visit_date,'YYYY-MM-DD') AS date, count(*)::int AS n FROM records
  WHERE salon_id=$1 AND visit_date BETWEEN $2::date AND $3::date AND status<>'deleted'
    AND COALESCE(raw_payload->>'deleted','false') NOT IN ('true','1')
  GROUP BY 1`;
const STAFF_SQL = `SELECT to_char(date,'YYYY-MM-DD') AS date, count(*) FILTER (WHERE is_working)::int AS n, count(*)::int AS total FROM journal_staff_schedule
  WHERE salon_id=$1 AND date BETWEEN $2::date AND $3::date
  GROUP BY 1`;
async function month(salonId, monthKey) {
  const r = monthRange(monthKey);
  const [records, staff] = await Promise.all([
    db.any(RECORDS_SQL, [salonId, r.from, r.to]),
    db.any(STAFF_SQL, [salonId, r.from, r.to]),
  ]);
  return { month: monthKey, days: monthDays(monthKey, records, staff) };
}
module.exports = { monthRange, density, monthDays, month, RECORDS_SQL, STAFF_SQL, VISITS_PER_MASTER };
