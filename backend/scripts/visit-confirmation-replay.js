'use strict';
// Read-only replay. Raw message content and dialog keys never leave memory.
// Usage: node scripts/visit-confirmation-replay.js YYYY-MM-DD salonId [--prod]
require('dotenv').config();
const { Client } = require('pg');
const { DIALOG_KEY_SQL } = require('../services/chat');
const rule = require('../services/agent/visit-confirmation');
const policy = require('../services/agent/followup-policy');
const queue = require('../services/agent/followup-queue');
const assert = require('node:assert/strict');
const [day, tenant, target] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !/^[1-9]\d*$/.test(tenant || '')
    || (target && target !== '--prod')) throw new Error('Expected date, salonId, optional --prod');
function label(r) {
  if (r.direction === 'outgoing') {
    if (r.authored_by === 'system' && rule.isReminder(r.text)) return 'system_reminder';
    if (r.authored_by === 'system' && rule.isAcknowledgement(r.text)) return 'system_ack';
    return `${r.authored_by || 'unknown'}_outgoing${/\?/.test(r.text || '') ? '_question' : ''}`;
  }
  if (rule.isPureConfirmation(r.text)) return 'pure_confirmation';
  const s = String(r.text || '').toLowerCase();
  if (/перен[ео]|отмен/.test(s)) return 'change_request';
  if (/\?/.test(s)) return 'question';
  if (/спасибо|благодар/.test(s)) return 'thanks_or_mixed';
  if (/подтвер|буду|приду|да/.test(s)) return 'confirmation_or_mixed';
  return 'other_incoming';
}
(async () => {
  const url = new URL(process.env.DATABASE_URL);
  if (target === '--prod') url.pathname = '/loyalpro';
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query("SET LOCAL statement_timeout = '15s'");
    const { rows } = await c.query(`
      SELECT ${DIALOG_KEY_SQL} AS dialog_key, direction, authored_by, text,
        COALESCE(msg_ts, EXTRACT(EPOCH FROM (created_at AT TIME ZONE 'Europe/Moscow'))::bigint) AS msg_ts,
        (COALESCE(to_timestamp(msg_ts), created_at AT TIME ZONE 'Europe/Moscow')
          AT TIME ZONE 'Europe/Moscow')::date = $2::date AS today
      FROM chatpush_messages
      WHERE salon_id=$1
        AND COALESCE(to_timestamp(msg_ts), created_at AT TIME ZONE 'Europe/Moscow')
          >= (($2::date - 2)::timestamp AT TIME ZONE 'Europe/Moscow')
        AND COALESCE(to_timestamp(msg_ts), created_at AT TIME ZONE 'Europe/Moscow')
          < (($2::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow')
      ORDER BY COALESCE(msg_ts, EXTRACT(EPOCH FROM (created_at AT TIME ZONE 'Europe/Moscow'))::bigint), id`, [Number(tenant), day]);
    await c.query('ROLLBACK');
    const groups = new Map();
    for (const r of rows) { if (!groups.has(r.dialog_key)) groups.set(r.dialog_key, []); groups.get(r.dialog_key).push(r); }
    const totals = { dialogs: 0, messages: 0, agentTurns: 0, suppressedTurns: 0, ackExchanges: 0, mockedQueueChecks: 0 };
    const scenarios = [];
    const turnShapes = new Map();
    const suppressedReasons = {};
    for (const rs of groups.values()) {
      if (!rs.some(r => r.today)) continue;
      totals.dialogs++;
      totals.messages += rs.filter(r => r.today).length;
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        if (!r.today) continue;
        const snapshot = rs.slice(Math.max(0, i - 39), i + 1);
        const complete = rule.conversationComplete(snapshot);
        const stopReason = policy.stopReason(snapshot);
        if (r.authored_by === 'agent') {
          totals.agentTurns++;
          if (stopReason) {
            totals.suppressedTurns++;
            suppressedReasons[stopReason] = (suppressedReasons[stopReason] || 0) + 1;
          }
          // Real scheduler, in-memory DB only. Never pass the production
          // connection to application code. All mutations below are stubs.
          const writes = [];
          const scheduled = await queue.schedule(17, 'synthetic-replay-dialog', {},
            { followupDelay1Min: 20, followupDelay2Min: 60 }, {
              db: {
                any: async () => rs.slice(Math.max(0, i - 39), i + 1).reverse(),
                query: async sql => { writes.push(sql); return { rowCount: 1 }; },
              },
            });
          assert.equal(scheduled, !stopReason);
          assert.equal(writes.some(sql => /INSERT INTO agent_followups/.test(sql)), !stopReason);
          totals.mockedQueueChecks++;
          const shape = rs.slice(Math.max(0, i - 3), i + 1).map(label).join(' > ');
          const k = `${stopReason || 'unchanged'}: ${shape}`;
          turnShapes.set(k, (turnShapes.get(k) || 0) + 1);
        }
        if (r.authored_by === 'system' && rule.isAcknowledgement(r.text)) {
          totals.ackExchanges++;
          const reminder = rs.slice(0, i).findLastIndex(x => x.authored_by === 'system' && rule.isReminder(x.text));
          const start = reminder >= 0 ? reminder : Math.max(0, i - 3);
          const after = rs.slice(i + 1).filter(x => x.today);
          scenarios.push({ case: scenarios.length + 1, completeAtAck: complete,
            before: rs.slice(start, i + 1).map(label), after: after.map(label),
            finalComplete: rule.conversationComplete(rs.slice(-40)),
            reminderAgeMinutes: reminder >= 0 ? Math.round((r.msg_ts - rs[reminder].msg_ts) / 60) : null });
        }
      }
    }
    console.log(JSON.stringify({ day, totals, suppressedReasons, scenarios, turnShapes: Object.fromEntries(turnShapes) }, null, 2));
  } finally { await c.end(); }
})().catch(() => { console.error('Read-only replay failed; details suppressed to protect data'); process.exitCode = 1; });
