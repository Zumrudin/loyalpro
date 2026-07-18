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

module.exports = {
  getSettings, updateSettings, listNumberRules, addNumberRule, removeNumberRule, isAllowed,
};
