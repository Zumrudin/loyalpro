'use strict';
const { configured, response } = require('./protocol');
const { createStore } = require('./store');
const { createYclients } = require('./yclients');
const { createMirror } = require('./mirror');
const { createApi } = require('./api');
const { handle } = require('./dialog');
const logger = require('../../logger').createLogger('MaxLoyalty');
const LOCK_NAMESPACE = 18342;

async function processEvent(event, { store, crm, api, mirror }) {
  if (event.status === 'pending') {
    const state = await store.session(event.user_id);
    let result;
    try { result = await handle(event.payload, state, { store, crm, ...mirror }); }
    catch {
      if (event.attempts < 5) throw new Error('MAX loyalty processing retry');
      result = { state, reply: response('Сервис программы лояльности временно недоступен. Повторите попытку позже или обратитесь к администратору.') };
    }
    await store.saveReply(event, result.state, result.reply);
    return; // Reply is already durable; send it on the next iteration.
  }
  await api.send(event.user_id, event.reply);
  await store.done(event);
}

async function tick({ pool, config, makeCrm = createYclients, makeApi = createApi, makeMirror = createMirror }) {
  if (!configured(config)) return;
  const client = await pool.connect();
  let locked = false;
  // Session advisory lock, not a long SQL transaction over HTTP calls. Another
  // process cannot perform CRM writes for this salon; effects commit before I/O.
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1,$2) AS locked', [LOCK_NAMESPACE, config.salonId])).rows[0].locked;
    if (!locked) return;
    const store = createStore(client, config.salonId);
    const salon = await store.salon();
    if (!salon || salon.is_active === false) throw new Error('MAX salon unavailable');
    const crm = makeCrm(salon), api = makeApi(config.token), mirror = makeMirror(store, config.salonId);
    for (let i = 0; i < 20; i++) {
      const event = await store.next();
      if (!event) break;
      try { await processEvent(event, { store, crm, api, mirror }); }
      catch {
        const failed = event.attempts >= 5;
        await store.retry(event, failed);
        logger.warn(`event=${event.id} phase=${event.status} result=${failed ? 'failed' : 'retry'}`);
      }
    }
    // Keep deduplication keys, remove questionnaire contents from expired sessions.
    await client.query(`UPDATE max_loyalty_sessions SET state='{}',updated_at=NOW()
      WHERE salon_id=$1 AND state->>'step' IS DISTINCT FROM 'ready'
        AND state<>'{}'::jsonb AND updated_at<NOW()-INTERVAL '1 day'`, [config.salonId]);
  } finally {
    let destroy = false;
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1,$2)', [LOCK_NAMESPACE, config.salonId]); }
      catch { destroy = true; }
    }
    client.release(destroy);
  }
}

let timer = null, running = false;
function start() {
  const config = require('../../config').MAX_LOYALTY_BOT;
  if (!config?.enabled || timer) return;
  if (!configured(config)) { logger.error('Bot disabled: incomplete MAX loyalty configuration'); return; }
  const pool = require('../../db').pool;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick({ pool, config }); }
    catch { logger.error('Worker tick failed'); }
    finally { running = false; }
  };
  timer = setInterval(run, 1000);
  timer.unref();
  void run();
}
module.exports = { start, tick, processEvent, LOCK_NAMESPACE };
