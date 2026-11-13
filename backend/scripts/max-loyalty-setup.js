'use strict';
// Read-only by default; --apply changes commands/subscription, never sends a
// patient message. Run manually after moderation and deployment approval.
const { createApi } = require('../services/max-loyalty/api');
const { configured } = require('../services/max-loyalty/protocol');

async function main() {
  const config = require('../config').MAX_LOYALTY_BOT;
  if (!configured(config)) throw new Error('Set MAX_LOYALTY_BOT_* configuration first');
  const url = new URL(process.env.MAX_LOYALTY_BOT_WEBHOOK_URL || '');
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
    || url.pathname !== '/max-loyalty/webhook') throw new Error('Expected HTTPS URL ending in /max-loyalty/webhook on port 443');
  const api = createApi(config.token);
  await api.me();
  const existing = await api.subscriptions();
  // Do not add a second consumer which could answer twice or process bonuses twice.
  if ((existing.subscriptions || []).some(s => s.url !== url.href)) {
    throw new Error('Another webhook is registered. Resolve it before connecting this server');
  }
  if (!process.argv.includes('--apply')) {
    console.log('Token is valid; subscription checked. No changes. Use --apply to register commands and webhook.');
    return;
  }
  await api.commands();
  await api.subscribe(url.href, config.webhookSecret);
  const check = await api.subscriptions();
  if (!(check.subscriptions || []).some(s => s.url === url.href)) throw new Error('Webhook verification failed');
  console.log('MAX commands and webhook configured. No patient messages sent.');
}
if (require.main === module) main().catch(() => { console.error('MAX setup failed; check configuration, TLS trust, token and existing subscriptions.'); process.exitCode = 1; });
module.exports = { main };
