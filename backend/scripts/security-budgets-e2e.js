'use strict';

// Synthetic DB-only acceptance. No server, provider, patient or production data.
// Usage: node scripts/security-budgets-e2e.js [path-to-dev-env]
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const { fork } = require('child_process');
const PREFIX = 'security_budgets_e2e_';
const schemaPattern = /^security_budgets_e2e_[a-f0-9]{24}$/;
const EMAIL = 'synthetic@example.invalid';

async function guardedPool() {
  const { pool } = require('../db');
  const result = await pool.query('SELECT current_database() AS db, current_schema() AS schema');
  assert.equal(result.rows[0].db, 'loyalpro_test');
  assert.equal(result.rows[0].schema, process.env.SECURITY_E2E_SCHEMA);
  return pool;
}

async function worker() {
  const pool = await guardedPool();
  const config = require('../config');
  const limits = require('../services/resource-limits');
  const invites = require('../services/registration-invites');
  const { withTransaction } = require('../db');
  process.on('message', async ({ id, op, args = {} }) => {
    try {
      let value;
      if (op === 'settings') {
        config.RESOURCE_LIMITS = args;
        config.REGISTRATION_MODE = 'invite';
        config.LLM_PAID_ENABLED = true;
      } else if (op === 'claim') {
        await limits.runLlm(args.salonId, 1, async () => {
          for (let n = 0; n < (args.attempts || 1); n++) await limits.attempt({ paid: !!args.paid });
        });
      } else if (op === 'expiredAttempt') {
        let providerCalled = false;
        try {
          await limits.runLlm(args.salonId, 1, async () => {
            await pool.query("UPDATE llm_concurrency_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE salon_id=$1", [args.salonId]);
            await limits.attempt({ paid: true });
            providerCalled = true;
          });
          value = { providerCalled };
        } catch (error) {
          value = { providerCalled, code: error.code };
        }
      } else if (op === 'lease') {
        value = await limits.acquire(args.salonId, 1);
      } else if (op === 'invite') {
        await withTransaction(async conn => {
          await invites.consume(conn, args.token, args.email || EMAIL);
          if (args.fail) throw Object.assign(new Error('Synthetic registration failure'), { code: 'SYNTHETIC_FAILURE' });
        });
      } else if (op === 'close') {
        await pool.end();
        process.send({ id, ok: true });
        process.disconnect();
        return;
      } else throw new Error('Unknown command');
      process.send({ id, ok: true, value });
    } catch (error) {
      // Never serialize DB errors, SQL, parameters, tokens or environment values.
      process.send({ id, ok: false, code: error.code || String(error.status || 'ERROR') });
    }
  });
  process.send({ ready: true });
}

async function spawnWorker() {
  const child = fork(__filename, ['--worker'], { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const pending = new Map();
  let sequence = 0;
  child.on('message', message => {
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve, reject) => {
    child.once('message', m => m.ready ? resolve() : reject(new Error('Worker not ready')));
    child.once('exit', () => reject(new Error('Worker exited before readiness')));
    setTimeout(() => reject(new Error('Worker startup timeout')), 15000).unref();
  });
  return {
    child,
    call(op, args) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker operation timeout')); }, 15000);
        pending.set(id, value => { clearTimeout(timer); resolve(value); });
        child.send({ id, op, args });
      });
    },
  };
}

async function main() {
  const source = require('dotenv').parse(fs.readFileSync(process.argv[2] || '/srv/loyalpro-dev/releases/security-20261115-201235/backend/.env'));
  const url = new URL(source.DATABASE_URL);
  url.pathname = '/loyalpro_test';
  const schema = PREFIX + crypto.randomBytes(12).toString('hex');
  assert.match(schema, schemaPattern);
  // No public fallback: every unqualified query must resolve within our schema.
  url.searchParams.set('options', `-c search_path=${schema} -c timezone=Europe/Moscow -c statement_timeout=10000 -c lock_timeout=5000`);
  process.env.DATABASE_URL = url.toString();
  process.env.DB_SSL = source.DB_SSL || 'false';
  process.env.JWT_SECRET = 'synthetic-e2e-only-' + crypto.randomBytes(32).toString('hex');
  process.env.REGISTRATION_MODE = 'invite';
  process.env.SECURITY_E2E_SCHEMA = schema;
  const { pool } = require('../db');
  const invites = require('../services/registration-invites');
  const { RESOURCE_LIMITS_DDL, REGISTRATION_INVITES_DDL } = require('../migrations');
  let created = false;
  let cleaned = false;
  const workers = [];
  const passed = [];
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'loyalpro_test');
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await guardedPool();
    await pool.query(RESOURCE_LIMITS_DDL);
    await pool.query(REGISTRATION_INVITES_DDL);
    // Re-applying exported migrations must be harmless.
    await pool.query(RESOURCE_LIMITS_DDL);
    await pool.query(REGISTRATION_INVITES_DDL);
    passed.push('idempotent_ddl');
    workers.push(await spawnWorker(), await spawnWorker());
    const [a, b] = workers;
    const base = { salonDailyCalls: 50, salonMonthlyCalls: 50, globalDailyCalls: 50, paidDailyCalls: 50, llmConcurrency: 5 };
    const reset = async settings => {
      await pool.query('TRUNCATE llm_usage_counters, llm_concurrency_leases');
      await Promise.all(workers.map(w => w.call('settings', { ...base, ...settings }).then(r => assert.equal(r.ok, true))));
    };
    const snapshot = async () => (await pool.query('SELECT salon_id,period,calls FROM llm_usage_counters ORDER BY salon_id,period')).rows;
    for (const [name, settings, paid, otherTenant] of [
      ['day', { salonDailyCalls: 1 }, false, false],
      ['month', { salonMonthlyCalls: 1 }, false, false],
      ['global', { globalDailyCalls: 1 }, false, true],
      ['paid', { paidDailyCalls: 1 }, true, true],
    ]) {
      await reset(settings);
      assert.equal((await a.call('claim', { salonId: 101, paid })).ok, true);
      const before = await snapshot();
      assert.equal((await b.call('claim', { salonId: otherTenant ? 102 : 101, paid })).code, 'BUDGET_EXHAUSTED');
      assert.deepEqual(await snapshot(), before);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM llm_concurrency_leases')).rows[0].n, 0);
      passed.push(`${name}_cross_process_cap_and_rollback`);
    }
    await reset({ salonDailyCalls: 1, salonMonthlyCalls: 1 });
    const tenants = await Promise.all([a.call('claim', { salonId: 101 }), b.call('claim', { salonId: 102 })]);
    assert.ok(tenants.every(r => r.ok));
    assert.deepEqual((await snapshot()).filter(r => r.period === 'day').map(r => r.calls), [1, 1]);
    passed.push('tenant_budget_isolation');
    await reset({ globalDailyCalls: 1 });
    const race = await Promise.all([a.call('claim', { salonId: 101 }), b.call('claim', { salonId: 102 })]);
    assert.equal(race.filter(r => r.ok).length, 1);
    assert.equal(race.filter(r => r.code === 'BUDGET_EXHAUSTED').length, 1);
    passed.push('global_concurrent_race');
    await reset({});
    assert.equal((await a.call('claim', { salonId: 101, attempts: 3, paid: true })).ok, true);
    assert.ok((await snapshot()).every(r => r.calls === 3));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM llm_concurrency_leases')).rows[0].n, 0);
    passed.push('async_context_per_attempt_and_lease_release');
    await reset({});
    const expiredAttempt = await a.call('expiredAttempt', { salonId: 101 });
    assert.equal(expiredAttempt.ok, true);
    assert.deepEqual(expiredAttempt.value, { providerCalled: false, code: 'CONCURRENCY' });
    assert.deepEqual(await snapshot(), []);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM llm_concurrency_leases')).rows[0].n, 0);
    passed.push('expired_active_lease_blocks_provider_and_counters');
    await reset({ llmConcurrency: 1 });
    const leases = await Promise.all([a.call('lease', { salonId: 101 }), b.call('lease', { salonId: 101 })]);
    assert.equal(leases.filter(r => r.ok).length, 1);
    assert.equal(leases.filter(r => r.code === 'CONCURRENCY').length, 1);
    assert.equal((await b.call('lease', { salonId: 102 })).ok, true);
    passed.push('concurrent_leases_and_tenant_isolation');
    await pool.query("UPDATE llm_concurrency_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE salon_id=101");
    assert.equal((await b.call('lease', { salonId: 101 })).ok, true);
    passed.push('expired_lease_recovery');
    const token = await invites.issue(pool, EMAIL);
    assert.equal((await a.call('invite', { token, email: 'wrong@example.invalid' })).code, '403');
    const consumes = await Promise.all([a.call('invite', { token }), b.call('invite', { token })]);
    assert.equal(consumes.filter(r => r.ok).length, 1);
    assert.equal(consumes.filter(r => r.code === '403').length, 1);
    assert.equal((await a.call('invite', { token })).code, '403');
    passed.push('invite_email_concurrent_single_use_and_reuse');
    const expired = await invites.issue(pool, EMAIL);
    await pool.query("UPDATE registration_invites SET expires_at=NOW()-INTERVAL '1 second' WHERE token_hash=$1", [crypto.createHash('sha256').update(expired).digest('hex')]);
    assert.equal((await a.call('invite', { token: expired })).code, '403');
    passed.push('expired_invite');
    const retry = await invites.issue(pool, EMAIL);
    assert.equal((await a.call('invite', { token: retry, fail: true })).code, 'SYNTHETIC_FAILURE');
    assert.equal((await b.call('invite', { token: retry })).ok, true);
    passed.push('registration_rollback_restores_invite');
  } finally {
    await Promise.allSettled(workers.map(async worker => {
      try { await worker.call('close'); } finally { worker.child.kill(); }
    }));
    if (created) {
      assert.match(schema, schemaPattern);
      assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'loyalpro_test');
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      cleaned = (await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount === 0;
    }
    await pool.end();
    console.log(JSON.stringify({ passed: passed.length, cases: passed, cleaned }));
  }
  assert.equal(cleaned, true);
}

(process.argv[2] === '--worker' ? worker() : main()).catch(() => {
  console.error('Security budgets E2E failed; sensitive error details suppressed.');
  process.exitCode = 1;
});
