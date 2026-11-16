'use strict';
const { createLogger } = require('../logger');
const log = createLogger('WebhookSecurity');
const providers = new Set(['yclients', 'chatpush', 'gateway']);
const reasons = new Set(['accepted', 'missing_key', 'invalid_key', 'not_configured', 'rate_limited']);
const counts = new Map();

// Bounded process-local counters. Log powers of two, never request fields;
// retries/attack traffic cannot amplify one warning per request indefinitely.
function record(provider, reason) {
  if (!providers.has(provider) || !reasons.has(reason)) return;
  const key = `${provider}:${reason}`;
  const total = (counts.get(key) || 0) + 1;
  counts.set(key, total);
  if (total === 1 || Number.isInteger(Math.log2(total))) {
    log[reason === 'accepted' ? 'info' : 'warn'](`provider=${provider} result=${reason} process_total=${total}`);
  }
}

async function validateStartup(db, config) {
  // Administrative inventory: aggregate only; no tenant records or secrets leave SQL.
  const yc = await db.one(`SELECT COUNT(*)::int AS active,
    COUNT(*) FILTER (WHERE NULLIF(trim(yclients_webhook_secret),'') IS NULL)::int AS missing
    FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL`);
  const status = {
    yclientsActive: Number(yc.active), yclientsMissing: Number(yc.missing),
    chatpushConfigured: !!config.CHATPUSH?.webhookSecret?.trim(),
    gatewayConfigured: !!config.MESSAGING_GATEWAY?.webhookSecret?.trim(),
  };
  log.info(`startup ${JSON.stringify(status)}`);
  if (status.yclientsMissing || !status.chatpushConfigured || !status.gatewayConfigured) {
    log.warn('Unconfigured webhook endpoints remain fail-closed');
  }
  return status;
}

module.exports = { record, validateStartup };
