'use strict';
const { db } = require('../../db');

async function enqueue(salonId, event) {
  await db.query(`INSERT INTO max_loyalty_events(salon_id,event_key,user_id,payload)
    VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(salon_id,event_key) DO NOTHING`,
  [salonId, event.key, event.userId, JSON.stringify(event)]);
}

// All queries use the worker's dedicated connection, under its salon lock.
function createStore(client, salonId) {
  const q = (sql, p) => client.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0] || null;
  return {
    q,
    salon: () => one('SELECT * FROM salons WHERE id=$1', [salonId]),
    session: async userId => {
      const r = await one('SELECT state,updated_at FROM max_loyalty_sessions WHERE salon_id=$1 AND user_id=$2', [salonId, userId]);
      if (!r) return {};
      // Expire incomplete questionnaires; completed identity links survive restarts.
      if (r.state.step !== 'ready' && Date.now() - new Date(r.updated_at).getTime() > 86400000) return {};
      return r.state;
    },
    next: () => one(`SELECT e.* FROM max_loyalty_events e
      WHERE e.salon_id=$1 AND e.status IN ('pending','reply') AND e.next_attempt_at<=NOW()
        AND (e.status<>'reply' OR NOT EXISTS(SELECT 1 FROM max_loyalty_events sent
          WHERE sent.salon_id=e.salon_id AND sent.user_id=e.user_id AND sent.status='done'
            AND sent.updated_at>NOW()-INTERVAL '600 milliseconds'))
        AND NOT EXISTS(SELECT 1 FROM max_loyalty_events p WHERE p.salon_id=e.salon_id
          AND p.user_id=e.user_id AND p.id<e.id AND p.status IN ('pending','reply'))
      ORDER BY e.id LIMIT 1`, [salonId]),
    registration: async p => (await one('SELECT state FROM max_loyalty_registrations WHERE salon_id=$1 AND phone=$2', [salonId, p]))?.state || {},
    saveRegistration: (p, state) => q(`INSERT INTO max_loyalty_registrations(salon_id,phone,state)
      VALUES($1,$2,$3::jsonb) ON CONFLICT(salon_id,phone) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()`,
    [salonId, p, JSON.stringify(state)]),
    async saveReply(event, state, reply) {
      await q('BEGIN');
      try {
        if (state.phone) {
          // A newly verified MAX account replaces the old link for this phone.
          await q(`UPDATE max_loyalty_sessions SET state='{}',updated_at=NOW()
            WHERE salon_id=$1 AND user_id<>$2 AND state->>'phone'=$3`,
          [salonId, event.user_id, state.phone]);
        }
        await q(`INSERT INTO max_loyalty_sessions(salon_id,user_id,state) VALUES($1,$2,$3::jsonb)
          ON CONFLICT(salon_id,user_id) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()`,
        [salonId, event.user_id, JSON.stringify(state)]);
        await q(`UPDATE max_loyalty_events SET status=$3,reply=$4::jsonb,payload=NULL,attempts=0,updated_at=NOW()
          WHERE salon_id=$1 AND id=$2`, [salonId, event.id, reply ? 'reply' : 'done', JSON.stringify(reply)]);
        await q('COMMIT');
      } catch (e) { await q('ROLLBACK'); throw e; }
    },
    done: event => q(`UPDATE max_loyalty_events SET status='done',reply=NULL,payload=NULL,updated_at=NOW()
      WHERE salon_id=$1 AND id=$2`, [salonId, event.id]),
    retry: (event, failed = false) => q(`UPDATE max_loyalty_events SET
      status=CASE WHEN $3 THEN 'failed' ELSE status END, attempts=attempts+1,
      payload=CASE WHEN $3 THEN NULL ELSE payload END, reply=CASE WHEN $3 THEN NULL ELSE reply END,
      next_attempt_at=NOW()+make_interval(secs => $4),updated_at=NOW() WHERE salon_id=$1 AND id=$2`,
    [salonId, event.id, failed, Math.min(300, 5 * 2 ** event.attempts)]),
  };
}
module.exports = { enqueue, createStore };
