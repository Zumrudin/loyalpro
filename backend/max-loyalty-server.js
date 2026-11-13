'use strict';
// Isolated production entrypoint: no main-app crons, background agents or
// unrelated migrations. Can coexist with an older LoyalPro release.
const express = require('express');
const config = require('./config');
const { pool } = require('./db');
const { MAX_LOYALTY_DDL } = require('./migrations');
const { configured } = require('./services/max-loyalty/protocol');

async function main() {
  if (!configured(config.MAX_LOYALTY_BOT)) throw new Error('MAX configuration incomplete');
  await pool.query(MAX_LOYALTY_DDL);
  const salon = (await pool.query('SELECT id,is_active FROM salons WHERE id=$1', [config.MAX_LOYALTY_BOT.salonId])).rows[0];
  if (!salon || salon.is_active === false) throw new Error('MAX salon unavailable');
  if (config.BONUS_LEDGER_PRIMARY) {
    const r = await pool.query("SELECT to_regclass('finance_operations') IS NOT NULL AS ready");
    if (!r.rows[0].ready) throw new Error('Primary bonus ledger schema missing');
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '64kb' }));
  app.use('/max-loyalty', require('./routes/max-loyalty-webhook'));
  app.get('/max-loyalty/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.use((err, _req, res, _next) => res.sendStatus(err.type === 'entity.too.large' ? 413 : 400));
  const port = Number(process.env.MAX_LOYALTY_BOT_PORT || 3104);
  const server = app.listen(port, '127.0.0.1', () => {
    console.log('MAX loyalty service ready');
    require('./services/max-loyalty/worker').start();
  });
  server.on('error', () => { console.error('MAX listen failed'); process.exit(1); });
}
if (require.main === module) main().catch(() => { console.error('MAX startup failed'); process.exitCode = 1; pool.end(); });
module.exports = { main };
