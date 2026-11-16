'use strict';
const crypto = require('crypto');
const config = require('../config');
const { db, withTransaction } = require('../db');
const { AsyncLocalStorage } = require('async_hooks');
const usageContext = new AsyncLocalStorage();

class LimitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 429;
  }
}

function settings() {
  const c = config.RESOURCE_LIMITS || {};
  return {
    registerIp: c.registerIp || 5,
    registerEmail: c.registerEmail || 3,
    relayPerMinute: c.relayPerMinute || 120,
    askUserPerMinute: c.askUserPerMinute || 10,
    askSalonPerMinute: c.askSalonPerMinute || 30,
    llmConcurrency: c.llmConcurrency || 2,
    salonDailyCalls: c.salonDailyCalls || 100,
    salonMonthlyCalls: c.salonMonthlyCalls || 2000,
    globalDailyCalls: c.globalDailyCalls || 5000,
    paidDailyCalls: c.paidDailyCalls || 1000,
  };
}

function keyHash(scope, key) {
  return crypto.createHmac('sha256', config.JWT_SECRET).update(scope + ':' + String(key)).digest('hex');
}

async function consumeRate(scope, key, limit, windowSeconds) {
  const row = await db.one(
    `INSERT INTO api_rate_counters (scope,key_hash,window_started_at,count)
     VALUES ($1,$2,to_timestamp(FLOOR(EXTRACT(EPOCH FROM NOW())/$3)*$3),1)
     ON CONFLICT (scope,key_hash,window_started_at)
     DO UPDATE SET count=api_rate_counters.count+1,updated_at=NOW()
     RETURNING count`,
    [scope, keyHash(scope, key), windowSeconds]
  );
  return Number(row?.count) <= limit;
}

async function register(ip, email) {
  const limits = settings();
  if (!await consumeRate('register_ip', ip || 'unknown', limits.registerIp, 3600)) {
    throw new LimitError('RATE_LIMIT', 'Слишком много попыток регистрации. Повторите позже.');
  }
  if (!await consumeRate('register_email', String(email || '').toLowerCase().trim(), limits.registerEmail, 3600)) {
    throw new LimitError('RATE_LIMIT', 'Слишком много попыток регистрации. Повторите позже.');
  }
}

async function askRate(salonId, userId) {
  const limits = settings();
  if (!await consumeRate('kb_ask_user', `${salonId}:${userId}`, limits.askUserPerMinute, 60)
      || !await consumeRate('kb_ask_salon', salonId, limits.askSalonPerMinute, 60)) {
    throw new LimitError('RATE_LIMIT', 'Слишком много запросов. Повторите через минуту.');
  }
}

async function incrementCall(conn, salonId, period, startExpression, limit) {
  const result = await conn.query(
    `INSERT INTO llm_usage_counters (salon_id,period,period_started_at,calls)
     VALUES ($1,$2,${startExpression},1)
     ON CONFLICT (salon_id,period,period_started_at)
     DO UPDATE SET calls=llm_usage_counters.calls+1,updated_at=NOW()
       WHERE llm_usage_counters.calls<$3
     RETURNING calls`,
    [salonId, period, limit]
  );
  if (!result.rows[0]) throw new LimitError('BUDGET_EXHAUSTED', 'Лимит запросов ИИ исчерпан.');
}

async function claimUsage(salonId, { paid = false, leaseId } = {}) {
  const limits = settings();
  const day = "(NOW() AT TIME ZONE 'Europe/Moscow')::date";
  await withTransaction(async conn => {
    if (leaseId) {
      const lease = await conn.query(`UPDATE llm_concurrency_leases SET expires_at=NOW()+INTERVAL '5 minutes'
        WHERE id=$1 AND salon_id=$2 AND expires_at>NOW() RETURNING id`, [leaseId, salonId]);
      if (!lease.rows.length) throw new LimitError('CONCURRENCY', 'Срок запроса истёк. Повторите запрос.');
    }
    await incrementCall(conn, 0, 'global_day', day, limits.globalDailyCalls);
    if (paid) await incrementCall(conn, 0, 'paid_day', day, limits.paidDailyCalls);
    await incrementCall(conn, salonId, 'day', day, limits.salonDailyCalls);
    await incrementCall(conn, salonId, 'month', `date_trunc('month',${day})::date`, limits.salonMonthlyCalls);
  });
}

async function claimGlobal({ paid = false } = {}) {
  await withTransaction(async conn => {
    const day = "(NOW() AT TIME ZONE 'Europe/Moscow')::date";
    await incrementCall(conn, 0, 'global_day', day, settings().globalDailyCalls);
    if (paid) await incrementCall(conn, 0, 'paid_day', day, settings().paidDailyCalls);
  });
}

function isLimitError(e) {
  return ['BUDGET_EXHAUSTED', 'PAID_DISABLED', 'CONCURRENCY'].includes(e?.code);
}

async function attempt({ paid = false } = {}) {
  if (paid && config.LLM_PAID_ENABLED === false) throw new LimitError('PAID_DISABLED', 'Платные запросы ИИ временно отключены.');
  const context = usageContext.getStore();
  return context ? claimUsage(context.salonId, { paid, leaseId: context.leaseId }) : claimGlobal({ paid });
}

async function acquire(salonId, userId) {
  const id = crypto.randomUUID();
  await withTransaction(async conn => {
    await conn.query('SELECT pg_advisory_xact_lock(19381,$1)', [salonId]);
    await conn.query('DELETE FROM llm_concurrency_leases WHERE salon_id=$1 AND expires_at<=NOW()', [salonId]);
    const result = await conn.query(
      'SELECT COUNT(*)::int AS count FROM llm_concurrency_leases WHERE salon_id=$1 AND expires_at>NOW()',
      [salonId]
    );
    if (result.rows[0].count >= settings().llmConcurrency) {
      throw new LimitError('CONCURRENCY', 'Слишком много одновременных запросов. Повторите позже.');
    }
    await conn.query(
      `INSERT INTO llm_concurrency_leases (id,salon_id,user_id,expires_at)
       VALUES ($1,$2,$3,NOW()+INTERVAL '5 minutes')`,
      [id, salonId, userId]
    );
  });
  return id;
}

async function runLlm(salonId, userId, fn) {
  const leaseId = await acquire(salonId, userId);
  try {
    return await usageContext.run({ salonId, leaseId }, fn);
  } finally {
    await db.query('DELETE FROM llm_concurrency_leases WHERE id=$1 AND salon_id=$2', [leaseId, salonId]).catch(() => {});
  }
}

module.exports = { LimitError, keyHash, consumeRate, register, askRate, claimUsage, claimGlobal, acquire, runLlm, attempt, isLimitError };
