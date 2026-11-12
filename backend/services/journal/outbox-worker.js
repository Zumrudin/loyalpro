'use strict';
// Journal outbox worker (local-first, spec 2026-11-10 §2.3–2.4). Executes the
// packages queued by sessions.enqueue against YClients through the EXISTING
// cores: index.mutate (records) and payments.pay (money). Both cores take the
// salon advisory lock 17291 themselves and are idempotent by operationId, so
// the worker never takes that lock (holding it on another connection would make
// them fail 'busy'). Per-salon serialization comes from LEASE_SQL: a salon has
// at most one 'running' package, and packages of one record go strictly by id.
//
// Never logs upstream error texts or bodies: only ids, kinds, codes, statuses.
const { db } = require('../../db');
const m = require('./model');
const index = require('./index');
const payments = require('./payments');
const yc = require('./yclients');
const reference = require('./reference-cache');
const finOps = require('../finance-ops');
const prefs = require('./record-prefs');
const logger = require('../../logger').createLogger('JournalOutbox');

const TICK_MS = 2000;
const MAX_PER_TICK = 20;
const MAX_ATTEMPTS = 6;
const DELAYS = [5, 30, 120, 600, 600];
// A 'running' row older than this was orphaned by a crash between ticks of a
// still-alive process (e.g. the failure write itself failed). Steps are
// idempotent by opId, so re-queueing is safe; the margin covers a slow payment.
const STALE_RUNNING_MIN = 15;
const UPSTREAM_TEXT = 'YClients не ответил. Повторите позже.';

const LEASE_SQL = `UPDATE journal_outbox SET status='running', attempts=attempts+1, updated_at=NOW()
WHERE id = (
  SELECT o.id FROM journal_outbox o
  WHERE o.status='queued' AND o.next_attempt_at<=NOW()
    AND o.released_at IS NOT NULL
    AND (o.create_outbox_id IS NULL OR o.yclients_record_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM journal_outbox p WHERE p.salon_id=o.salon_id AND p.status='running')
    AND NOT EXISTS (SELECT 1 FROM journal_outbox e WHERE e.salon_id=o.salon_id AND e.id<o.id
                    AND e.status IN ('queued','running') AND e.yclients_record_id IS NOT NULL
                    AND e.yclients_record_id=o.yclients_record_id)
  ORDER BY o.next_attempt_at, o.id LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *`;
const RECOVER_SQL = `UPDATE journal_outbox SET status='queued', updated_at=NOW() WHERE status='running'`;
const RECOVER_STALE_SQL = `UPDATE journal_outbox SET status='queued', updated_at=NOW()
  WHERE status='running' AND updated_at < NOW() - make_interval(mins => ${STALE_RUNNING_MIN})`;
const PERSIST_SQL = `UPDATE journal_outbox SET steps=$2::jsonb, yclients_record_id=COALESCE($3, yclients_record_id), updated_at=NOW() WHERE id=$1`;
const DONE_SQL = `UPDATE journal_outbox SET status='done', steps=$2::jsonb, yclients_record_id=COALESCE($3, yclients_record_id),
  error_code=NULL, error_text=NULL, failed_step=NULL, updated_at=NOW() WHERE id=$1`;
// Changes queued for a new record before it existed in YClients follow it
// as soon as the create step has the real id (then they order by record id).
const ADOPT_SQL = `UPDATE journal_outbox SET yclients_record_id=$2, updated_at=NOW()
  WHERE create_outbox_id=$1 AND yclients_record_id IS NULL`;
const REQUEUE_SQL = `UPDATE journal_outbox SET status='queued', next_attempt_at=NOW() + make_interval(secs => $4),
  steps=$2::jsonb, yclients_record_id=COALESCE($3, yclients_record_id), updated_at=NOW() WHERE id=$1`;
const FAIL_SQL = `UPDATE journal_outbox SET status='failed', failed_step=$4, error_code=$5, error_text=$6,
  steps=$2::jsonb, yclients_record_id=COALESCE($3, yclients_record_id), updated_at=NOW() WHERE id=$1`;

const isJournal = e => e instanceof m.JournalError;
const safeToken = v => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : null);
const statusOf = e => {
  const s = e?.response?.status ?? e?.status;
  return Number.isInteger(s) ? s : null;
};

// The core saw this operationId with a different request hash: the key was
// evidently used before, so the outcome is unknown — never retried or re-keyed.
const KEY_REUSED = 'уже использован для других данных';

function classify(e) {
  if (isJournal(e)) {
    if (e.code === 'uncertain' || String(e.message || '').includes(KEY_REUSED)) return 'uncertain';
    if (e.code === 'busy' || e.code === 'stale' || e.code === 'blocked_pending' || e.code === 'payment_pending') return 'retry';
    if (e.status === 502 || e.status === 503) return 'retry';
    if (e.status === 409 && String(e.message || '').includes('не готов')) return 'retry';
    return 'fail';
  }
  const status = statusOf(e);
  if (!e?.response && status === null) return 'retry';
  if (status === 429 || status >= 500) return 'retry';
  return 'fail';
}

function describe(e) {
  if (isJournal(e)) return `journal code=${safeToken(e.code) || 'invalid'} status=${e.status}`;
  const cls = safeToken(e?.constructor?.name) || 'Error';
  return `${cls} code=${safeToken(e?.code) || '-'} status=${statusOf(e) ?? '-'}`;
}

// A draft is stored in its step BEFORE the external call: the cores fingerprint
// the whole draft (including the live version), and a replay after a crash must
// send byte-identical data to hit the idempotent "already done" path. A stored
// draft is valid only for the step's current opId (sessions.retry re-keys).
// It is kept as a JSON STRING: `steps` is JSONB, which reorders object keys, and
// the fingerprint is key-order sensitive. An old object `draft` is still read.
function storedDraft(step) {
  let draft = null;
  if (typeof step.draftJson === 'string') {
    try { draft = JSON.parse(step.draftJson); } catch (_) { draft = null; }
  } else if (step.draft && typeof step.draft === 'object') {
    draft = step.draft;
  }
  return draft && draft.operationId === step.opId ? draft : null;
}
async function storeDraft(ctx, step, draft) {
  step.draftJson = JSON.stringify(draft);
  delete step.draft;
  await ctx.persist();
}
const clearDraft = step => { delete step.draft; delete step.draftJson; };

// Saving the record (arrival) makes YClients re-create the visit's bonus
// write-offs under new ids (same card, same amount). A removal queued against
// the old id is resolved to the single unclaimed live write-off of the same
// card and amount; anything ambiguous is left as is (the core refuses it).
async function resolveBonusRemoval(ctx, step, sale, transactionId) {
  const p = step.params || {};
  const live = (sale?.state?.loyalty_transactions || []).filter(t => Number(t.type_id) === 3);
  if (live.some(t => Number(t.id) === Number(transactionId))) return transactionId;
  const claimed = new Set();
  for (const other of ctx.steps) {
    if (other === step || other.kind !== 'remove_payment' || other.params?.method !== 'loyalty_card') continue;
    const d = storedDraft(other);
    claimed.add(String(d ? d.transactionId : other.params?.transactionId));
  }
  const payOps = ctx.steps.filter(s => s.kind === 'pay' && s.params?.method === 'loyalty_card').map(s => s.opId);
  if (payOps.length) {
    const rows = await db.any('SELECT external_ids FROM journal_financial_transactions WHERE salon_id=$1 AND operation_id = ANY($2)', [ctx.salonId, payOps]);
    for (const r of rows || []) for (const id of r.external_ids || []) claimed.add(String(id));
  }
  const cents = Math.round(Number(p.amount) * 100);
  const candidates = live.filter(t => !claimed.has(String(t.id))
    && Number(t.loyalty_card_id || t.card_id) === Number(p.methodId)
    && Math.round(Number(t.amount) * 100) === cents);
  return candidates.length === 1 ? Number(candidates[0].id) : transactionId;
}

async function runStep(ctx, step) {
  const { salonId, userId } = ctx;
  const p = step.params || {};
  if (step.kind === 'create') {
    const { operationId: _o, action: _a, ...params } = p;
    // api_id rides OUTSIDE the draft: the draft's fingerprint must stay the same
    // for packages started before this field existed.
    const r = await index.mutate(salonId, userId, { ...params, operationId: step.opId, action: 'create' }, { apiId: `lp-outbox-${ctx.outboxId}` });
    const recordId = Number(r?.recordId);
    if (!Number.isSafeInteger(recordId) || recordId < 1) m.fail('Не удалось подтвердить результат. Проверьте запись в YClients.', 409, 'uncertain');
    ctx.recordId = recordId;
    // «Не уведомлять» for the new record; the create webhook may come first —
    // notifications/enroll.js then finds the flag through api_id (lp-outbox-<id>).
    // The record already exists in YClients: a failed write must not fail the step.
    if (typeof p.notifyClient === 'boolean') {
      try { await prefs.write(salonId, recordId, p.notifyClient, ctx.outboxId); }
      catch (e) { logger.warn(`outbox ${ctx.outboxId} salon ${salonId} record ${recordId}: notify flag not saved ${describe(e)}`); }
    }
    return { recordId };
  }
  if (!ctx.recordId) m.fail('Запись ещё не создана в YClients.', 409);
  const recordId = ctx.recordId;
  if (['move', 'confirm', 'cancel', 'edit', 'delete'].includes(step.kind)) {
    // «Не уведомлять» is saved BEFORE the package's FIRST external step: in
    // [move, edit{notifyClient}] the move's webhook would otherwise queue
    // «запись перенесена» before the flag exists. Idempotent on retry.
    if (!ctx.prefsWritten) {
      const flagged = ctx.steps.find(s => s && s.kind === 'edit' && typeof s.params?.notifyClient === 'boolean');
      if (flagged) await prefs.write(salonId, recordId, flagged.params.notifyClient, ctx.outboxId);
      ctx.prefsWritten = true;
    }
    if (step.kind === 'edit' && typeof p.notifyClient === 'boolean') {
      const rest = Object.keys(p).filter(k => !['notifyClient', 'servicesVersion', 'version'].includes(k));
      if (!rest.length) {
        // No PUT → no webhook: queued notifications of the record are cancelled
        // by the notifications module's own rule. Best effort.
        if (p.notifyClient === false) {
          try { await require('../notifications/enroll').cancelPending(salonId, recordId, prefs.OPT_OUT_REASON); }
          catch (e) { logger.warn(`outbox ${ctx.outboxId} salon ${salonId} record ${recordId}: pending notifications not cancelled ${describe(e)}`); }
        }
        return { recordId, prefsOnly: true };
      }
    }
    let draft = storedDraft(step);
    if (!draft) {
      let live;
      try { live = await yc.getRecord(ctx.salon, recordId); }
      catch (e) {
        // Deleting a record YClients no longer has is done (spec §6).
        if (step.kind === 'delete' && m.isNotFound(e)) return { recordId, alreadyDeleted: true };
        throw e;
      }
      // The services version was checked locally when the change was saved
      // (against the journal's state incl. earlier unsent changes). Sent later
      // it would compare a local draft with YClients and refuse every change
      // of a record that was itself still queued.
      const { servicesVersion: _sv, version: _v, ...edit } = p;
      draft = { operationId: step.opId, action: step.kind, recordId, version: m.revision(live),
        ...(step.kind === 'edit' ? { edit } : {}),
        ...(step.kind === 'move' ? { date: p.date, time: p.time, staffId: p.staffId,
          ...(p.seanceLength !== undefined ? { durationOverride: p.seanceLength } : {}),
          ...(p.technicalBreak !== undefined ? { technicalBreak: p.technicalBreak } : {}) } : {}) };
      await storeDraft(ctx, step, draft);
    }
    const r = await index.mutate(salonId, userId, draft);
    if (r?.alreadyDeleted) return { recordId, alreadyDeleted: true };
    return { recordId: Number(r?.recordId) || recordId };
  }
  if (step.kind === 'pay' || step.kind === 'remove_payment') {
    const c = await payments.context(salonId, recordId);
    let draft = storedDraft(step);
    if (!draft) {
      const body = step.kind === 'pay'
        ? { operationId: step.opId, recordId, method: p.method, methodId: p.methodId, amount: p.amount, version: c.version,
          ...(p.method === 'account' && Number(c.record?.attendance) === 0 && p.confirmArrival === true ? { confirmArrival: true } : {}) }
        : { operationId: step.opId, recordId, action: 'remove',
          transactionId: p.method === 'loyalty_card' ? await resolveBonusRemoval(ctx, step, c.sale, p.transactionId) : p.transactionId,
          method: p.method, methodId: p.methodId, amount: p.amount, version: c.version };
      draft = payments.parse(body);
      await storeDraft(ctx, step, draft);
    }
    const r = await payments.pay(salonId, userId, draft);
    if (step.kind === 'pay') await reference.learnBonusPercent(salonId, c.sale);
    return { confirmed: true, ...(r?.duplicate ? { duplicate: true } : {}) };
  }
  m.fail('Неизвестный шаг пакета.', 400, 'unknown_step');
}

async function processPackage(row) {
  const steps = (Array.isArray(row.steps) ? row.steps : []).map(s => ({ ...s }));
  const ctx = {
    salonId: Number(row.salon_id),
    userId: row.user_id ?? null,
    recordId: row.yclients_record_id != null ? Number(row.yclients_record_id) : null,
    salon: null,
    outboxId: Number(row.id),
    steps,
  };
  const json = () => JSON.stringify(steps);
  ctx.persist = () => db.query(PERSIST_SQL, [row.id, json(), ctx.recordId]);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.state === 'done') {
      if (step.kind === 'create' && Number(step.result?.recordId) > 0) {
        ctx.recordId = Number(step.result.recordId);
        await db.query(ADOPT_SQL, [row.id, ctx.recordId]);
      }
      continue;
    }
    try {
      if (!ctx.salon) {
        ctx.salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [ctx.salonId]);
        if (!ctx.salon?.yclients_company_id) m.fail('YClients не подключён для салона.', 409, 'no_yclients');
      }
      step.result = await runStep(ctx, step);
      step.state = 'done';
      clearDraft(step);
      await ctx.persist();
      // Payment step reached YClients and was confirmed locally (opId = journal_financial_transactions.operation_id).
      if (step.kind === 'pay' || step.kind === 'remove_payment') {
        await finOps.safely('journal-step-done', () => finOps.markStep(ctx.salonId, step.opId, 'confirmed', { journalOperationId: step.opId, yclientsRecordId: ctx.recordId }));
      }
      if (step.kind === 'create' && ctx.recordId) await db.query(ADOPT_SQL, [row.id, ctx.recordId]);
    } catch (e) {
      return fail(row, steps, ctx, i, e);
    }
  }
  await db.query(DONE_SQL, [row.id, json(), ctx.recordId]);
  logger.info(`outbox ${row.id} salon ${ctx.salonId}: done (${steps.length} steps)`);
  return 'done';
}

const delayFor = attempts => DELAYS[Math.min(Math.max(attempts, 1), DELAYS.length) - 1];

async function fail(row, steps, ctx, i, e) {
  const step = steps[i];
  const attempts = Number(row.attempts) || 0;
  // The step already executed (only its persist failed): never downgrade it to
  // failed — retry would re-key an operation that took effect. Requeue
  // regardless of attempts; if that write fails too, the throw leaves the row
  // 'running' for stale-running recovery.
  if (step.state === 'done') {
    const delay = delayFor(attempts);
    logger.warn(`outbox ${row.id} salon ${ctx.salonId} step ${i} ${step.kind}: executed, state write failed; requeue in ${delay}s ${describe(e)}`);
    await db.query(REQUEUE_SQL, [row.id, JSON.stringify(steps), ctx.recordId, delay]);
    return 'queued';
  }
  let verdict = classify(e);
  // A stale stored draft would be refused forever: rebuild it on the next try.
  if (isJournal(e) && e.code === 'stale') clearDraft(step);
  if (verdict === 'retry' && attempts < MAX_ATTEMPTS) {
    const delay = delayFor(attempts);
    logger.warn(`outbox ${row.id} salon ${ctx.salonId} step ${i} ${step.kind}: retry in ${delay}s (attempt ${attempts}) ${describe(e)}`);
    await db.query(REQUEUE_SQL, [row.id, JSON.stringify(steps), ctx.recordId, delay]);
    return 'queued';
  }
  if (verdict === 'retry') verdict = 'fail';
  const uncertain = verdict === 'uncertain';
  step.state = uncertain ? 'uncertain' : 'failed';
  const code = uncertain ? 'uncertain' : (safeToken(e?.code) || 'failed');
  const text = isJournal(e) ? e.message : UPSTREAM_TEXT;
  logger.warn(`outbox ${row.id} salon ${ctx.salonId} step ${i} ${step.kind}: ${uncertain ? 'uncertain' : 'failed'} ${describe(e)}`);
  await db.query(FAIL_SQL, [row.id, JSON.stringify(steps), ctx.recordId, i, code, text]);
  await finOps.safely('journal-step-failed', async () => {
    for (const s of steps) {
      if ((s.kind === 'pay' || s.kind === 'remove_payment') && s.state !== 'done') await finOps.markStep(ctx.salonId, s.opId, 'failed');
    }
  });
  return 'failed';
}

let _inFlight = false;
let _timer = null;

async function tick() {
  if (_inFlight) return 0;
  _inFlight = true;
  let n = 0;
  try {
    await db.query(RECOVER_STALE_SQL);
    while (n < MAX_PER_TICK) {
      const row = await db.oneOrNone(LEASE_SQL);
      if (!row) break;
      n++;
      try { await processPackage(row); } catch (e) {
        // Status write failed: the row stays 'running' until stale recovery.
        logger.error(`outbox ${row.id}: processing aborted ${describe(e)}`);
      }
    }
  } catch (e) {
    logger.error(`tick failed ${describe(e)}`);
  } finally {
    _inFlight = false;
  }
  return n;
}

async function recoverRunning() {
  try {
    const r = await db.query(RECOVER_SQL);
    if (r?.rowCount) logger.warn(`recovered running packages: ${r.rowCount}`);
  } catch (e) {
    logger.error(`recover running failed ${describe(e)}`);
  }
}

let _starting = false;
async function start() {
  if (_timer || _starting) return;
  _starting = true;
  try {
    // Recover BEFORE the first tick: a row left 'running' by the previous
    // process would otherwise block its salon until stale recovery.
    await recoverRunning();
    _timer = setInterval(() => { tick(); }, TICK_MS);
    if (_timer.unref) _timer.unref();
    logger.info('Journal outbox worker started');
  } finally {
    _starting = false;
  }
}

// A freshly saved form should not wait for the next 2-second tick. Only when
// the worker runs in this process; an in-flight tick drains the queue anyway.
function kick() {
  if (!_timer) return;
  setImmediate(() => { tick(); });
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, tick, kick, processPackage, classify, recoverRunning, LEASE_SQL, RECOVER_SQL, ADOPT_SQL, DELAYS, MAX_ATTEMPTS };
