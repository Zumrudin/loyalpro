'use strict';

const SELECTABLE = ['gpt', 'claude', 'polza'];
const REASONS = {
  model_failed: 'Модель на dev вернула ошибку или не ответила вовремя',
  bridge_unavailable: 'Мост на dev недоступен или отклонил запрос',
};

function createStore({ db, config }) {
  const initial = config.AGENT_PROVIDER === 'codex-relay' ? 'gpt' : config.AGENT_PROVIDER;
  const choices = {
    gpt: { title: 'GPT-6 Sol', model: 'gpt-6-sol', channel: 'Мост dev · подписка ChatGPT' },
    claude: { title: 'Claude Sonnet', model: 'claude-sonnet', channel: 'Мост dev · подписка Claude Code' },
    polza: { title: 'Польза', model: config.POLZA_CHAT_MODEL, channel: 'API polza.ai' },
    anthropic: { title: 'Anthropic', channel: 'API Anthropic' },
    aitunnel: { title: 'AI Tunnel', channel: 'API AI Tunnel' },
    codex: { title: 'Codex (dev)', model: 'gpt-6-sol', channel: 'Локальная подписка ChatGPT' },
  };
  const defaults = () => ({ active: initial, revision: '0', model: null, health: 'unverified', last_auto: null });
  async function get(salonId) {
    return await db.oneOrNone('SELECT * FROM agent_model_routing WHERE salon_id=$1', [salonId]) || defaults();
  }
  async function ensure(salonId) {
    await db.query(`INSERT INTO agent_model_routing (salon_id, active) VALUES ($1,$2)
      ON CONFLICT (salon_id) DO NOTHING`, [salonId, initial]);
  }
  async function transition(salonId, before, active, reason = null) {
    await ensure(salonId);
    // CAS: neither another failing dialog nor an old result can undo a manual switch.
    const row = await db.oneOrNone(`UPDATE agent_model_routing SET active=$3, revision=revision+1,
      model=NULL, health='unverified', last_success_at=NULL, updated_at=NOW(),
      last_auto=CASE WHEN $4::text IS NULL THEN last_auto ELSE jsonb_build_object(
        'revision', (revision+1)::text, 'from', active, 'to', $3::text,
        'reason', $4::text, 'at', NOW()) END
      WHERE salon_id=$1 AND revision=$2 RETURNING *`, [salonId, before.revision, active, reason]);
    return row;
  }
  async function outcome(salonId, before, health, model = null) {
    await ensure(salonId);
    await db.query(`UPDATE agent_model_routing SET health=$3,
      model=COALESCE($4,model), last_success_at=CASE WHEN $3='ok' THEN NOW() ELSE last_success_at END
      WHERE salon_id=$1 AND revision=$2 AND active=$5`, [salonId, before.revision, health, model, before.active]);
  }
  async function status(salonId, userId) {
    const row = await get(salonId);
    const read = await db.oneOrNone(`SELECT revision FROM agent_model_notice_reads
      WHERE salon_id=$1 AND user_id=$2`, [salonId, userId]);
    const notice = row.last_auto && BigInt(row.last_auto.revision) > BigInt(read?.revision || 0)
      ? { ...row.last_auto, reason: REASONS[row.last_auto.reason],
        fromTitle: choices[row.last_auto.from]?.title, toTitle: choices[row.last_auto.to]?.title } : null;
    return { active: row.active, revision: row.revision, health: row.health,
      model: row.model || choices[row.active]?.model || row.active,
      channel: choices[row.active]?.channel, lastSuccessAt: row.last_success_at || null,
      notice, choices: SELECTABLE.map(id => ({ id, ...choices[id] })) };
  }
  async function manual(salonId, active, revision) {
    if (!SELECTABLE.includes(active) || !/^\d{1,18}$/.test(String(revision))) {
      throw Object.assign(new Error('Invalid model selection'), { code: 'BAD_SELECTION' });
    }
    const row = await transition(salonId, { revision }, active);
    if (!row) throw Object.assign(new Error('Selection changed'), { code: 'CONFLICT' });
  }
  async function acknowledge(salonId, userId, revision) {
    if (!/^\d{1,18}$/.test(String(revision))) throw Object.assign(new Error('Invalid notice'), { code: 'BAD_SELECTION' });
    // A stale screen may acknowledge only its own event, never a newer switch.
    await db.query(`INSERT INTO agent_model_notice_reads (salon_id,user_id,revision)
      SELECT salon_id,$2,$3::bigint FROM agent_model_routing
      WHERE salon_id=$1 AND last_auto->>'revision'=$3::text
      ON CONFLICT (salon_id,user_id) DO UPDATE SET revision=GREATEST(agent_model_notice_reads.revision,EXCLUDED.revision)`,
    [salonId, userId, String(revision)]);
  }
  return { get, transition, outcome, status, manual, acknowledge };
}
let singleton;
function getStore() {
  if (!singleton) singleton = createStore({ db: require('../../db').db, config: require('../../config') });
  return singleton;
}
module.exports = { createStore, getStore };
