// ============================================================
// LoyalPro — Backend Server v5.0 (modular)
// ============================================================
const config  = require('./config');
const { pool, db } = require('./db');
const { runMigrations } = require('./migrations');
const { runSync }           = require('./services/loyalty');
const { syncGoodsCategories } = require('./services/home-care');
const { syncStaffData }     = require('./services/staff');
const { refreshSegments }   = require('./services/segments');
const mountRoutes = require('./routes/index');
const { createLogger } = require('./logger');
const logger = createLogger('Server');
const cronLogger = createLogger('Cron');

const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const path     = require('path');
const helmet   = require('helmet');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      styleSrc:  ["'self'", "'unsafe-inline'"],
      imgSrc:    ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc:   ["'self'", "data:"],
    },
  },
  hsts: false,
}));

const defaultOrigins = [
  config.FRONTEND_URL,
  'http://89.22.233.73',
  'http://89.22.233.73:8081',
  'http://89.125.92.223',
  'http://89.125.92.223:3001',
  'http://localhost:8081',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:8081',
  'http://127.0.0.1:3001',
  'http://127.0.0.1',
  'https://zumrudin.ru',
];
// Use ALLOWED_ORIGINS env var if provided (comma-separated), otherwise fall back to defaults
const allowedOrigins = config.ALLOWED_ORIGINS || defaultOrigins;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
// NOTE: No manual app.options('*', ...) handler — cors() middleware handles OPTIONS preflight correctly.
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../frontend'), { etag: false, lastModified: false, setHeaders: (res, filePath) => { if (filePath.endsWith('.js') || filePath.endsWith('.css')) { res.setHeader('Cache-Control', 'no-store'); } } }));

// Explicit route for index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Mount all routes (webhook + API)
mountRoutes(app);

// ============================================================
// CRON JOBS
// ============================================================
cron.schedule('0 10 * * *', async () => {
  cronLogger.info('Birthday bonuses...');
  try {
    const salons = await db.many(
      `SELECT s.*,ls.birthday_bonus,ls.birthday_days_before
       FROM salons s JOIN loyalty_settings ls ON ls.salon_id=s.id
       WHERE s.is_active=TRUE AND ls.birthday_enabled=TRUE`
    );
    for (const salon of salons) {
      const target = new Date();
      target.setDate(target.getDate() + (salon.birthday_days_before || 3));
      const clients = await db.many(
        `SELECT * FROM clients WHERE salon_id=$1
         AND EXTRACT(MONTH FROM birthday)=$2 AND EXTRACT(DAY FROM birthday)=$3`,
        [salon.id, target.getMonth() + 1, target.getDate()]
      );
      for (const c of clients) {
        const already = await db.one(
          `SELECT id FROM bonus_transactions WHERE client_id=$1 AND type='birthday'
           AND EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM NOW())`,
          [c.id]
        );
        if (already) continue;
        const bonus = salon.birthday_bonus || 500;
        await db.query('UPDATE clients SET bonus_balance=bonus_balance+$1 WHERE id=$2', [bonus, c.id]);
        await db.query(
          `INSERT INTO loyalty_card_transactions
             (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,txn_date,created_at)
           VALUES ($1,$2,(SELECT yclients_card_id FROM clients WHERE id=$3),'accrual',$4,$5,'🎂 Подарок на день рождения',NOW(),NOW())`,
          [salon.id, c.id, c.id, bonus, c.bonus_balance + bonus]
        );
        cronLogger.info(`Birthday: ${c.name} +${bonus}`);
      }
    }
  } catch (e) { cronLogger.error(`Birthday cron: ${e.message}`); }
}, { timezone: 'Europe/Moscow' });

cron.schedule('0 */3 * * *', async () => {
  cronLogger.info('Auto-sync...');
  try {
    const salons = await db.many(
      `SELECT * FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`
    );
    for (const salon of salons) {
      runSync(salon, 'auto').catch(e => cronLogger.error(`AutoSync salon=${salon.id}: ${e.message}`));
      syncGoodsCategories(salon).catch(e => cronLogger.error(`GoodsCatSync salon=${salon.id}: ${e.message}`));
    }
  } catch (e) { cronLogger.error(`AutoSync cron: ${e.message}`); }
});

cron.schedule('0 * * * *', async () => {
  try {
    const salons = await db.many(
      `SELECT * FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`
    );
    for (const salon of salons) {
      syncStaffData(salon).catch(e => cronLogger.error(`StaffSync salon=${salon.id}: ${e.message}`));
    }
  } catch (e) { cronLogger.error(`StaffSync cron: ${e.message}`); }
});

cron.schedule('30 * * * *', async () => {
  try {
    const salons = await db.many(`SELECT id FROM salons WHERE is_active=TRUE`);
    for (const s of salons) {
      refreshSegments(s.id).catch(e => cronLogger.error(`Segments cron salon=${s.id}: ${e.message}`));
    }
  } catch (e) { cronLogger.error(`Segments cron: ${e.message}`); }
});

// ============================================================
// START
// ============================================================
const PORT = config.PORT;
pool.connect()
  .then(async client => {
    await runMigrations(client);
    client.release();
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info('Webhook: POST /yclients/webhook.v2/:companyId');
      logger.info('Register: POST /api/auth/register');
    });
  })
  .catch(e => {
    logger.error(`PostgreSQL error: ${e.message}`);
    app.listen(PORT, () => logger.warn(`Server started WITHOUT DB on port ${PORT}`));
  });
