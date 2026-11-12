'use strict';
// Local cache of YClients reference data and staff schedules for the journal.
const { db } = require('../../db');
const yc = require('./yclients');
const { isAdministrator } = require('./model');
const logger = require('../../logger').createLogger('JournalReference');

const KINDS = ['staff', 'services', 'resources', 'accounts'];
const PATHS = {
  staff: cid => `/staff/${cid}`,
  services: cid => `/company/${cid}/services/`,
  resources: cid => `/resources/${cid}`,
  accounts: cid => `/accounts/${cid}`,
};
const UPSERT_REF = `INSERT INTO journal_reference_cache(salon_id,kind,payload,fetched_at) VALUES($1,$2,$3,NOW())
  ON CONFLICT (salon_id,kind) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()`;
const UPSERT_DAY = `INSERT INTO journal_staff_schedule(salon_id,staff_id,date,is_working,slots,fetched_at) VALUES($1,$2,$3,$4,$5,NOW())
  ON CONFLICT (salon_id,staff_id,date) DO UPDATE SET is_working=EXCLUDED.is_working, slots=EXCLUDED.slots, fetched_at=NOW()`;

async function getReference(salonId, kind) {
  const row = await db.oneOrNone('SELECT payload FROM journal_reference_cache WHERE salon_id=$1 AND kind=$2', [salonId, kind]);
  return row ? row.payload : null;
}

async function refreshReference(salon) {
  const cid = salon.yclients_company_id;
  const ok = [], failed = [];
  for (const kind of KINDS) {
    try {
      const value = await yc.list(salon, PATHS[kind](cid));
      await db.query(UPSERT_REF, [salon.id, kind, JSON.stringify(value)]);
      ok.push(kind);
    } catch (e) {
      failed.push(kind);
      logger.warn(`salon ${salon.id} kind ${kind} refresh failed: ${e?.status || e?.code || 'error'}`);
    }
  }
  return { ok, failed };
}

async function refreshSchedules(salon, from, to) {
  const cached = await getReference(salon.id, 'staff');
  const staff = (Array.isArray(cached) ? cached : []).filter(s => s && !s.fired && !isAdministrator(s));
  if (!staff.length) return { staff: 0 };
  const cid = salon.yclients_company_id;
  let days = 0, failed = 0;
  for (const s of staff) {
    try {
      const list = await yc.list(salon, `/schedule/${cid}/${s.id}/${from}/${to}`);
      for (const day of list) {
        await db.query(UPSERT_DAY, [
          salon.id, s.id, String(day.date).slice(0, 10),
          [true, 1, '1'].includes(day.is_working),
          JSON.stringify(Array.isArray(day.slots) ? day.slots : []),
        ]);
        days++;
      }
    } catch (e) {
      failed++;
      logger.warn(`salon ${salon.id} staff ${s.id} schedule refresh failed: ${e?.status || e?.code || 'error'}`);
    }
  }
  return { staff: staff.length, days, failed };
}

async function getSchedule(salonId, staffId, date) {
  const row = await db.oneOrNone(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, is_working, slots FROM journal_staff_schedule
     WHERE salon_id=$1 AND staff_id=$2 AND date=$3`, [salonId, staffId, date]);
  if (!row) return null;
  return [{ date: row.date, is_working: row.is_working ? 1 : 0, slots: row.slots }];
}

async function getBonusPercent(salonId) {
  return (await getReference(salonId, 'bonus_rule'))?.percent ?? null;
}

async function learnBonusPercent(salonId, sale) {
  try {
    const m = (sale?.payment_methods || []).find(x => x.slug === 'loyalty_card');
    const applicable = Number(m?.applicable_amount);
    if (!(applicable > 0) || !(Number(m?.loyalty_card?.balance) > applicable)) return;
    const total = (sale?.state?.items || []).reduce((a, i) => a + (Number(i.cost_to_pay_total) || 0), 0);
    if (!(total > 0)) return;
    const percent = Math.round(applicable * 100 / total);
    if (percent < 1 || percent > 100) return;
    await db.query(UPSERT_REF, [salonId, 'bonus_rule', JSON.stringify({ percent })]);
  } catch (e) {
    logger.warn(`salon ${salonId} bonus rule learning failed: ${e?.code || 'error'}`);
  }
}

module.exports = { KINDS, refreshReference, refreshSchedules, getReference, getSchedule, getBonusPercent, learnBonusPercent };
