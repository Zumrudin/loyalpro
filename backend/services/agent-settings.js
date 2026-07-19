'use strict';
// ============================================================
// Agent settings — настройки ИИ-агента и списки номеров (БД).
// Таблицы agent_settings / agent_number_rules (migrations.js).
// Решение допуска делегируется чистому services/agent-gate.
// ============================================================
const { db } = require('../db');
const { normalizePhoneKey, decideGate } = require('./agent-gate');

const DEFAULTS = { enabled: false, mode: 'all' };

async function getSettings(salonId) {
  if (!salonId) return { ...DEFAULTS };
  const row = await db.oneOrNone(
    'SELECT enabled, mode FROM agent_settings WHERE salon_id=$1', [salonId]
  );
  return row || { ...DEFAULTS };
}

async function updateSettings(salonId, { enabled, mode }) {
  const m = mode === 'whitelist' ? 'whitelist' : 'all';
  return db.one(
    `INSERT INTO agent_settings (salon_id, enabled, mode, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET enabled=$2, mode=$3, updated_at=NOW()
     RETURNING enabled, mode`,
    [salonId, !!enabled, m]
  );
}

async function listNumberRules(salonId, ruleType) {
  return db.any(
    `SELECT id, phone, rule_type, note, created_at
       FROM agent_number_rules
      WHERE salon_id=$1 AND ($2::text IS NULL OR rule_type=$2)
      ORDER BY created_at DESC`,
    [salonId, ruleType || null]
  );
}

async function addNumberRule(salonId, { phone, ruleType, note }) {
  const key = normalizePhoneKey(phone);
  if (!key) { const e = new Error('invalid phone'); e.code = 'BAD_PHONE'; throw e; }
  const type = ruleType === 'block' ? 'block' : 'allow';
  return db.one(
    `INSERT INTO agent_number_rules (salon_id, phone, rule_type, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (salon_id, phone, rule_type) DO UPDATE SET note=EXCLUDED.note
     RETURNING id, phone, rule_type, note, created_at`,
    [salonId, key, type, note || null]
  );
}

async function removeNumberRule(salonId, id) {
  await db.query('DELETE FROM agent_number_rules WHERE salon_id=$1 AND id=$2', [salonId, id]);
}

// Комбинированный допуск: настройки + списки → решение чистого гейта.
async function isAllowed(salonId, phone) {
  // Fail-closed без салона: не даём авто-ответ на неопознанный инстанс,
  // независимо от DEFAULTS (нет salon_id → нет контекста списков).
  if (!salonId) return { allow: false, reason: 'no-salon' };
  const settings = await getSettings(salonId);
  if (!settings.enabled) return { allow: false, reason: 'disabled' };
  const rules = await listNumberRules(salonId, null);
  const allow = rules.filter(r => r.rule_type === 'allow').map(r => r.phone);
  const block = rules.filter(r => r.rule_type === 'block').map(r => r.phone);
  return decideGate({ enabled: true, mode: settings.mode, allow, block, phone });
}

// ── Фильтр услуг агента ─────────────────────────────────────
async function getServiceMode(salonId) {
  if (!salonId) return 'all';
  const row = await db.oneOrNone(
    'SELECT service_mode FROM agent_settings WHERE salon_id=$1', [salonId]);
  return (row && row.service_mode === 'allowlist') ? 'allowlist' : 'all';
}

async function updateServiceMode(salonId, mode) {
  const m = mode === 'allowlist' ? 'allowlist' : 'all';
  const row = await db.one(
    `INSERT INTO agent_settings (salon_id, service_mode, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET service_mode=$2, updated_at=NOW()
     RETURNING service_mode`,
    [salonId, m]);
  return { serviceMode: row.service_mode };
}

async function listServiceRules(salonId) {
  return db.any(
    `SELECT id, yc_service_id, yc_staff_id, rule_type, note, created_at
       FROM agent_service_rules WHERE salon_id=$1 ORDER BY created_at DESC`,
    [salonId]);
}

async function addServiceRule(salonId, { ycServiceId, ycStaffId, ruleType, note }) {
  const svc = parseInt(ycServiceId, 10);
  if (!svc) { const e = new Error('bad service'); e.code = 'BAD_SERVICE'; throw e; }
  const staff = (ycStaffId === undefined || ycStaffId === null || ycStaffId === '')
    ? null : parseInt(ycStaffId, 10);
  // Пары поддерживают только deny (см. спеку); услуга целиком — allow|deny.
  let type = ruleType === 'allow' ? 'allow' : 'deny';
  if (staff !== null) type = 'deny';
  return db.one(
    `INSERT INTO agent_service_rules (salon_id, yc_service_id, yc_staff_id, rule_type, note)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (salon_id, yc_service_id, COALESCE(yc_staff_id,0), rule_type)
       DO UPDATE SET note=EXCLUDED.note
     RETURNING id, yc_service_id, yc_staff_id, rule_type, note, created_at`,
    [salonId, svc, staff, type, note || null]);
}

async function removeServiceRule(salonId, id) {
  await db.query('DELETE FROM agent_service_rules WHERE salon_id=$1 AND id=$2', [salonId, id]);
}

// Загрузчик правил → структуры для service-filter. Кидает при сбое БД.
async function loadServiceFilter(salonId) {
  const mode = await getServiceMode(salonId);
  const rows = await db.any(
    `SELECT yc_service_id, yc_staff_id, rule_type FROM agent_service_rules WHERE salon_id=$1`,
    [salonId]);
  const denyServices = new Set(), allowServices = new Set(), denyPairs = new Set();
  for (const r of rows) {
    const sid = String(r.yc_service_id);
    if (r.yc_staff_id === null || r.yc_staff_id === undefined) {
      if (r.rule_type === 'deny') denyServices.add(sid);
      else allowServices.add(sid);
    } else if (r.rule_type === 'deny') {
      denyPairs.add(`${sid}:${String(r.yc_staff_id)}`);
    }
  }
  return { mode, denyServices, allowServices, denyPairs };
}

// Fail-open обёртка: при любом сбое БД → пустой пермиссивный фильтр (mode 'all',
// пустые множества → видно всё). Транзиентный сбой не должен ломать агента.
async function loadServiceFilterSafe(salonId) {
  try { return await loadServiceFilter(salonId); }
  catch (e) {
    return { mode: 'all', denyServices: new Set(), allowServices: new Set(), denyPairs: new Set() };
  }
}

module.exports = {
  getSettings, updateSettings, listNumberRules, addNumberRule, removeNumberRule, isAllowed,
  getServiceMode, updateServiceMode, listServiceRules, addServiceRule, removeServiceRule,
  loadServiceFilter, loadServiceFilterSafe,
};
