// ============================================================
// LoyalPro — Backend Server v5.0 (modular)
// ============================================================
const config  = require('./config');
const { pool, db } = require('./db');
const { runMigrations } = require('./migrations');
const { runSync }           = require('./services/loyalty');
const { syncGoodsCategories } = require('./services/home-care');
const { syncGoodsCatalog }    = require('./services/yclients-goods-catalog');
const { syncStaffData, syncGoodsSales } = require('./services/staff');
const { refreshSegments }   = require('./services/segments');
const { processS3Orphans }  = require('./services/patient-portfolio');
const { startBroadcastWorker } = require('./services/broadcast');
const { startNotificationWorker } = require('./services/notifications');
const s3                    = require('./services/s3');
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

// Behind a single nginx reverse proxy — trust exactly one X-Forwarded-For hop
// so req.ip is the real client IP. Required for correct rate-limiting and for
// the IP recorded in the sessions table; without it express-rate-limit raises
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and keys every client to the proxy IP.
app.set('trust proxy', 1);

// Security headers
// Patient photo cases отдают thumbnails из S3 через presigned URL — добавляем
// origin из S3_ENDPOINT в img-src, чтобы CSP не блокировал отрисовку.
const s3ImgOrigin = (() => {
  try { return config.S3_ENDPOINT ? new URL(config.S3_ENDPOINT).origin : null; }
  catch { return null; }
})();
const imgSrc = ["'self'", "data:", "blob:"];
if (s3ImgOrigin) imgSrc.push(s3ImgOrigin);
// Аватары мастеров на дашборде специалиста отдаются напрямую с CDN YClients.
imgSrc.push('https://assets.yclients.com');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      styleSrc:  ["'self'", "'unsafe-inline'"],
      imgSrc,
      connectSrc: ["'self'"],
      fontSrc:   ["'self'", "data:"],
    },
  },
  // HSTS: 1 year, include subdomains. Prevents SSL-strip on first request after
  // the browser has visited at least once.
  hsts: { maxAge: 31536000, includeSubDomains: true },
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
  'https://dev.zumrudin.ru',
  'https://forma.zumrudin.ru', // публичная форма заявки на справку (iframe-встройка в Wix)
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
// Статика фронтенда. ETag и Last-Modified ВКЛЮЧЕНЫ намеренно: на проде nginx
// накрывает .js/.css своим `expires`, и без валидаторов закэшированный файл
// невозможно перепроверить — браузер обязан верить копии до конца срока. Так
// правки фронта доезжали до людей неделями (инцидент с nav.js и «Заботой»), а
// битая копия в кэше телефона жила бы вечно. С ETag браузер шлёт If-None-Match
// и получает пустой 304. HTML по-прежнему no-store: index.html обязан быть
// свежим, иначе он сошлётся на несуществующие версии ассетов.
app.use(express.static(path.join(__dirname, '../frontend'), { etag: true, lastModified: true, setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) { res.setHeader('Cache-Control', 'no-store'); } } }));

// Explicit route for index.html
app.get('/', (req, res) => {
  // index.html не кэшируем — иначе обновления UI «прилипают» в браузере после
  // деплоя/правок CSS/JS (cache-buster в URL не помогает, пока сам HTML стар).
  res.setHeader('Cache-Control', 'no-store');
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

// Каталог товаров синхронизируется в СВОЮ минуту, а не вместе с остальными.
// На минуте 0 по одному салону разом стартовали runSync + syncGoodsCategories
// + syncStaffData + syncGoodsSales, и общая квота YClients выедалась до того,
// как каталог доходил до конца списка категорий: хвост категорий падал с
// «Превышен лимит запросов» в КАЖДОМ прогоне (инцидент 2026-08-02).
cron.schedule('25 */3 * * *', async () => {
  try {
    const salons = await db.many(
      `SELECT * FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`
    );
    for (const salon of salons) {
      syncGoodsCatalog(salon).catch(e => cronLogger.error(`GoodsCatalogSync salon=${salon.id}: ${e.message}`));
    }
  } catch (e) { cronLogger.error(`GoodsCatalogSync cron: ${e.message}`); }
}, { timezone: 'Europe/Moscow' });

cron.schedule('0 * * * *', async () => {
  try {
    const salons = await db.many(
      `SELECT * FROM salons WHERE is_active=TRUE AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`
    );
    for (const salon of salons) {
      syncStaffData(salon).catch(e => cronLogger.error(`StaffSync salon=${salon.id}: ${e.message}`));
      syncGoodsSales(salon.id).catch(e => cronLogger.error(`GoodsSalesSync salon=${salon.id}: ${e.message}`));
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

// Журнал авторства исходящих (по нему вебхук отличает эхо наших отправок от
// сообщения, набранного администратором вручную) нужен ровно до прихода эха —
// старые строки чистим раз в сутки.
cron.schedule('40 4 * * *', () => {
  require('./services/outgoing-authorship').cleanup();
});

// Patient photo cases: периодически добиваем S3-удаления, которые не дошли в основном потоке.
cron.schedule('17 3 * * *', async () => {
  try {
    const r = await processS3Orphans(db, s3);
    if (r.processed > 0) cronLogger.info(`s3 orphans: ${JSON.stringify(r)}`);
  } catch (e) { cronLogger.error(`s3 orphans cron: ${e.message}`); }
}, { timezone: 'Europe/Moscow' });

// Сверка revenue_operations с YClients за последние 7 дней: удаляем операции,
// которые в YClients удалены (переразбивка оплаты), а delete-webhook не дошёл —
// иначе они завышают выручку на дашбордах. Ночью, когда оплаты не проводятся.
cron.schedule('40 4 * * *', async () => {
  try {
    const { reconcileRecentAllSalons } = require('./services/revenue-reconcile');
    const r = await reconcileRecentAllSalons(7);
    if (r.stale > 0) cronLogger.info(`revenue reconcile ${r.from}..${r.to}: удалено зависших=${r.deleted}`);
  } catch (e) { cronLogger.error(`revenue reconcile cron: ${e.message}`); }
}, { timezone: 'Europe/Moscow' });

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
      startBroadcastWorker();
      startNotificationWorker();
      require('./services/care/worker').startCareWorker();
    });
  })
  .catch(e => {
    logger.error(`PostgreSQL error: ${e.message}`);
    app.listen(PORT, () => logger.warn(`Server started WITHOUT DB on port ${PORT}`));
  });
