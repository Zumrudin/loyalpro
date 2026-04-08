// ============================================================
// LoyalPro — Backend Server v4.0
// ============================================================
require('dotenv').config();
const express  = require('express');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const axios    = require('axios');
const cors     = require('cors');
const cron     = require('node-cron');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const puppeteer = require('puppeteer');
const { buildHomeCareHtml, BRAND_CONFIG } = require('./homecare-template');
const { buildClientsQuery } = require('./clients-query');

// ── Multer for template image uploads ─────────────────────────
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../frontend/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const type = req.params.type || 'file';
    cb(null, `salon_${req.user?.salonId}_${type}${ext}`);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения'));
  },
});

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

// ── DB helpers ────────────────────────────────────────────────
const db = {
  query: (sql, p) => pool.query(sql, p),
  one:   async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  many:  async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
};

// ── Auth middleware ───────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'loyalpro_dev_secret_change_in_production';

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' });
  }
}

// Roles: owner > admin > specialist
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ error: 'Нет доступа' });
    next();
  };
}

// Auth supporting both Bearer header and ?token= query param (for direct downloads)
function authOrQuery(req, res, next) {
  const h = req.headers.authorization;
  const t = h?.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token expired' }); }
}

// ── YClients API ──────────────────────────────────────────────
const YC = 'https://api.yclients.com/api/v1';

function ycHeaders(salon) {
  return {
    'Accept': 'application/vnd.yclients.v2+json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${salon.yclients_partner_token}, User ${salon.yclients_user_token}`,
  };
}

async function ycGet(salon, endpoint, params = {}) {
  const url = new URL(`${YC}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const { data } = await axios.get(url.toString(), { headers: ycHeaders(salon), timeout: 30000 });
  if (!data.success) throw new Error(data.meta?.message || 'YClients API error');
  return data.data;
}

async function ycPost(salon, endpoint, body = {}) {
  const { data } = await axios.post(`${YC}${endpoint}`, body, {
    headers: ycHeaders(salon), timeout: 30000
  });
  if (!data.success) throw new Error(data.meta?.message || 'YClients API error');
  return data.data;
}

async function ycAuth(partnerToken, login, password) {
  const { data } = await axios.post(`${YC}/auth`,
    { login, password, application_id: partnerToken },
    { headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.yclients.v2+json',
        'Authorization': `Bearer ${partnerToken}`
      }, timeout: 15000 }
  );
  if (!data.success) throw new Error(data.meta?.message || 'Неверный логин или пароль');
  return data.data;
}

// ── In-memory cache for product/service trees (per salonId) ──
const _treeCache = {}; // { [salonId]: { products: [...], services: [...], ts: Date } }
function getTreeCache(salonId) { return _treeCache[salonId] || null; }
function setTreeCache(salonId, key, data) {
  if (!_treeCache[salonId]) _treeCache[salonId] = {};
  _treeCache[salonId][key] = data;
  _treeCache[salonId].ts = Date.now();
}
function clearTreeCache(salonId) { delete _treeCache[salonId]; }

// ── YClients Loyalty Card API ─────────────────────────────────

// Получить типы карт лояльности компании
async function ycGetCardTypes(salon) {
  const { data } = await axios.get(
    `${YC}/loyalty/card_types/salon/${salon.yclients_company_id}`,
    { headers: ycHeaders(salon), timeout: 15000 }
  );
  if (!data.success) return [];
  return data.data || [];
}

// Получить карты клиента
async function ycGetClientCards(salon, yclClientsId) {
  try {
    const { data } = await axios.get(
      `${YC}/loyalty/client_cards/${yclClientsId}`,
      { headers: ycHeaders(salon), timeout: 15000 }
    );
    console.log(`[Cards] client=${yclClientsId} success=${data.success} count=${Array.isArray(data.data)?data.data.length:'n/a'}`);
    if (Array.isArray(data.data) && data.data.length > 0) {
      console.log(`[Cards] first card keys:`, Object.keys(data.data[0]).join(','));
      console.log(`[Cards] first card sample:`, JSON.stringify(data.data[0]).slice(0,400));
    }
    if (!data.success) return [];
    return data.data || [];
  } catch (e) {
    console.error(`[Cards] error for client ${yclClientsId}:`, e.message);
    return [];
  }
}

// Транзакции карты YClients недоступны через API.
// История берётся из таблицы bonus_transactions нашей БД.
// Эта функция оставлена как заглушка для совместимости.
// ── YClients Web Session (для истории транзакций карты) ────────
// Кэш куки по salonId — чтобы не логиниться при каждом запросе
const ycWebSessions = {};

async function ycWebLogin(salon) {
  const cached = ycWebSessions[salon.id];
  if (cached && Date.now() - cached.ts < 4 * 60 * 60 * 1000) return cached.cookie;

  if (!salon.yclients_web_cookie)
    throw new Error('Куки YClients не заданы. Вставьте куки браузера в Настройках.');

  // Просто используем куки как есть — без проверки (YClients блокирует серверные IP)
  console.log(`[WebLogin] Using manual cookie for salon ${salon.id} (len=${salon.yclients_web_cookie.length})`);
  ycWebSessions[salon.id] = { cookie: salon.yclients_web_cookie, ts: Date.now() };
  return salon.yclients_web_cookie;
}

// Получить историю транзакций карты через веб-интерфейс YClients
async function ycGetCardTransactions(salon, clientYcId, phone, chainId) {
  try {
    const cookie    = await ycWebLogin(salon);
    const companyId = salon.yclients_company_id;
    // Приоритет: явный chainId → salon.yclients_chain_id → companyId
    const groupId   = chainId || salon.yclients_chain_id || companyId;
    const phoneClean = String(phone || '').replace(/\D/g, '');

    if (groupId === companyId) {
      console.warn(`[WebTxns] WARNING: groupId == companyId (${companyId}). Chain ID не настроен! Установите yclients_chain_id в БД.`);
    }
    console.log(`[WebTxns] groupId=${groupId} companyId=${companyId} clientYcId=${clientYcId} phone=${phoneClean}`);

    // Пробуем с телефоном и без (некоторые клиенты без телефона)
    const urlsToTry = phoneClean
      ? [
          `https://yclients.com/loyalty_cards/get_client_loyalty_cards_json/${groupId}/${companyId}/${clientYcId}/${phoneClean}?show_redesign_view=false&_=${Date.now()}`,
          `https://yclients.com/loyalty_cards/get_client_loyalty_cards_json/${groupId}/${companyId}/${clientYcId}?show_redesign_view=false&_=${Date.now()}`,
        ]
      : [
          `https://yclients.com/loyalty_cards/get_client_loyalty_cards_json/${groupId}/${companyId}/${clientYcId}?show_redesign_view=false&_=${Date.now()}`,
        ];

    const url = urlsToTry[0];
    console.log(`[WebTxns] GET ${url}`);

    const UA2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    const reqHeaders = {
      'Cookie':           cookie,
      'User-Agent':       UA2,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept':           'application/json, text/javascript, */*; q=0.01',
      'Referer':          `https://yclients.com/company/${companyId}/clients/`,
      'Accept-Language':  'ru-RU,ru;q=0.9',
    };

    let resp = await axios.get(url, { headers: reqHeaders, validateStatus: s=>s<500, timeout:15000 });
    console.log(`[WebTxns] status=${resp.status} success=${resp.data?.success}`);

    // Если 403/404 или не success — пробуем запасной URL (без телефона)
    if (!resp.data?.success && urlsToTry.length > 1) {
      console.log(`[WebTxns] Trying fallback URL (without phone)`);
      resp = await axios.get(urlsToTry[1], { headers: reqHeaders, validateStatus: s=>s<500, timeout:15000 });
      console.log(`[WebTxns] Fallback status=${resp.status} success=${resp.data?.success}`);
    }

    if (resp.status === 404) {
      console.log(`[WebTxns] 404 — client not found, skipping`);
      return [];
    }

    if (!resp.data?.success) {
      console.log(`[WebTxns] Not success:`, JSON.stringify(resp.data).slice(0,200));
      return [];
    }

    const html = resp.data.html || '';
    console.log(`[WebTxns] Got HTML, length=${html.length}`);

    // Парсим транзакции из HTML
    const txns = parseCardTransactionsHtml(html);
    console.log(`[WebTxns] Parsed ${txns.length} transactions`);
    return txns;

  } catch (e) {
    console.error(`[WebTxns] Error:`, e.message);
    // Сбрасываем кэш сессии при ошибке
    delete ycWebSessions[salon.id];
    return [];
  }
}

// Парсер транзакций из HTML YClients
function parseCardTransactionsHtml(html) {
  const txns = [];
  // Находим все блоки транзакций: data-locator="transaction_row"
  const rowRegex = /data-locator="transaction_row">([\s\S]*?)(?=data-locator="transaction_row"|<\/div>\s*<\/div>\s*<\/div>\s*<div id="card-expiration)/g;
  let match;
  let idx = 0;

  // Более простой подход — ищем паттерны дата/сумма
  const dateRegex   = /data-locator="tr_data">\s*([\d.]+)\s*<\/div>/g;
  const amountRegex = /col-xs-2 text-right">\s*([-\d.]+)\s*<\/div>/g;
  const titleRegex  = /(?:data-locator="tr_amount"|<span>)([^<]{3,100})<\/span>/g;

  const dates   = [];
  const amounts = [];
  const titles  = [];

  let m;
  while ((m = dateRegex.exec(html))   !== null) dates.push(m[1].trim());
  while ((m = amountRegex.exec(html)) !== null) amounts.push(parseFloat(m[1].trim()));
  while ((m = titleRegex.exec(html))  !== null) {
    const t = m[1].trim();
    if (t && !t.includes('показать') && !t.includes('Показать') && t.length > 2) {
      titles.push(t);
    }
  }

  const len = Math.min(dates.length, amounts.length);
  for (let i = 0; i < len; i++) {
    // Конвертируем дату DD.MM.YYYY → ISO
    let txnDate = null;
    try {
      const parts = dates[i].split('.');
      if (parts.length === 3) {
        txnDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).toISOString();
      }
    } catch {}

    txns.push({
      id:         null,  // нет ID из веб-интерфейса
      date:       dates[i],
      txn_date:   txnDate,
      amount:     amounts[i],
      title:      titles[i] || (amounts[i] >= 0 ? 'Начисление' : 'Списание'),
      type:       amounts[i] >= 0 ? 'accrual' : 'redemption',
    });
  }

  return txns;
}

// Начислить/списать бонусы на карту
async function ycAccrueCard(salon, cardId, amount, title) {
  const { data } = await axios.post(
    `${YC}/company/${salon.yclients_company_id}/loyalty/cards/${cardId}/manual_transaction`,
    { amount, title },
    { headers: ycHeaders(salon), timeout: 15000 }
  );
  if (!data.success) throw new Error(data.meta?.message || 'Card transaction failed');
  return data.data;
}


const sleep = ms => new Promise(r => setTimeout(r, ms));
// ── Loyalty helpers ───────────────────────────────────────────
async function getLoyaltySettings(salonId) {
  const row = await db.one('SELECT * FROM loyalty_settings WHERE salon_id=$1', [salonId]);
  if (!row) return null;
  if (typeof row.levels === 'string') row.levels = JSON.parse(row.levels);
  if (typeof row.service_cashback === 'string') row.service_cashback = JSON.parse(row.service_cashback);
  return row;
}

function getLevel(totalSpent, levels) {
  const sorted = [...levels].sort((a, b) => b.minSpent - a.minSpent);
  return sorted.find(l => totalSpent >= l.minSpent) || sorted[sorted.length - 1];
}

function calcBonus(visitAmount, serviceIds, level, serviceCashback) {
  let pct = level.cashback || 5;
  if (serviceCashback && serviceIds?.length) {
    const overrides = serviceIds.map(id => serviceCashback[String(id)]).filter(p => p !== undefined);
    if (overrides.length) pct = Math.max(pct, ...overrides);
  }
  return { pct, bonus: Math.floor(visitAmount * pct / 100) };
}

// ── Вычислить сумму записи из services (API /records не возвращает cost на верхнем уровне) ──
function getRecordCost(ycr) {
  // Прямое поле cost (webhook формат)
  if (ycr.cost !== undefined && ycr.cost !== null) return parseFloat(ycr.cost) || 0;
  // Суммируем из services
  if (Array.isArray(ycr.services) && ycr.services.length > 0) {
    return ycr.services.reduce((sum, s) => {
      return sum + parseFloat(s.cost_to_pay ?? s.cost ?? s.amount ?? 0);
    }, 0);
  }
  return 0;
}

// ── Process completed visit ───────────────────────────────────
async function processCompletedRecord(recordId, clientId, ycRec, salonId, settings) {
  const pg = await pool.connect();
  try {
    await pg.query('BEGIN');
    const client = (await pg.query('SELECT * FROM clients WHERE id=$1 FOR UPDATE', [clientId])).rows[0];
    if (!client) { await pg.query('ROLLBACK'); return 0; }

    const cost     = getRecordCost(ycRec);
    const newSpent = parseFloat(client.total_spent || 0) + cost;
    const level    = getLevel(newSpent, settings.levels);
    const svcIds   = (ycRec.services || []).map(s => s.id);
    const { pct, bonus } = calcBonus(cost, svcIds, level, settings.service_cashback);
    const accrual  = settings.bonuses_enabled === false ? 0 : bonus;

    await pg.query(
      `UPDATE clients SET
         bonus_balance = bonus_balance + $1,
         total_spent   = total_spent + $2,
         visits_count  = visits_count + 1,
         loyalty_level = $3,
         last_visit_at = $4,
         updated_at    = NOW()
       WHERE id = $5`,
      [accrual, cost, level.key, ycRec.date || new Date(), clientId]
    );

    if (accrual > 0) {
      await pg.query(
        `INSERT INTO loyalty_card_transactions
           (salon_id,client_id,yclients_card_id,type,amount,
            balance_after,title,record_id,txn_date,created_at)
         VALUES ($1,$2,
           (SELECT yclients_card_id FROM clients WHERE id=$3),
           'accrual',$4,$5,$6,$7,NOW(),NOW())`,
        [salonId, clientId, clientId, accrual,
         client.bonus_balance + accrual,
         `Кэшбэк ${pct}% за визит ${String(ycRec.date || '').split(' ')[0]}`,
         recordId]
      );
    }

    await pg.query(
      'UPDATE records SET bonus_accrued=$1,cashback_pct=$2,bonus_processed=TRUE WHERE id=$3',
      [accrual, accrual > 0 ? pct : 0, recordId]
    );

    await pg.query('COMMIT');
    return accrual;
  } catch (e) {
    await pg.query('ROLLBACK');
    console.error('[processRecord]', e.message);
    return 0;
  } finally {
    pg.release();
  }
}

// ── Cancel bonuses on record cancellation ────────────────────
async function cancelRecordBonuses(recordId, clientId, salonId) {
  const record = await db.one('SELECT * FROM records WHERE id=$1', [recordId]);
  if (!record?.bonus_accrued || record.bonus_accrued <= 0) return;
  const client = await db.one('SELECT * FROM clients WHERE id=$1', [clientId]);
  if (!client) return;
  const deduct = Math.min(record.bonus_accrued, client.bonus_balance);
  await db.query('UPDATE clients SET bonus_balance=bonus_balance-$1,updated_at=NOW() WHERE id=$2', [deduct, clientId]);
  await db.query(
    `INSERT INTO loyalty_card_transactions
       (salon_id,client_id,yclients_card_id,type,amount,
        balance_after,title,record_id,txn_date,created_at)
     VALUES ($1,$2,
       (SELECT yclients_card_id FROM clients WHERE id=$3),
       'redemption',$4,$5,$6,$7,NOW(),NOW())`,
    [salonId, clientId, clientId, -deduct,
     client.bonus_balance - deduct,
     'Отмена начисления', recordId]
  );
  await db.query(
    'UPDATE records SET bonus_processed=FALSE,bonus_accrued=0,status=$1 WHERE id=$2',
    ['cancelled', recordId]
  );
}

// ── Определение статуса записи (универсально для API и webhook) ──
function getRecordStatus(ycr) {
  // Формат webhook: status_id (1-7)
  if (ycr.status_id !== undefined && ycr.status_id !== null) {
    const sid = parseInt(ycr.status_id);
    if (sid === 4) return 'completed';   // Оказана
    if (sid === 3) return 'completed';   // Пришёл
    if (sid === 2) return 'confirmed';   // Подтверждена
    if (sid === 5) return 'cancelled';   // Отменена
    if (sid === 6) return 'no_show';     // Не пришёл
    if (sid === 7) return 'deleted';     // Удалена
    return 'waiting';                     // 1 = Ожидание
  }

  // Формат GET /records: attendance + deleted
  if (ycr.deleted) return 'deleted';

  const att = ycr.attendance !== undefined ? parseInt(ycr.attendance) : undefined;
  if (att === 2) return 'completed';   // Оказана (услуга оказана)
  if (att === 1) return 'confirmed';   // Клиент пришёл / подтвердил
  if (att === -1) return 'no_show';    // Не пришёл
  if (att === 0) return 'waiting';     // Ожидание

  // Fallback: проверяем visit_attendance (некоторые версии API)
  if (ycr.visit_attendance === 1) return 'completed';
  if (ycr.confirmed === 1) return 'confirmed';

  return 'waiting';
}

// ── SYNC ──────────────────────────────────────────────────────
async function runSync(salon, syncType, userId) {
  const log = await db.one(
    `INSERT INTO sync_logs (salon_id,sync_type,status,initiated_by)
     VALUES ($1,$2,'running',$3) RETURNING id`,
    [salon.id, syncType, userId || null]
  );
  let cs = 0, rs = 0, ba = 0, nc = 0;

  try {
    const settings = await getLoyaltySettings(salon.id);

    // ══════════════════════════════════════════════════════════════
    // ШАГ 1: Загружаем ВСЕ записи из YClients (быстро, bulk)
    // ══════════════════════════════════════════════════════════════
    const endDate   = new Date().toISOString().split('T')[0];
    const syncDays  = parseInt(process.env.SYNC_DAYS || '730');
    const startDate = new Date(Date.now() - syncDays * 86400000).toISOString().split('T')[0];
    console.log(`[Sync] ── Step 1: Fetching ALL records ${startDate} → ${endDate} ──`);

    let allRecs = [], rPage = 1;
    for (;;) {
      let chunk = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          chunk = await ycGet(salon, `/records/${salon.yclients_company_id}`, {
            start_date: startDate, end_date: endDate, page: rPage, count: 200
          });
          break; // успех
        } catch (e) {
          console.log(`[Sync] Records page ${rPage} attempt ${attempt} failed: ${e.message}`);
          if (attempt < 3) await sleep(3000 * attempt);
          else throw e;
        }
      }
      if (!chunk?.length) break;
      allRecs = allRecs.concat(chunk);
      console.log(`[Sync] Records page ${rPage}: ${chunk.length} (total: ${allRecs.length})`);
      if (chunk.length < 200) break;
      rPage++;
      await sleep(300); // чуть больше паузы для 10k+ записей
    }
    console.log(`[Sync] Total records fetched: ${allRecs.length}`);

    // Диагностика: выводим ключи и статусные поля первой записи
    if (allRecs.length > 0) {
      const sample = allRecs[0];
      console.log(`[Sync] Sample record keys: ${Object.keys(sample).join(', ')}`);
      console.log(`[Sync] Sample record status fields: status_id=${sample.status_id} attendance=${sample.attendance} visit_attendance=${sample.visit_attendance} deleted=${sample.deleted} confirmed=${sample.confirmed}`);
      console.log(`[Sync] Sample record → getRecordStatus = "${getRecordStatus(sample)}" | date="${sample.date}" cost=${sample.cost} computed_cost=${getRecordCost(sample)} services=${Array.isArray(sample.services)?sample.services.length:'none'}`);
    }

    // Индексируем записи по yclients_client_id
    const recordsByClient = {};
    const orphanRecords = []; // записи без клиента
    for (const rec of allRecs) {
      const cid = rec.client?.id;
      if (cid) {
        if (!recordsByClient[cid]) recordsByClient[cid] = [];
        recordsByClient[cid].push(rec);
      } else {
        orphanRecords.push(rec);
      }
    }
    console.log(`[Sync] Records indexed: ${Object.keys(recordsByClient).length} clients, ${orphanRecords.length} without client`);

    // Пауза перед следующим шагом чтобы не перегрузить API
    await sleep(2000);

    // ══════════════════════════════════════════════════════════════
    // ШАГ 2: Собираем все ID клиентов (быстро)
    // ══════════════════════════════════════════════════════════════
    console.log(`[Sync] ── Step 2: Collecting client IDs ──`);
    let page = 1, allIds = [];
    for (;;) {
      let chunk = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const ids = await ycPost(salon, `/company/${salon.yclients_company_id}/clients/search`, {
            page, count: 25, filters: []
          });
          chunk = Array.isArray(ids) ? ids : [];
          break;
        } catch (e) {
          console.log(`[Sync] Client IDs page ${page} attempt ${attempt} failed: ${e.message}`);
          if (attempt < 3) await sleep(3000 * attempt);
          else throw e;
        }
      }
      if (!chunk.length) break;
      allIds = allIds.concat(chunk.map(i => i.id));
      if (chunk.length < 25) break;
      page++;
      await sleep(300);
    }
    console.log(`[Sync] Total client IDs: ${allIds.length}`);

    // ══════════════════════════════════════════════════════════════
    // ШАГ 3: Обрабатываем каждого клиента ЦЕЛИКОМ
    // (детали → БД → карта → записи → бонусы)
    // ══════════════════════════════════════════════════════════════
    console.log(`[Sync] ── Step 3: Processing clients one-by-one ──`);

    let retryCount = 0;
    const MAX_RETRIES = 3;

    for (let idx = 0; idx < allIds.length; idx++) {
      const ycClientId = allIds[idx];
      await sleep(400);

      try {
        // ── 3a. Загружаем детали клиента ──
        const ycc = await ycGet(salon, `/client/${salon.yclients_company_id}/${ycClientId}`);
        if (!ycc) continue;

        const fullName = [ycc.name, ycc.surname, ycc.patronymic]
          .filter(Boolean).join(' ').trim() || ycc.display_name || ycc.phone || 'Клиент';
        const phone        = ycc.phone || null;
        const totalSpent   = parseFloat(ycc.spent || ycc.paid || 0);
        const visitsCount  = parseInt(ycc.visits || 0);
        const lastVisitAt  = ycc.last_change_date ? new Date(ycc.last_change_date) : null;

        // ── 3b. Сохраняем / обновляем клиента в БД ──
        const ex = await db.one(
          'SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
          [salon.id, ycc.id]
        );
        let dbClientId;
        if (ex) {
          dbClientId = ex.id;
          await db.query(
            `UPDATE clients SET
               name=$1, phone=$2, email=$3, birthday=$4, yclients_data=$5,
               total_spent=$6, visits_count=$7, last_visit_at=$8,
               synced_at=NOW(), updated_at=NOW()
             WHERE id=$9`,
            [fullName, phone, ycc.email||null, ycc.birth_date||null, JSON.stringify(ycc),
             totalSpent, visitsCount, lastVisitAt, ex.id]
          );
        } else {
          const ins = await db.one(
            `INSERT INTO clients
               (salon_id, yclients_client_id, name, phone, email, birthday,
                total_spent, visits_count, last_visit_at, yclients_data, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
             ON CONFLICT (salon_id, yclients_client_id) DO UPDATE SET synced_at=NOW()
             RETURNING id`,
            [salon.id, ycc.id, fullName, phone, ycc.email||null, ycc.birth_date||null,
             totalSpent, visitsCount, lastVisitAt, JSON.stringify(ycc)]
          );
          dbClientId = ins?.id;
          if (!dbClientId) {
            const found = await db.one('SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salon.id, ycc.id]);
            dbClientId = found?.id;
          }
          nc++;
        }
        cs++;

        // ── 3c. Загружаем карту лояльности ──
        if (salon.yclients_card_type_id && dbClientId) {
          try {
            const cards = await ycGetClientCards(salon, ycc.id);
            const card = cards.find(c => c.type?.id === salon.yclients_card_type_id
                                      || String(c.type?.id) === String(salon.yclients_card_type_id));
            if (card) {
              const cardBalance = parseFloat(card.balance || 0);
              const paidAmount  = parseFloat(card.paid_amount || card.sold_amount || totalSpent || 0);
              await db.query(
                `UPDATE clients SET
                   yclients_card_id=$1, yclients_card_number=$2, yclients_card_balance=$3,
                   bonus_balance=$4, updated_at=NOW()
                 WHERE id=$5`,
                [card.id, card.number || card.loyalty_card_number || null,
                 cardBalance, cardBalance, dbClientId]
              );
              // Уровень лояльности
              if (settings?.levels && paidAmount > 0) {
                const lvl = getLevel(paidAmount, settings.levels);
                await db.query('UPDATE clients SET loyalty_level=$1 WHERE id=$2', [lvl.key, dbClientId]);
              }
            }
          } catch (cardErr) {
            // Не критично
          }
        }

        // ── 3d. Обрабатываем записи этого клиента ──
        const clientRecords = recordsByClient[ycc.id] || [];
        let clientRecs = 0, clientBonus = 0;

        for (const ycr of clientRecords) {
          const status = getRecordStatus(ycr);

          const exRec = await db.one(
            'SELECT id,status,bonus_processed FROM records WHERE salon_id=$1 AND yclients_record_id=$2',
            [salon.id, ycr.id]
          );

          if (exRec) {
            // Обновляем всегда (raw_payload, сумма, статус)
            const recCost = getRecordCost(ycr);
            await db.query(
              `UPDATE records SET status=$1, raw_payload=$2, amount=$3,
               services=$4, staff=$5, client_id=$6, updated_at=NOW() WHERE id=$7`,
              [status, JSON.stringify(ycr), recCost,
               JSON.stringify(ycr.services || []), JSON.stringify(ycr.staff || []),
               dbClientId, exRec.id]
            );
            if (status === 'completed' && exRec.status !== 'completed' && !exRec.bonus_processed
                && dbClientId && settings && recCost > 0) {
              clientBonus += await processCompletedRecord(exRec.id, dbClientId, ycr, salon.id, settings);
            }
            if (status === 'cancelled' && exRec.bonus_processed && dbClientId) {
              await cancelRecordBonuses(exRec.id, dbClientId, salon.id);
            }
          } else {
            const recCost = getRecordCost(ycr);
            const ins = await db.one(
              `INSERT INTO records
                 (salon_id,yclients_record_id,client_id,yclients_client_id,
                  visit_date,visit_datetime,amount,services,staff,status,source,raw_payload)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sync',$11) RETURNING id`,
              [salon.id, ycr.id, dbClientId || null, ycr.client?.id || null,
               String(ycr.date || '').split(' ')[0] || null, ycr.date || null,
               recCost, JSON.stringify(ycr.services || []),
               JSON.stringify(ycr.staff || []), status, JSON.stringify(ycr)]
            );
            if (ins && status === 'completed' && dbClientId && settings && recCost > 0) {
              clientBonus += await processCompletedRecord(ins.id, dbClientId, ycr, salon.id, settings);
            }
            clientRecs++;
          }
        }

        rs += clientRecs;
        ba += clientBonus;

        // ── 3e. Привязываем бесхозные транзакции этого клиента к записям ──
        if (dbClientId) {
          await db.query(`
            UPDATE loyalty_card_transactions lct
            SET record_id = sub.record_id
            FROM (
              SELECT DISTINCT ON (lct2.id)
                     lct2.id AS txn_id,
                     r.id    AS record_id
              FROM   loyalty_card_transactions lct2
              JOIN   records r
                ON   r.client_id  = lct2.client_id
                AND  r.salon_id   = lct2.salon_id
                AND  r.visit_date  = lct2.txn_date::date
              WHERE  lct2.client_id  = $1
                AND  lct2.record_id  IS NULL
                AND  lct2.txn_date   IS NOT NULL
                AND  r.visit_date    IS NOT NULL
                AND  r.status        IN ('completed','confirmed')
              ORDER BY lct2.id, r.visit_datetime DESC
            ) sub
            WHERE lct.id = sub.txn_id
          `, [dbClientId]);
        }

        // ── Лог по клиенту ──
        retryCount = 0; // сброс счётчика при успехе
        if (cs % 25 === 0 || clientRecs > 0 || clientBonus > 0) {
          console.log(`[Sync] ${cs}/${allIds.length} ${fullName}: records=${clientRecs} bonus=${clientBonus} (total: r=${rs} b=${ba})`);
        }

      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('429')) {
          console.log(`[Sync] 429 rate limit, waiting 10s...`);
          await sleep(10000);
          if (retryCount < MAX_RETRIES) { retryCount++; idx--; } else { retryCount = 0; console.log(`[Sync] Max retries for ${ycClientId}, skipping`); }
        } else if (msg.includes('socket hang up') || msg.includes('ECONNRESET')
                || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED')) {
          console.log(`[Sync] Network error for ${ycClientId}: ${msg}, retrying in 5s...`);
          await sleep(5000);
          if (retryCount < MAX_RETRIES) { retryCount++; idx--; } else { retryCount = 0; console.log(`[Sync] Max retries for ${ycClientId}, skipping`); }
        } else {
          retryCount = 0;
          console.log(`[Sync] Skip client ${ycClientId}: ${msg}`);
        }
      }
    }

    // ── Сохраняем записи-сироты (без клиента) ──
    if (orphanRecords.length > 0) {
      console.log(`[Sync] Processing ${orphanRecords.length} orphan records (no client)...`);
      for (const ycr of orphanRecords) {
        const status = getRecordStatus(ycr);
        const recCost = getRecordCost(ycr);
        const exRec = await db.one(
          'SELECT id FROM records WHERE salon_id=$1 AND yclients_record_id=$2',
          [salon.id, ycr.id]
        );
        if (exRec) {
          await db.query(
            `UPDATE records SET status=$1, raw_payload=$2, amount=$3,
             services=$4, staff=$5, updated_at=NOW() WHERE id=$6`,
            [status, JSON.stringify(ycr), recCost,
             JSON.stringify(ycr.services || []), JSON.stringify(ycr.staff || []), exRec.id]
          );
        } else {
          await db.query(
            `INSERT INTO records
               (salon_id,yclients_record_id,client_id,yclients_client_id,
                visit_date,visit_datetime,amount,services,staff,status,source,raw_payload)
             VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,'sync',$10)`,
            [salon.id, ycr.id, ycr.client?.id || null,
             String(ycr.date || '').split(' ')[0] || null, ycr.date || null,
             recCost, JSON.stringify(ycr.services || []),
             JSON.stringify(ycr.staff || []), status, JSON.stringify(ycr)]
          );
          rs++;
        }
      }
    }

    // ── Обновляем last_visit_at из реальных записей ──
    console.log('[Sync] Updating last_visit_at from records...');
    await db.query(`
      UPDATE clients c
      SET last_visit_at = sub.last_visit,
          updated_at    = NOW()
      FROM (
        SELECT client_id,
               MAX(visit_datetime) AS last_visit
        FROM   records
        WHERE  salon_id = $1
          AND  status   = 'completed'
          AND  client_id IS NOT NULL
        GROUP  BY client_id
      ) sub
      WHERE c.id       = sub.client_id
        AND c.salon_id = $1
    `, [salon.id]);

    await db.query(
      `UPDATE sync_logs SET status='success',clients_synced=$1,records_synced=$2,
       bonuses_accrued=$3,new_clients=$4,finished_at=NOW() WHERE id=$5`,
      [cs, rs, ba, nc, log.id]
    );

    console.log(`[Sync] ✓ Done: clients=${cs} records=${rs} bonuses=${ba} new=${nc}`);
    return { ok: true, clientsSynced: cs, recordsSynced: rs, bonusesAccrued: ba, newClients: nc };

  } catch (e) {
    await db.query(
      `UPDATE sync_logs SET status='error',error_message=$1,finished_at=NOW() WHERE id=$2`,
      [e.message, log.id]
    );
    throw e;
  }
}


// ============================================================
// FINANCES OPERATION & RECORD — логика начисления/отмены бонусов
// ============================================================
//
// СХЕМА (по образцу рабочей Python-интеграции):
//   resource=record, paid_full=1, attendance=1 → начисляем (один раз, атомарно)
//   resource=record, status=delete             → откатываем если было начисление
//   resource=finances_operation, status=delete → откатываем если было начисление
//   resource=finances_operation, status=create/update → ИГНОРИРУЕМ (иначе задвоение)
//
// Идемпотентность: INSERT INTO finances_log ON CONFLICT DO NOTHING + проверка rowcount

// Атомарно "забронировать" record_id — вернёт true только у первого вызова
async function claimRecordProcessing(salonId, ycRecordId, clientId) {
  const r = await db.query(
    `INSERT INTO finances_log (salon_id, yclients_record_id, client_id, event_status, cashback_amount, processed)
     VALUES ($1, $2, $3, 'create', -1, FALSE)
     ON CONFLICT (yclients_record_id) DO NOTHING`,
    [salonId, ycRecordId, clientId]
  );
  return r.rowCount === 1;
}

// Атомарно "забрать" сумму из лога — вернёт число или null (только один вызов получит значение)
async function popCashbackAmount(ycRecordId) {
  const r = await db.query(
    `DELETE FROM finances_log WHERE yclients_record_id=$1 RETURNING cashback_amount, client_id, salon_id`,
    [ycRecordId]
  );
  if (!r.rows.length) return null;
  return r.rows[0];
}

// Проверить есть ли уже запись (для диагностики)
async function getCashbackByRecord(ycRecordId) {
  return db.one(`SELECT cashback_amount FROM finances_log WHERE yclients_record_id=$1`, [ycRecordId]);
}

// ── Откат начисления (общий для record-delete и finances_operation-delete) ──
async function revertCashback(ycRecordId, salon, clientYcId) {
  const popped = await popCashbackAmount(ycRecordId);
  if (!popped) {
    console.log(`[Revert] nothing to revert for record=${ycRecordId}`);
    return;
  }
  const cashbackAmount = parseFloat(popped.cashback_amount);
  if (cashbackAmount <= 0) {
    console.log(`[Revert] skip revert record=${ycRecordId} amount=${cashbackAmount} (zero or denied)`);
    return;
  }

  // Найти клиента в нашей БД
  const client = await db.one(
    'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
    [salon.id, clientYcId]
  );
  if (!client) { console.log(`[Revert] client not found yclients_id=${clientYcId}`); return; }

  const deduct = Math.min(cashbackAmount, parseFloat(client.bonus_balance || 0));

  // Снимаем с карты YClients
  if (client.yclients_card_id && deduct > 0) {
    try {
      await ycAccrueCard(salon, client.yclients_card_id, -deduct,
        `Отмена кэшбэка по записи #${ycRecordId}`);
    } catch (e) {
      console.error(`[Revert] Card deduct error: ${e.message}`);
    }
  }

  // Обновляем БД
  await db.query(
    'UPDATE clients SET bonus_balance=GREATEST(0,bonus_balance-$1),updated_at=NOW() WHERE id=$2',
    [deduct, client.id]
  );

  const dbRecord = await db.one('SELECT id FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salon.id, ycRecordId]);
  await db.query(
    `INSERT INTO loyalty_card_transactions
       (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,record_id,txn_date,created_at)
     VALUES ($1,$2,(SELECT yclients_card_id FROM clients WHERE id=$3),'redemption',$4,$5,$6,$7,NOW(),NOW())`,
    [salon.id, client.id, client.id, -deduct,
     Math.max(0, client.bonus_balance - deduct),
     `Отмена кэшбэка за визит #${ycRecordId}`,
     dbRecord?.id || ycRecordId]
  );

  console.log(`[Revert] reverted ${deduct} for client ${client.name}, record #${ycRecordId}`);
}

// ── Обработка resource=record ──
async function processRecordEvent(payload, salon, settings) {
  const data = payload.data || {};
  const status = payload.status;
  const ycRecordId = data.id;
  const clientYcId = data.client?.id;

  if (!ycRecordId || !clientYcId) return;

  // Обновляем запись в нашей БД
  const recStatus = getRecordStatus(data);
  let client = await db.one(
    'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
    [salon.id, clientYcId]
  );

  // Создаём клиента если нет
  if (!client) {
    await db.query(
      `INSERT INTO clients (salon_id,yclients_client_id,name,phone,synced_at)
       VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT DO NOTHING`,
      [salon.id, clientYcId, data.client?.name || 'Клиент', data.client?.phone || null]
    );
    client = await db.one('SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2', [salon.id, clientYcId]);
  }

  // Сохраняем/обновляем запись
  let record = await db.one('SELECT * FROM records WHERE salon_id=$1 AND yclients_record_id=$2', [salon.id, ycRecordId]);
  if (!record) {
    record = await db.one(
      `INSERT INTO records
         (salon_id,yclients_record_id,client_id,yclients_client_id,
          visit_date,visit_datetime,amount,services,staff,status,source,raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'webhook',$11) RETURNING *`,
      [salon.id, ycRecordId, client?.id||null, clientYcId,
       String(data.date||'').split(' ')[0]||null, data.date||null,
       getRecordCost(data), JSON.stringify(data.services||[]),
       JSON.stringify(data.staff||[]), recStatus, JSON.stringify(data)]
    );
  } else {
    await db.query(
      'UPDATE records SET status=$1,raw_payload=$2,updated_at=NOW() WHERE id=$3',
      [recStatus, JSON.stringify(data), record.id]
    );
  }

  // DELETE записи → откат кэшбэка (если было начисление)
  if (status === 'delete' || data.deleted === true) {
    await revertCashback(ycRecordId, salon, clientYcId);
    return;
  }

  // Начисляем только когда визит полностью оплачен и клиент пришёл
  if (data.paid_full !== 1 || data.attendance !== 1) {
    console.log(`[Record] skip accrual record=${ycRecordId} paid_full=${data.paid_full} attendance=${data.attendance}`);
    return;
  }

  // Идемпотентность: атомарно "бронируем" record_id
  const claimed = await claimRecordProcessing(salon.id, ycRecordId, client?.id);
  if (!claimed) {
    const existing = await getCashbackByRecord(ycRecordId);
    console.log(`[Record] duplicate record=${ycRecordId} existing_cashback=${existing?.cashback_amount}`);
    return;
  }

  try {
    // Берём услуги из payload или из YClients API
    let services = data.services || [];
    if (!services.length) {
      try {
        const ycRecord = await ycGet(salon, `/record/${salon.yclients_company_id}/${ycRecordId}`);
        services = ycRecord.services || [];
      } catch(e) {
        console.log(`[Record] ycGet failed: ${e.message}`);
      }
    }

    // Проверяем скидки и считаем сумму
    let paidAmount = 0;
    let hasDiscount = false;
    for (const s of services) {
      const cost    = parseFloat(s.cost || 0);
      const costPay = parseFloat(s.cost_to_pay ?? cost);
      const disc    = parseFloat(s.discount || 0);
      if (disc > 0 || costPay < cost) { hasDiscount = true; break; }
      paidAmount += costPay;
    }

    console.log(`[Record] record=${ycRecordId} hasDiscount=${hasDiscount} paidAmount=${paidAmount}`);

    if (hasDiscount || paidAmount <= 0) {
      // Обновляем бронь на 0 (кэшбэк не начисляется)
      await db.query('UPDATE finances_log SET cashback_amount=0,processed=TRUE WHERE yclients_record_id=$1', [ycRecordId]);
      console.log(`[Record] denied record=${ycRecordId} (hasDiscount=${hasDiscount} paidAmount=${paidAmount})`);

      // Списание бонусов будет зафиксировано через finances_operation create
      // (приходит позже когда YClients уже обновил карту — без гонки)
      return;
    }

    // Тоггл начисления
    if (settings && settings.bonuses_enabled === false) {
      await db.query('UPDATE finances_log SET cashback_amount=0,processed=FALSE WHERE yclients_record_id=$1', [ycRecordId]);
      console.log(`[Record] bonuses DISABLED — logged only for record=${ycRecordId}`);
      return;
    }

    // Вычисляем кэшбэк
    const level = getLevel(parseFloat(client.total_spent || 0), settings.levels);
    const { pct, bonus: cashback } = calcBonus(paidAmount, services.map(s=>s.id), level, settings.service_cashback);

    if (cashback <= 0) {
      await db.query('UPDATE finances_log SET cashback_amount=0,processed=TRUE WHERE yclients_record_id=$1', [ycRecordId]);
      return;
    }

    // Начисляем на карту YClients
    if (client.yclients_card_id && salon.yclients_card_type_id) {
      try {
        await ycAccrueCard(salon, client.yclients_card_id, cashback, `Кэшбэк ${pct}% по записи #${ycRecordId}`);
      } catch(e) { console.error(`[Record] Card accrual error: ${e.message}`); }
    }

    // Обновляем баланс клиента
    await db.query(
      `UPDATE clients SET bonus_balance=bonus_balance+$1, total_spent=total_spent+$2,
       visits_count=visits_count+1, loyalty_level=$3, last_visit_at=$4, updated_at=NOW() WHERE id=$5`,
      [cashback, paidAmount, level.key, data.date || new Date(), client.id]
    );

    await db.query(
      `INSERT INTO loyalty_card_transactions
         (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,record_id,txn_date,created_at)
       VALUES ($1,$2,(SELECT yclients_card_id FROM clients WHERE id=$3),'accrual',$4,$5,$6,$7,NOW(),NOW())`,
      [salon.id, client.id, client.id, cashback,
       client.bonus_balance + cashback,
       `Кэшбэк ${pct}% за визит #${ycRecordId}`, record.id]
    );

    // Фиксируем сумму начисления в finances_log (для возможного отката)
    await db.query(
      'UPDATE finances_log SET cashback_amount=$1, cashback_pct=$2, paid_amount=$3, processed=TRUE WHERE yclients_record_id=$4',
      [cashback, pct, paidAmount, ycRecordId]
    );

    console.log(`[Record] Accrued ${cashback} (${pct}%) for client ${client.name}, record #${ycRecordId}`);

  } catch(e) {
    // Снимаем бронь чтобы можно было повторить
    await db.query('DELETE FROM finances_log WHERE yclients_record_id=$1 AND cashback_amount=-1', [ycRecordId]);
    throw e;
  }
}

// ── Обработка resource=finances_operation ──
async function processFinancesOperation(payload, salon) {
  const status = payload.status;
  const data = payload.data || {};
  const ycRecordId = data.record_id || data.record?.id;
  const clientYcId = data.client?.id;

  if (!ycRecordId || !clientYcId) return;

  console.log(`[FinOp] status=${status} clientYcId=${clientYcId} ycRecordId=${ycRecordId}`);

  // DELETE оплаты → откат начисления (если было) + синхронизация баланса карты
  if (status === 'delete') {
    // 1. Откатываем начисление кэшбэка (если было)
    await revertCashback(ycRecordId, salon, clientYcId);

    // 2. Синхронизируем баланс карты — YClients мог вернуть списанные бонусы
    const client = await db.one(
      'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
      [salon.id, clientYcId]
    );
    if (!client || !client.yclients_card_id) return;

    try {
      const cards = await ycGetClientCards(salon, clientYcId);
      const card = cards.find(c => String(c.id) === String(client.yclients_card_id));
      if (!card) return;

      const newBalance = parseFloat(card.balance || 0);
      const oldBalance = parseFloat(client.bonus_balance || 0);
      const delta = newBalance - oldBalance;

      console.log(`[FinOp] delete: card balance old=${oldBalance} new=${newBalance} delta=${delta}`);

      if (Math.abs(delta) < 1) return;

      await db.query(
        'UPDATE clients SET bonus_balance=$1::numeric, yclients_card_balance=$1::numeric, updated_at=NOW() WHERE id=$2',
        [newBalance, client.id]
      );

      const dbRecord = await db.one(
        'SELECT id FROM records WHERE salon_id=$1 AND yclients_record_id=$2',
        [salon.id, ycRecordId]
      );
      const txnType = delta >= 0 ? 'accrual' : 'redemption';
      const txnTitle = delta > 0
        ? `Возврат бонусов при отмене оплаты визита #${ycRecordId}`
        : `Списание бонусов при отмене визита #${ycRecordId}`;

      await db.query(
        `INSERT INTO loyalty_card_transactions
           (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,record_id,txn_date,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
        [salon.id, client.id, client.yclients_card_id,
         txnType, delta, newBalance, txnTitle, dbRecord?.id || null]
      );

      console.log(`[FinOp] delete: synced balance ${oldBalance} → ${newBalance} (${txnType} ${delta}) for client ${client.name}`);
    } catch(e) {
      console.log(`[FinOp] delete: card sync error: ${e.message}`);
    }
    return;
  }

  // CREATE — начисление кэшбэка игнорируем (идёт через resource=record),
  // но синхронизируем баланс карты чтобы зафиксировать списание бонусов клиентом.
  // finances_operation приходит ПОСЛЕ того как YClients обновил карту — нет гонки.
  if (status === 'create') {
    const client = await db.one(
      'SELECT * FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',
      [salon.id, clientYcId]
    );
    if (!client || !client.yclients_card_id) {
      console.log(`[FinOp] create: no client or card, skip sync`);
      return;
    }

    try {
      const cards = await ycGetClientCards(salon, clientYcId);
      const card = cards.find(c => String(c.id) === String(client.yclients_card_id));
      if (!card) { console.log(`[FinOp] create: card not found`); return; }

      const newBalance = parseFloat(card.balance || 0);
      const oldBalance = parseFloat(client.bonus_balance || 0);
      const delta = newBalance - oldBalance;

      console.log(`[FinOp] create: card balance old=${oldBalance} new=${newBalance} delta=${delta}`);

      if (Math.abs(delta) < 1) {
        console.log(`[FinOp] create: balance unchanged, skip`);
        return;
      }

      // Обновляем баланс в БД
      await db.query(
        'UPDATE clients SET bonus_balance=$1::numeric, yclients_card_balance=$1::numeric, updated_at=NOW() WHERE id=$2',
        [newBalance, client.id]
      );

      // Записываем транзакцию
      const dbRecord = await db.one(
        'SELECT id FROM records WHERE salon_id=$1 AND yclients_record_id=$2',
        [salon.id, ycRecordId]
      );
      const txnType = delta >= 0 ? 'accrual' : 'redemption';
      const txnTitle = delta < 0
        ? `Списание бонусов при оплате визита #${ycRecordId}`
        : `Начисление бонусов (YClients) #${ycRecordId}`;

      await db.query(
        `INSERT INTO loyalty_card_transactions
           (salon_id,client_id,yclients_card_id,type,amount,balance_after,title,record_id,txn_date,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
        [salon.id, client.id, client.yclients_card_id,
         txnType, delta, newBalance, txnTitle, dbRecord?.id || null]
      );

      console.log(`[FinOp] create: synced balance ${oldBalance} → ${newBalance} (${txnType} ${delta}) for client ${client.name}`);
    } catch(e) {
      console.log(`[FinOp] create: card sync error: ${e.message}`);
    }
    return;
  }

  // UPDATE — игнорируем
  console.log(`[FinOp] status=${status} — ignored`);
}


// ============================================================
// WEBHOOK
// ============================================================
app.post('/yclients/webhook.v2/:companyId', async (req, res) => {
  res.json({ ok: true });
  const t0 = Date.now();
  console.log(`[WH] hit companyId=${req.params.companyId} resource=${req.body?.resource||req.body?.resource_type}`);
  let wlog = null;
  try {
    const salon = await db.one(
      'SELECT * FROM salons WHERE yclients_company_id=$1 AND is_active=TRUE',
      [req.params.companyId]
    );
    if (!salon) { console.warn(`[WH] salon not found companyId=${req.params.companyId}`); return; }

    const payload = req.body;
    const resourceType = payload.resource || payload.resource_type;
    console.log(`[WH] salon=${salon.id} resource=${resourceType} data_id=${payload.data?.id}`);

    wlog = await db.one(
      `INSERT INTO webhook_logs (salon_id,event_type,resource_id,payload)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [salon.id, resourceType, payload.data?.id || null, JSON.stringify(payload)]
    );

    const settings = await getLoyaltySettings(salon.id);
    console.log(`[WH] bonuses_enabled=${settings?.bonuses_enabled} levels=${settings?.levels?.length}`);

    if (resourceType === 'record') {
      await processRecordEvent(payload, salon, settings);
    }

    if (resourceType === 'client' && payload.data) {
      const ycRec = payload.data;
      await db.query(
        `INSERT INTO clients (salon_id,yclients_client_id,name,phone,email,birthday,synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (salon_id,yclients_client_id)
         DO UPDATE SET name=$3,phone=$4,email=$5,birthday=$6,synced_at=NOW()`,
        [salon.id, ycRec.id, ycRec.name||'Клиент', ycRec.phone,
         ycRec.email||null, ycRec.birth_date||null]
      );
    }

    if (resourceType === 'finances_operation') {
      await processFinancesOperation(payload, salon);
    }

    if (wlog) {
      await db.query(
        'UPDATE webhook_logs SET processed=TRUE,processing_ms=$1 WHERE id=$2',
        [Date.now() - t0, wlog.id]
      );
    }
  } catch (e) {
    console.error('[Webhook] ERROR:', e.message);
    try {
      if (wlog?.id) await db.query(
        'UPDATE webhook_logs SET error_message=$1,processing_ms=$2 WHERE id=$3',
        [e.message, Date.now() - t0, wlog.id]
      );
    } catch {}
  }
});


// ============================================================
// GLOBAL API AUTH + ROLE MIDDLEWARE
// ============================================================
// Public paths that don't need authentication
const API_PUBLIC = ['/api/auth/login', '/api/auth/register'];
// Paths accessible to 'specialist' role (prefix match)
const SPECIALIST_ALLOWED_PREFIXES = ['/api/home-care', '/api/auth', '/api/template-settings'];

app.use('/api', (req, res, next) => {
  const fullPath = '/api' + req.path;
  // Skip public routes
  if (API_PUBLIC.includes(fullPath)) return next();
  // Skip webhook (has its own auth)
  if (fullPath.startsWith('/api/yclients/')) return next();

  // Verify JWT if not already done
  if (!req.user) {
    const h = req.headers.authorization;
    const t = h?.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
    if (!t) return res.status(401).json({ error: 'Unauthorized' });
    try { req.user = jwt.verify(t, JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Token expired or invalid' }); }
  }

  // Role-based access: specialist may only access allowed prefixes
  if (req.user.role === 'specialist') {
    const allowed = SPECIALIST_ALLOWED_PREFIXES.some(p => fullPath.startsWith(p));
    if (!allowed) return res.status(403).json({ error: 'Нет доступа' });
  }
  next();
});

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/register', async (req, res) => {
  const pg = await pool.connect();
  try {
    const { salonName, city, email, password } = req.body;
    if (!salonName || !email || !password)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    await pg.query('BEGIN');
    const salon = (await pg.query(
      'INSERT INTO salons (name,city) VALUES ($1,$2) RETURNING id',
      [salonName, city || null]
    )).rows[0];
    await pg.query('INSERT INTO loyalty_settings (salon_id) VALUES ($1)', [salon.id]);
    const hash = await bcrypt.hash(password, 12);
    const user = (await pg.query(
      `INSERT INTO users (salon_id,email,password_hash,name,role)
       VALUES ($1,$2,$3,$4,'owner') RETURNING id,name,email,role`,
      [salon.id, email.toLowerCase().trim(), hash, salonName]
    )).rows[0];
    await pg.query('COMMIT');

    const token = jwt.sign(
      { userId: user.id, salonId: salon.id, role: 'owner' },
      JWT_SECRET, { expiresIn: '7d' }
    );
    await db.query(
      `INSERT INTO sessions (user_id,token,ip,user_agent,expires_at)
       VALUES ($1,$2,$3,$4,NOW()+INTERVAL '7 days')`,
      [user.id, token, req.ip, req.headers['user-agent'] || '']
    );
    res.json({ token, user: { ...user, salonName } });
  } catch (e) {
    await pg.query('ROLLBACK');
    if (e.code === '23505')
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    res.status(500).json({ error: e.message });
  } finally { pg.release(); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Укажите email и пароль' });
    const user = await db.one(
      `SELECT u.*,s.name as salon_name FROM users u
       JOIN salons s ON s.id=u.salon_id
       WHERE u.email=$1 AND u.is_active=TRUE`,
      [email.toLowerCase().trim()]
    );
    if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });

    const token = jwt.sign(
      { userId: user.id, salonId: user.salon_id, role: user.role },
      JWT_SECRET, { expiresIn: '7d' }
    );
    await db.query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [user.id]);
    await db.query(
      `INSERT INTO sessions (user_id,token,ip,user_agent,expires_at)
       VALUES ($1,$2,$3,$4,NOW()+INTERVAL '7 days')`,
      [user.id, token, req.ip, req.headers['user-agent'] || '']
    );
    res.json({ token, user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, salonName: user.salon_name,
      must_change_password: user.must_change_password || false,
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/change-password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 6)
      return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
    const user = await db.one('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    // If must_change_password — skip current_password check (first login)
    if (!user.must_change_password) {
      if (!current_password) return res.status(400).json({ error: 'Укажите текущий пароль' });
      const ok = await bcrypt.compare(current_password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Текущий пароль неверный' });
    }
    const hash = await bcrypt.hash(new_password, 12);
    await db.query(
      'UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2',
      [hash, req.user.userId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  const token = req.headers.authorization?.slice(7);
  await db.query('DELETE FROM sessions WHERE token=$1', [token]).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await db.one(
      `SELECT u.id,u.name,u.email,u.role,u.must_change_password,
              s.name as salon_name,s.yclients_company_id
       FROM users u JOIN salons s ON s.id=u.salon_id WHERE u.id=$1`,
      [req.user.userId]
    );
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// USER MANAGEMENT (owner only)
// ============================================================
app.get('/api/users', auth, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const users = await db.many(
      `SELECT u.id,u.name,u.email,u.role,u.is_active,u.must_change_password,
              u.created_at,u.last_login_at
       FROM users u WHERE u.salon_id=$1 ORDER BY u.created_at`,
      [req.user.salonId]
    );
    const salon = await db.one('SELECT plan,max_users FROM salons WHERE id=$1', [req.user.salonId]);
    const activeCount = users.filter(u => u.is_active).length;
    res.json({ users, plan: salon.plan, max_users: salon.max_users, active_count: activeCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', auth, requireRole('owner'), async (req, res) => {
  try {
    const { name, email, role, password } = req.body;
    if (!name || !email || !role || !password)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (!['admin', 'specialist'].includes(role))
      return res.status(400).json({ error: 'Недопустимая роль' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    const salon = await db.one('SELECT max_users FROM salons WHERE id=$1', [req.user.salonId]);
    const { rows: [{ count }] } = await db.query(
      'SELECT COUNT(*) FROM users WHERE salon_id=$1 AND is_active=TRUE', [req.user.salonId]
    );
    if (parseInt(count) >= salon.max_users)
      return res.status(403).json({ error: `Достигнут лимит пользователей (${salon.max_users}). Обратитесь в поддержку для увеличения лимита.` });

    const hash = await bcrypt.hash(password, 12);
    const user = await db.one(
      `INSERT INTO users (salon_id,email,password_hash,name,role,is_active,must_change_password,created_by)
       VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,$6) RETURNING id,name,email,role,is_active,must_change_password,created_at`,
      [req.user.salonId, email.toLowerCase().trim(), hash, name, role, req.user.userId]
    );
    res.json(user);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/users/:id', auth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, is_active, password } = req.body;
    // Cannot deactivate yourself
    if (parseInt(id) === req.user.userId && is_active === false)
      return res.status(400).json({ error: 'Нельзя деактивировать свой аккаунт' });
    // Cannot change own role
    if (parseInt(id) === req.user.userId && role && role !== req.user.role)
      return res.status(400).json({ error: 'Нельзя изменить свою роль' });

    const updates = [];
    const vals = [];
    let i = 1;
    if (name !== undefined) { updates.push(`name=$${i++}`); vals.push(name); }
    if (role !== undefined) {
      if (!['owner','admin','specialist'].includes(role))
        return res.status(400).json({ error: 'Недопустимая роль' });
      updates.push(`role=$${i++}`); vals.push(role);
    }
    if (is_active !== undefined) { updates.push(`is_active=$${i++}`); vals.push(is_active); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
      const hash = await bcrypt.hash(password, 12);
      updates.push(`password_hash=$${i++}`, `must_change_password=$${i++}`);
      vals.push(hash, true);
    }
    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });

    vals.push(id, req.user.salonId);
    const user = await db.one(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${i++} AND salon_id=$${i}
       RETURNING id,name,email,role,is_active,must_change_password`,
      vals
    );
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.userId)
      return res.status(400).json({ error: 'Нельзя удалить свой аккаунт' });
    await db.query(
      'UPDATE users SET is_active=FALSE WHERE id=$1 AND salon_id=$2',
      [id, req.user.salonId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// SALON
// ============================================================
app.get('/api/salon', auth, async (req, res) => {
  try { res.json(await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/salon', auth, async (req, res) => {
  try {
    const { name, city, timezone, yclients_company_id,
            yclients_card_type_id, yclients_card_type_name } = req.body;
    const { yclients_web_cookie } = req.body;
    await db.query(
      `UPDATE salons SET name=$1,city=$2,timezone=$3,yclients_company_id=$4,
       yclients_card_type_id=$5,yclients_card_type_name=$6,
       yclients_web_cookie=COALESCE($7,yclients_web_cookie),
       updated_at=NOW() WHERE id=$8`,
      [name, city, timezone, yclients_company_id,
       yclients_card_type_id || null, yclients_card_type_name || null,
       yclients_web_cookie || null,
       req.user.salonId]
    );
    // Сбросить кэш сессии при обновлении куки
    if (yclients_web_cookie) delete ycWebSessions[req.user.salonId];
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/salon/yclients-auth', auth, async (req, res) => {
  try {
    const { partnerToken, login, password, chainId } = req.body;
    const d = await ycAuth(partnerToken, login, password);
    await db.query(
      `UPDATE salons SET
         yclients_partner_token=$1, yclients_user_token=$2,
         yclients_login=$3, yclients_password=$4,
         yclients_chain_id=$5,
         updated_at=NOW()
       WHERE id=$6`,
      [partnerToken, d.user_token, login, password,
       chainId || null, req.user.salonId]
    );
    // Сбросить кэш веб-сессии
    delete ycWebSessions[req.user.salonId];
    res.json({ ok: true, userToken: d.user_token });
  } catch (e) {
    console.error('[YC Auth error]', e.message, e.response?.data);
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
// LOYALTY SETTINGS
// ============================================================
app.get('/api/loyalty-settings', auth, async (req, res) => {
  try { res.json(await getLoyaltySettings(req.user.salonId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/loyalty-settings', auth, async (req, res) => {
  try {
    const { levels, service_cashback, birthday_bonus, birthday_days_before, birthday_enabled,
            referral_enabled, referral_bonus_sender, referral_bonus_receiver, bonus_expiry_days,
            bonuses_enabled } = req.body;
    await db.query(
      `INSERT INTO loyalty_settings
         (salon_id,levels,service_cashback,birthday_bonus,birthday_days_before,birthday_enabled,
          referral_enabled,referral_bonus_sender,referral_bonus_receiver,bonus_expiry_days,
          bonuses_enabled,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (salon_id) DO UPDATE SET
         levels=$2,service_cashback=$3,birthday_bonus=$4,birthday_days_before=$5,
         birthday_enabled=$6,referral_enabled=$7,referral_bonus_sender=$8,
         referral_bonus_receiver=$9,bonus_expiry_days=$10,bonuses_enabled=$11,updated_at=NOW()`,
      [req.user.salonId, JSON.stringify(levels), JSON.stringify(service_cashback || {}),
       birthday_bonus, birthday_days_before, birthday_enabled,
       referral_enabled, referral_bonus_sender, referral_bonus_receiver, bonus_expiry_days || 0,
       bonuses_enabled !== false]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// CLIENTS
// ============================================================
app.get('/api/clients', auth, async (req, res) => {
  try {
    const page  = parseInt(req.query.page  || 1);
    const limit = parseInt(req.query.limit || 50);
    const offset = (page - 1) * limit;
    const { orderCol, orderDir, whereSql, params, nextIdx } =
      buildClientsQuery(req.query, req.user.salonId);

    const total = (await db.one(`SELECT COUNT(*) FROM clients c WHERE ${whereSql}`, params)).count;
    const clients = await db.many(
      `SELECT * FROM clients c WHERE ${whereSql}
       ORDER BY ${orderCol} ${orderDir} NULLS LAST
       LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
      [...params, limit, offset]
    );
    res.json({ clients, total: parseInt(total), page });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clients/:id', auth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2',
      [req.params.id, req.user.salonId]
    );
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    // Объединяем loyalty_card_transactions (история карты) + bonus_transactions (ручные операции)
    const history = await db.many(
      `SELECT id,
              COALESCE(txn_date, created_at) as created_at,
              amount,
              title as description,
              type,
              balance_after,
              'card' as source
       FROM loyalty_card_transactions
       WHERE client_id=$1
       UNION ALL
       SELECT id, created_at, amount, description, type, balance_after, 'manual' as source
       FROM bonus_transactions
       WHERE client_id=$1 AND description NOT LIKE '%импорт%'
       ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    const records = await db.many(
      'SELECT * FROM records WHERE client_id=$1 ORDER BY visit_date DESC LIMIT 20',
      [req.params.id]
    );
    res.json({ client, history, records });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients/:id/bonus', auth, async (req, res) => {
  const pg = await pool.connect();
  try {
    const { amount, description } = req.body;
    if (!amount) return res.status(400).json({ error: 'Укажите сумму' });
    await pg.query('BEGIN');
    const client = (await pg.query(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2 FOR UPDATE',
      [req.params.id, req.user.salonId]
    )).rows[0];
    if (!client) { await pg.query('ROLLBACK'); return res.status(404).json({ error: 'Клиент не найден' }); }
    const newBal = Math.max(0, client.bonus_balance + amount);
    await pg.query('UPDATE clients SET bonus_balance=$1,updated_at=NOW() WHERE id=$2', [newBal, client.id]);
    await pg.query(
      `INSERT INTO loyalty_card_transactions
         (salon_id,client_id,yclients_card_id,type,amount,
          balance_after,title,txn_date,created_at)
       VALUES ($1,$2,
         (SELECT yclients_card_id FROM clients WHERE id=$3),
         $4,$5,$6,$7,NOW(),NOW())`,
      [req.user.salonId, client.id, client.id,
       amount > 0 ? 'accrual' : 'redemption',
       amount, newBal,
       description || 'Ручная корректировка']
    );
    await pg.query('COMMIT');
    res.json({ ok: true, newBalance: newBal });
  } catch (e) {
    await pg.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { pg.release(); }
});

// ============================================================
// RECORDS
// ============================================================
app.get('/api/records', auth, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  try {
    const { dateFrom, dateTo, status, page = 1, limit = 50 } = req.query;
    const pageNum  = Math.max(1, parseInt(page));
    const pageSize = Math.min(200, Math.max(10, parseInt(limit)));
    const offset   = (pageNum - 1) * pageSize;

    let where = ['r.salon_id=$1'], params = [req.user.salonId], i = 2;
    if (dateFrom) {
      where.push(`COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) >= $${i}::date`);
      params.push(dateFrom); i++;
    }
    if (dateTo) {
      where.push(`COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date) <= $${i}::date`);
      params.push(dateTo); i++;
    }
    if (status) {
      // Маппинг фильтра → stored status + raw_payload status_id + raw_payload attendance
      // Фильтрация по вычисляемому статусу (из raw_payload) — не по stored status
      // attendance: 2=оказана, 1=пришёл, 0=ожидание, -1=не пришёл
      // status_id: 4=оказана, 3=пришёл, 2=подтверждена, 1=ожидание, 5=отменена, 6=не пришёл, 7=удалена
      const statusMap = {
        completed:  { stored: ['completed'],                sids: [4],     atts: [2] },
        arrived:    { stored: ['arrived'],                  sids: [3],     atts: [1] },
        confirmed:  { stored: ['confirmed', 'waiting'],     sids: [2],     atts: [] },
        waiting:    { stored: ['waiting', 'pending'],       sids: [1],     atts: [0] },
        cancelled:  { stored: ['cancelled'],                sids: [5],     atts: [] },
        no_show:    { stored: ['no_show'],                  sids: [6],     atts: [-1] },
        deleted:    { stored: ['deleted'],                  sids: [7],     atts: [] },
      };
      const map = statusMap[status];
      if (map) {
        where.push(`(
          (r.raw_payload->>'attendance')::int = ANY($${i+2}::int[])
          OR (r.raw_payload->>'status_id')::int = ANY($${i+1}::int[])
          OR (r.status = ANY($${i}::text[])
              AND (r.raw_payload->>'attendance') IS NULL
              AND (r.raw_payload->>'status_id') IS NULL)
        )`);
        params.push(map.stored, map.sids, map.atts);
        i += 3;
      } else {
        where.push(`r.status=$${i}`); params.push(status); i++;
      }
    }
    const w = where.join(' AND ');
    const total = (await db.one(`SELECT COUNT(*) FROM records r WHERE ${w}`, params)).count;
    const records = await db.many(
      `SELECT r.*,
              c.name as client_name, c.phone as client_phone,
              -- Реальная оплаченная сумма из raw_payload (services[].cost_to_pay)
              COALESCE(
                (SELECT SUM((svc->>'cost_to_pay')::numeric)
                 FROM jsonb_array_elements(COALESCE(r.raw_payload->'services','[]'::jsonb)) svc
                 WHERE (svc->>'cost_to_pay') IS NOT NULL),
                (SELECT SUM((svc->>'cost')::numeric)
                 FROM jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
                 WHERE (svc->>'cost') IS NOT NULL),
                r.amount
              ) as real_amount,
              -- Начисленные бонусы из loyalty_card_transactions
              -- Ищем по record_id (может быть internal id ИЛИ yclients_record_id)
              -- + fallback по client_id + дате визита
              (SELECT SUM(lct.amount)
               FROM loyalty_card_transactions lct
               WHERE lct.salon_id = r.salon_id
               AND lct.amount > 0
               AND (
                 lct.record_id = r.id
                 OR lct.record_id = r.yclients_record_id
                 OR (lct.record_id IS NULL AND lct.client_id = r.client_id
                     AND r.visit_date IS NOT NULL
                     AND lct.txn_date::date = r.visit_date::date)
               )
              ) as real_bonus_accrued,
              -- Списанные бонусы (аналогичный поиск)
              (SELECT ABS(SUM(lct.amount))
               FROM loyalty_card_transactions lct
               WHERE lct.salon_id = r.salon_id
               AND lct.amount < 0
               AND (
                 lct.record_id = r.id
                 OR lct.record_id = r.yclients_record_id
                 OR (lct.record_id IS NULL AND lct.client_id = r.client_id
                     AND r.visit_date IS NOT NULL
                     AND lct.txn_date::date = r.visit_date::date)
               )
              ) as real_bonus_redeemed,
              -- Списанные бонусы из raw_payload (скидки из услуг = возможное списание)
              COALESCE(
                (SELECT SUM(GREATEST(0,
                  (svc->>'cost')::numeric - COALESCE((svc->>'cost_to_pay')::numeric, (svc->>'cost')::numeric)
                ))
                 FROM jsonb_array_elements(COALESCE(r.raw_payload->'services','[]'::jsonb)) svc
                 WHERE (svc->>'cost') IS NOT NULL
                   AND (svc->>'discount')::numeric > 0),
                0
              ) as discount_from_payload,
              -- Статус из raw_payload
              COALESCE(
                CASE
                  WHEN (r.raw_payload->>'deleted')::boolean = true THEN 'deleted'
                  -- API формат: attendance (приоритет — точнее чем status_id)
                  WHEN (r.raw_payload->>'attendance') IS NOT NULL THEN
                    CASE (r.raw_payload->>'attendance')::int
                      WHEN  2 THEN 'completed'
                      WHEN  1 THEN 'arrived'
                      WHEN -1 THEN 'no_show'
                      WHEN  0 THEN 'waiting'
                      ELSE r.status
                    END
                  -- Webhook формат: status_id
                  WHEN (r.raw_payload->>'status_id') IS NOT NULL THEN
                    CASE (r.raw_payload->>'status_id')::int
                      WHEN 4 THEN 'completed'
                      WHEN 3 THEN 'arrived'
                      WHEN 2 THEN 'confirmed'
                      WHEN 5 THEN 'cancelled'
                      WHEN 7 THEN 'cancelled'
                      WHEN 6 THEN 'no_show'
                      WHEN 1 THEN 'waiting'
                      ELSE r.status
                    END
                  ELSE r.status
                END,
                r.status
              ) as yclients_status,
              -- Оплачен ли визит полностью (только paid_full=1 — точный признак)
              CASE
                WHEN (r.raw_payload->>'paid_full')::int = 1 THEN true
                ELSE false
              END as is_paid_full,
              -- Дата визита в московском часовом поясе (как строка YYYY-MM-DD, без UTC-сдвига)
              to_char(
                CASE
                  WHEN r.visit_datetime IS NOT NULL
                  THEN (r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date
                  ELSE r.visit_date
                END,
                'YYYY-MM-DD'
              ) as visit_date_msk
       FROM records r LEFT JOIN clients c ON c.id=r.client_id
       WHERE ${w} ORDER BY r.visit_datetime DESC NULLS LAST, r.visit_date DESC, r.id DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...params, pageSize, offset]
    );

    // Обогащаем данные
    const enriched = records.map(r => {
      const bonusRedeemed = parseFloat(r.real_bonus_redeemed || 0);
      const discountPayload = parseFloat(r.discount_from_payload || 0);
      return {
        ...r,
        amount:        parseFloat(r.real_amount || r.amount || 0),
        bonus_accrued: parseFloat(r.real_bonus_accrued || r.bonus_accrued || 0),
        bonus_redeemed: bonusRedeemed > 0 ? bonusRedeemed : discountPayload,
        status:        r.yclients_status || r.status,
      };
    });

    const totalNum = parseInt(total);
    const totalPages = Math.ceil(totalNum / pageSize);
    res.json({
      records: enriched,
      total: totalNum,
      page: pageNum,
      limit: pageSize,
      totalPages,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ANALYTICS
// ============================================================
app.get('/api/analytics/dashboard', auth, async (req, res) => {
  try {
    const sid  = req.user.salonId;
    const days = parseInt(req.query.period || 30);

    // Бонусная статистика из loyalty_card_transactions + bonus_transactions
    // loyalty_card_transactions — история из YClients (импорт + новые через вебхук)
    // bonus_transactions — ручные операции нашей системы
    const bonusStatsSql = `
      SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as accrued,
        COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as redeemed
      FROM (
        -- Из loyalty_card_transactions
        SELECT amount
        FROM loyalty_card_transactions lct
        JOIN clients c ON c.id = lct.client_id
        WHERE c.salon_id = $1
          AND COALESCE(lct.txn_date, lct.created_at) >= NOW() - INTERVAL '${days} days'
        UNION ALL
        -- Из bonus_transactions (только операции НЕ из импорта чтобы не дублировать)
        SELECT amount
        FROM bonus_transactions bt
        WHERE bt.salon_id = $1
          AND bt.created_at >= NOW() - INTERVAL '${days} days'
          AND bt.description NOT LIKE '%импорт%'
      ) combined
    `;

    const [tc, ac, slp, nc, bs, rev, bonusStat, topSvc, lvlDist, daily, recentTx, lastSync, tgCount, cardCount, bonEconomy] = await Promise.all([
      db.one('SELECT COUNT(*) FROM clients WHERE salon_id=$1', [sid]),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND last_visit_at>NOW()-INTERVAL '${days} days'`, [sid]),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND last_visit_at<NOW()-INTERVAL '60 days' AND visits_count>0`, [sid]),
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND created_at>NOW()-INTERVAL '${days} days'`, [sid]),
      db.one(`SELECT COALESCE(SUM(bonus_balance),0) as tb, COALESCE(SUM(total_spent),0) as ts FROM clients WHERE salon_id=$1`, [sid]),
      db.one(`SELECT COUNT(*) as rc, COALESCE(SUM(amount),0) as rv FROM records WHERE salon_id=$1 AND status IN ('completed','confirmed') AND visit_date>=NOW()-INTERVAL '${days} days'`, [sid]),
      db.one(bonusStatsSql, [sid]),
      db.many(`SELECT svc->>'title' as service_name, COUNT(*) as cnt, SUM((svc->>'cost_to_pay')::numeric) as total_amount FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc WHERE r.salon_id=$1 AND r.status IN ('completed','confirmed') AND r.visit_date>=NOW()-INTERVAL '${days} days' AND svc->>'title' IS NOT NULL GROUP BY svc->>'title' ORDER BY cnt DESC LIMIT 8`, [sid]),
      db.many(`SELECT loyalty_level, COUNT(*) as cnt FROM clients WHERE salon_id=$1 GROUP BY loyalty_level`, [sid]),
      // Выручка по дням + бонусы начислено/списано за день
      db.many(`
        WITH rev AS (
          SELECT visit_date::date as d, COUNT(*) as records, COALESCE(SUM(amount),0) as revenue
          FROM records WHERE salon_id=$1 AND status IN ('completed','confirmed')
            AND visit_date >= NOW()-INTERVAL '${days} days'
          GROUP BY visit_date
        ), bon AS (
          SELECT DATE(COALESCE(lct.txn_date, lct.created_at)) as d,
            COALESCE(SUM(CASE WHEN lct.amount > 0 THEN lct.amount ELSE 0 END),0) as bonuses_accrued,
            COALESCE(SUM(CASE WHEN lct.amount < 0 THEN ABS(lct.amount) ELSE 0 END),0) as bonuses_redeemed
          FROM loyalty_card_transactions lct
          JOIN clients c ON c.id=lct.client_id
          WHERE c.salon_id=$1 AND COALESCE(lct.txn_date, lct.created_at) >= NOW()-INTERVAL '${days} days'
          GROUP BY DATE(COALESCE(lct.txn_date, lct.created_at))
        )
        SELECT rev.d::text as visit_date, rev.records, rev.revenue,
          COALESCE(bon.bonuses_accrued, 0) as bonuses_accrued,
          COALESCE(bon.bonuses_redeemed, 0) as bonuses_redeemed
        FROM rev LEFT JOIN bon ON bon.d = rev.d ORDER BY rev.d
      `, [sid]),
      // Последние транзакции — дедупликация по клиент+дата+сумма+заголовок
      db.many(`
        SELECT sub.*, c.name as client_name FROM (
          SELECT DISTINCT ON (client_id, title, txn_date::date, amount)
            lct.id, lct.txn_date as created_at, lct.amount, lct.title as description, lct.client_id
          FROM loyalty_card_transactions lct
          JOIN clients c2 ON c2.id=lct.client_id
          WHERE c2.salon_id=$1
          ORDER BY client_id, title, txn_date::date, amount, lct.txn_date DESC NULLS LAST
        ) sub
        JOIN clients c ON c.id=sub.client_id
        ORDER BY sub.created_at DESC NULLS LAST
        LIMIT 15
      `, [sid]),
      db.one(`SELECT * FROM sync_logs WHERE salon_id=$1 ORDER BY started_at DESC LIMIT 1`, [sid]),
      // Клиенты с Telegram
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND telegram_id IS NOT NULL AND telegram_id!=''`, [sid]),
      // Клиенты с картой лояльности
      db.one(`SELECT COUNT(*) FROM clients WHERE salon_id=$1 AND yclients_card_id IS NOT NULL`, [sid]),
      // Бонусная экономика — разбивка по типу за период
      db.many(`
        SELECT
          CASE
            WHEN lct.title ILIKE '%день рождения%' OR lct.title ILIKE '%ДР%' OR lct.title ILIKE '%подарок%' THEN 'birthday'
            WHEN lct.type = 'redemption' AND lct.title ILIKE '%отмена%' THEN 'cancellation'
            WHEN lct.type = 'redemption' THEN 'redemption'
            ELSE 'accrual'
          END as type,
          COALESCE(SUM(ABS(lct.amount)), 0) as total
        FROM loyalty_card_transactions lct
        JOIN clients c ON c.id=lct.client_id
        WHERE c.salon_id=$1 AND COALESCE(lct.txn_date, lct.created_at) >= NOW()-INTERVAL '${days} days'
        GROUP BY 1
        ORDER BY total DESC
      `, [sid]),
    ]);

    res.json({
      stats: {
        totalClients:      parseInt(tc.count),
        activeClients:     parseInt(ac.count),
        sleepingClients:   parseInt(slp.count),
        newClients:        parseInt(nc.count),
        totalBonusBalance: parseFloat(bs.tb),
        totalSpent:        parseFloat(bs.ts),
        periodRevenue:     parseFloat(rev.rv),
        periodRecords:     parseInt(rev.rc),
        periodBonuses:     parseFloat(bonusStat.accrued),   // начислено за период
        periodRedeemed:    parseFloat(bonusStat.redeemed),  // списано за период
        telegramClients:   parseInt(tgCount.count),
        cardClients:       parseInt(cardCount.count),
      },
      levelDist: lvlDist, topServices: topSvc, dailyRevenue: daily,
      recentTxns: recentTx, syncStatus: lastSync, bonusEconomy: bonEconomy,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics/bonuses', auth, async (req, res) => {
  try {
    const sid  = req.user.salonId;
    const days = parseInt(req.query.period || 30);
    const rows = await db.many(
      `SELECT day::text, SUM(accrued) as accrued, SUM(redeemed) as redeemed FROM (
        -- loyalty_card_transactions
        SELECT DATE_TRUNC('day', COALESCE(lct.txn_date, lct.created_at))::date as day,
          CASE WHEN lct.amount > 0 THEN lct.amount ELSE 0 END as accrued,
          CASE WHEN lct.amount < 0 THEN ABS(lct.amount) ELSE 0 END as redeemed
        FROM loyalty_card_transactions lct
        JOIN clients c ON c.id=lct.client_id
        WHERE c.salon_id=$1
          AND COALESCE(lct.txn_date, lct.created_at) >= NOW()-INTERVAL '${days} days'
        UNION ALL
        -- bonus_transactions (без импорта)
        SELECT DATE_TRUNC('day', bt.created_at)::date as day,
          CASE WHEN bt.amount > 0 THEN bt.amount ELSE 0 END as accrued,
          CASE WHEN bt.amount < 0 THEN ABS(bt.amount) ELSE 0 END as redeemed
        FROM bonus_transactions bt
        WHERE bt.salon_id=$1
          AND bt.created_at >= NOW()-INTERVAL '${days} days'
          AND bt.description NOT LIKE '%импорт%'
      ) combined
      GROUP BY day ORDER BY day`,
      [sid]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics/retention', auth, async (req, res) => {
  try {
    const rows = await db.many(
      `SELECT cohort_month,total,m1,m2,m3 FROM (
         SELECT DATE_TRUNC('month',first_visit) as cohort_month,COUNT(DISTINCT client_id) as total,
           COUNT(DISTINCT CASE WHEN months_since>=1 THEN client_id END) as m1,
           COUNT(DISTINCT CASE WHEN months_since>=2 THEN client_id END) as m2,
           COUNT(DISTINCT CASE WHEN months_since>=3 THEN client_id END) as m3
         FROM (
           SELECT client_id,MIN(visit_date) OVER (PARTITION BY client_id) as first_visit,
                  EXTRACT(YEAR FROM AGE(visit_date,MIN(visit_date) OVER (PARTITION BY client_id)))*12
                    + EXTRACT(MONTH FROM AGE(visit_date,MIN(visit_date) OVER (PARTITION BY client_id))) as months_since
           FROM records WHERE salon_id=$1 AND status='completed' AND client_id IS NOT NULL
         ) t GROUP BY cohort_month
       ) agg
       WHERE cohort_month <= DATE_TRUNC('month', NOW()) - INTERVAL '3 months'
       ORDER BY cohort_month ASC LIMIT 6`,
      [req.user.salonId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// SYNC API
// ============================================================
app.post('/api/sync', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id || !salon.yclients_user_token) {
      return res.status(400).json({ error: 'YClients не настроен. Укажите токены в Настройках.' });
    }
    res.json({ ok: true, message: 'Синхронизация запущена' });
    runSync(salon, 'manual', req.user.userId).catch(e => console.error('[Sync]', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sync/logs', auth, async (req, res) => {
  try {
    res.json(await db.many(
      `SELECT sl.*,u.name as user_name FROM sync_logs sl
       LEFT JOIN users u ON u.id=sl.initiated_by
       WHERE sl.salon_id=$1 ORDER BY sl.started_at DESC LIMIT 20`,
      [req.user.salonId]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Привязать «бесхозные» транзакции к записям по клиенту + дате
app.post('/api/sync/link-transactions', auth, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const result = await db.query(`
      UPDATE loyalty_card_transactions lct
      SET record_id = sub.record_id
      FROM (
        SELECT DISTINCT ON (lct2.id)
               lct2.id AS txn_id,
               r.id    AS record_id
        FROM   loyalty_card_transactions lct2
        JOIN   records r
          ON   r.client_id  = lct2.client_id
          AND  r.salon_id   = lct2.salon_id
          AND  r.visit_date  = lct2.txn_date::date
        WHERE  lct2.salon_id   = $1
          AND  lct2.record_id  IS NULL
          AND  lct2.txn_date   IS NOT NULL
          AND  r.visit_date    IS NOT NULL
          AND  r.status        IN ('completed','confirmed')
        ORDER BY lct2.id, r.visit_datetime DESC
      ) sub
      WHERE lct.id = sub.txn_id
    `, [salonId]);
    const linked = result.rowCount || 0;
    console.log(`[LinkTxns] Linked ${linked} orphan transactions for salon ${salonId}`);
    res.json({ ok: true, linked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/webhook-logs', auth, async (req, res) => {
  try {
    res.json(await db.many(
      'SELECT * FROM webhook_logs WHERE salon_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.salonId]
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/yclients/services', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id) return res.status(400).json({ error: 'YClients не подключён' });
    res.json(await ycGet(salon, `/services/${salon.yclients_company_id}`));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Получить типы карт лояльности из YClients
app.get('/api/yclients/card-types', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id) return res.status(400).json({ error: 'YClients не подключён' });
    const types = await ycGetCardTypes(salon);
    res.json(types);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Получить историю транзакций клиента — из bonus_transactions нашей БД
app.get('/api/clients/:id/card-transactions', auth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2',
      [req.params.id, req.user.salonId]
    );
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });

    // История из loyalty_card_transactions (импорт из YClients)
    const lct = await db.many(
      `SELECT id, txn_date as created_at, amount, title, balance_after, type
       FROM loyalty_card_transactions
       WHERE client_id=$1
       ORDER BY txn_date DESC NULLS LAST
       LIMIT 500`,
      [client.id]
    );

    // История из bonus_transactions (операции нашей системы)
    const bonus = await db.many(
      `SELECT id, created_at, amount, description as title, balance_after, type
       FROM bonus_transactions
       WHERE client_id=$1
       ORDER BY created_at DESC
       LIMIT 200`,
      [client.id]
    );

    res.json({
      local: lct,        // loyalty_card_transactions — для фронтенда
      bonus: bonus,      // bonus_transactions — для фронтенда
      transactions: lct, // обратная совместимость
      card: {
        id:      client.yclients_card_id,
        number:  client.yclients_card_number,
        balance: client.yclients_card_balance || client.bonus_balance,
      },
      summary: {
        totalTransactions: lct.length + bonus.length,
        totalAccrued:  [...lct,...bonus].filter(t=>parseFloat(t.amount)>0).reduce((s,t)=>s+parseFloat(t.amount),0),
        totalRedeemed: [...lct,...bonus].filter(t=>parseFloat(t.amount)<0).reduce((s,t)=>s+Math.abs(parseFloat(t.amount)),0),
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Синхронизировать историю карты клиента
app.post('/api/clients/:id/sync-card', auth, async (req, res) => {
  try {
    const client = await db.one(
      'SELECT * FROM clients WHERE id=$1 AND salon_id=$2',
      [req.params.id, req.user.salonId]
    );
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    if (!client.yclients_client_id) return res.status(400).json({ error: 'Нет yclients_client_id' });

    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_card_type_id) return res.status(400).json({ error: 'Карта лояльности не выбрана в Настройках' });

    // Загрузить карты клиента
    console.log(`[SyncCard] client=${client.id} yclients_id=${client.yclients_client_id} card_type=${salon.yclients_card_type_id}`);
    const cards = await ycGetClientCards(salon, client.yclients_client_id);
    console.log(`[SyncCard] found ${cards.length} cards for client`);
    cards.forEach((c,i) => console.log(`[SyncCard] card[${i}]: id=${c.id} type_id=${c.type?.id} type_title=${c.type?.title} balance=${c.balance} number=${c.number||c.loyalty_card_number}`));

    const card  = cards.find(c =>
      c.type?.id === salon.yclients_card_type_id ||
      String(c.type?.id) === String(salon.yclients_card_type_id)
    );
    if (!card) {
      console.log(`[SyncCard] card type ${salon.yclients_card_type_id} NOT found. Available types: ${cards.map(c=>c.type?.id).join(',')}`);
      return res.json({ ok: false, message: `Карта типа ${salon.yclients_card_type_id} не найдена. Доступно: ${cards.map(c=>c.type?.title||c.type?.id).join(', ')||'нет карт'}` });
    }
    console.log(`[SyncCard] matched card: id=${card.id} balance=${card.balance}`);

    // Данные из карты YClients (paid_amount, visits_count уже есть в объекте карты)
    const cardBalance  = parseFloat(card.balance || 0);
    const paidAmount   = parseFloat(card.paid_amount || card.sold_amount || client.total_spent || 0);
    const visitsCount  = parseInt(card.visits_count || client.visits_count || 0);
    const cardNumber   = card.number || card.loyalty_card_number || null;

    // Определяем уровень лояльности по сумме оплат
    const lsData = await getLoyaltySettings(salon.id);
    const level  = lsData?.levels ? getLevel(paidAmount, lsData.levels) : null;

    await db.query(
      `UPDATE clients SET
         yclients_card_id=$1,
         yclients_card_number=$2,
         yclients_card_balance=$3,
         bonus_balance=$4,
         total_spent=$5,
         visits_count=$6,
         loyalty_level=$7,
         updated_at=NOW()
       WHERE id=$8`,
      [card.id, cardNumber, cardBalance, cardBalance,
       paidAmount, visitsCount,
       level?.key || client.loyalty_level,
       client.id]
    );

    console.log(`[SyncCard] Updated: balance=${cardBalance} paid=${paidAmount} visits=${visitsCount} level=${level?.key}`);

    // История транзакций берётся из CSV-импорта, не из веба
    // Кнопка "Синхронизировать карту" только обновляет баланс и уровень
    const txnsCount = await db.one(
      'SELECT COUNT(*) FROM loyalty_card_transactions WHERE client_id=$1',
      [client.id]
    );

    res.json({
      ok: true,
      cardId:     card.id,
      cardNumber,
      balance:    cardBalance,
      paidAmount,
      visitsCount,
      level:      level?.key || client.loyalty_level,
      transactionsInDb: parseInt(txnsCount.count),
      message: `Карта синхронизирована. Баланс: ${cardBalance.toLocaleString('ru')} ₽ · Визитов: ${visitsCount} · Транзакций в БД: ${txnsCount.count}`
    });
  } catch (e) {
    console.error('[SyncCard error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// BULK IMPORT: История транзакций всех карт (разовая операция)
// ============================================================

// Статус текущего импорта (в памяти)
const bulkImportStatus = {};

app.post('/api/bulk-import-card-history', auth, async (req, res) => {
  const salonId = req.user.salonId;

  // Не запускать если уже идёт
  if (bulkImportStatus[salonId]?.running) {
    return res.json({ ok: false, message: 'Импорт уже запущен', status: bulkImportStatus[salonId] });
  }

  const salon = await db.one('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon.yclients_login) {
    return res.status(400).json({ error: 'Логин YClients не сохранён. Переподключите YClients в Настройках.' });
  }
  if (!salon.yclients_card_type_id) {
    return res.status(400).json({ error: 'Карта лояльности не выбрана в Настройках.' });
  }

  // Ответить сразу, запустить в фоне
  bulkImportStatus[salonId] = {
    running: true, started: new Date(),
    total: 0, done: 0, imported: 0, errors: 0, currentClient: ''
  };
  res.json({ ok: true, message: 'Импорт запущен' });

  // Фоновая задача
  (async () => {
    try {
      // Клиенты у которых есть карта YClients
      const clients = await db.many(
        `SELECT id, name, phone, yclients_client_id, yclients_card_id
         FROM clients
         WHERE salon_id=$1
           AND yclients_card_id IS NOT NULL
           AND yclients_client_id IS NOT NULL
         ORDER BY id`,
        [salonId]
      );

      bulkImportStatus[salonId].total = clients.length;
      console.log(`[BulkImport] Starting for ${clients.length} clients with cards`);

      // Один раз логинимся
      let cookie;
      try {
        cookie = await ycWebLogin(salon);
      } catch (e) {
        bulkImportStatus[salonId].running = false;
        bulkImportStatus[salonId].error = `Ошибка входа: ${e.message}`;
        return;
      }

      for (let i = 0; i < clients.length; i++) {
        const c = clients[i];
        bulkImportStatus[salonId].done = i;
        bulkImportStatus[salonId].currentClient = c.name;

        try {
          // Перечитываем salon каждые 50 клиентов чтобы подхватить изменения chain_id
          if (i % 50 === 0) {
            salon = await db.one('SELECT * FROM salons WHERE id=$1', [salonId]);
            console.log(`[BulkImport] Refreshed salon: chain_id=${salon.yclients_chain_id}`);
          }
          const txns = await ycGetCardTransactions(
            salon, c.yclients_client_id, c.phone, salon.yclients_chain_id
          );

          for (const t of txns) {
            try {
              const txnAmt  = parseFloat(t.amount || 0);
              const txnDate = t.txn_date || null;

              // Единая таблица для всей истории карт
              // Проверка дубля по (client_id, txn_date, amount)
              let isDup = false;
              if (txnDate) {
                const dup = await db.one(
                  `SELECT id FROM loyalty_card_transactions
                   WHERE client_id=$1 AND amount=$2
                   AND txn_date::date = $3::date LIMIT 1`,
                  [c.id, txnAmt, txnDate]
                );
                isDup = !!dup;
              }

              if (!isDup) {
                await db.query(
                  `INSERT INTO loyalty_card_transactions
                     (salon_id, client_id, yclients_card_id, type, amount,
                      title, txn_date, created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
                  [salonId, c.id, c.yclients_card_id,
                   txnAmt >= 0 ? 'accrual' : 'redemption',
                   txnAmt,
                   t.title || (txnAmt >= 0 ? 'Начисление' : 'Списание'),
                   txnDate]
                );
                bulkImportStatus[salonId].imported++;
              }
            } catch (e) {
              console.log(`[BulkImport] txn error client=${c.id}: ${e.message}`);
            }
          }

          // Также обновляем баланс клиента из карты
          const cards = await ycGetClientCards(salon, c.yclients_client_id);
          const card = cards.find(cd =>
            String(cd.type?.id) === String(salon.yclients_card_type_id)
          );
          if (card) {
            const paidAmount = parseFloat(card.paid_amount || card.sold_amount || 0);
            const lsData = await getLoyaltySettings(salonId);
            const level  = lsData?.levels ? getLevel(paidAmount, lsData.levels) : null;
            await db.query(
              `UPDATE clients SET
                 yclients_card_balance=$1, bonus_balance=$2,
                 total_spent=GREATEST(total_spent,$3),
                 visits_count=GREATEST(visits_count,$4),
                 loyalty_level=COALESCE($5,loyalty_level),
                 updated_at=NOW()
               WHERE id=$6`,
              [parseFloat(card.balance||0), parseFloat(card.balance||0),
               paidAmount, parseInt(card.visits_count||0),
               level?.key||null, c.id]
            );
          }

        } catch (e) {
          console.error(`[BulkImport] Error for client ${c.id}:`, e.message);
          bulkImportStatus[salonId].errors++;
          // Сбросить сессию если проблема с авторизацией
          if (e.message.includes('авторизац') || e.message.includes('login')) {
            delete ycWebSessions[salonId];
          }
        }

        // Пауза между клиентами чтобы не перегрузить YClients
        await sleep(500);
      }

      bulkImportStatus[salonId].running = false;
      bulkImportStatus[salonId].done = clients.length;
      bulkImportStatus[salonId].finished = new Date();
      console.log(`[BulkImport] Done. imported=${bulkImportStatus[salonId].imported} errors=${bulkImportStatus[salonId].errors}`);

    } catch (e) {
      bulkImportStatus[salonId].running = false;
      bulkImportStatus[salonId].error = e.message;
      console.error('[BulkImport] Fatal:', e.message);
    }
  })();
});

// Статус импорта (polling с фронтенда)
app.get('/api/bulk-import-card-history/status', auth, async (req, res) => {
  const status = bulkImportStatus[req.user.salonId];
  if (!status) return res.json({ running: false, notStarted: true });
  res.json(status);
});

// Лог финансовых операций
app.get('/api/finances-log', auth, async (req, res) => {
  try {
    const rows = await db.many(
      `SELECT fl.*,c.name as client_name FROM finances_log fl
       LEFT JOIN clients c ON c.id=fl.client_id
       WHERE fl.salon_id=$1 ORDER BY fl.created_at DESC LIMIT 50`,
      [req.user.salonId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
// STAFF ANALYTICS MODULE
// ============================================================

function calcWorkMinutes(from, to) {
  if (!from || !to) return 0;
  const [fh, fm] = (from + ':00').split(':').map(Number);
  const [th, tm] = (to + ':00').split(':').map(Number);
  return Math.max(0, (th * 60 + tm) - (fh * 60 + fm));
}

async function syncStaffData(salon) {
  try {
    const staffList = await ycGet(salon, `/staff/${salon.yclients_company_id}`, { is_fired: 0 });
    if (!Array.isArray(staffList)) return;

    for (const s of staffList) {
      await db.query(`
        INSERT INTO staff_members (salon_id, yclients_staff_id, name, specialization, avatar_url, is_active, synced_at)
        VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
        ON CONFLICT (salon_id, yclients_staff_id) DO UPDATE
          SET name=$3, specialization=$4, avatar_url=$5, is_active=TRUE, synced_at=NOW()
      `, [salon.id, s.id, s.name || 'Сотрудник', s.specialization || null, s.avatar || null]);
    }

    const now = new Date();
    for (let mo = -1; mo <= 0; mo++) {
      const d = new Date(now.getFullYear(), now.getMonth() + mo, 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const startDate = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;

      for (const s of staffList) {
        try {
          const sched = await ycGet(salon, `/schedule/${salon.yclients_company_id}/${s.id}`, {
            date: startDate, count: lastDay
          });
          if (!Array.isArray(sched)) continue;
          for (const day of sched) {
            if (!day.date) continue;
            const wm = day.is_off ? 0 : calcWorkMinutes(day.from, day.to);
            await db.query(`
              INSERT INTO staff_schedule (salon_id, yclients_staff_id, date, from_time, to_time, work_minutes)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (salon_id, yclients_staff_id, date)
              DO UPDATE SET from_time=$4, to_time=$5, work_minutes=$6
            `, [salon.id, s.id, day.date, day.from || null, day.to || null, wm]);
          }
          await new Promise(r => setTimeout(r, 150));
        } catch { /* schedule endpoint may vary by plan */ }
      }
    }
    console.log(`[StaffSync] Salon ${salon.id}: ${staffList.length} staff synced`);
  } catch(e) {
    console.error(`[StaffSync] Error salon ${salon.id}:`, e.message);
  }
}

// ── GOODS SALES SYNC ──────────────────────────────────────────
// Извлекает goods_transactions из raw_payload всех записей салона
// и сохраняет в goods_sales + goods_sale_items.
// Атрибуция продажи — по master_id позиции (кому записана, не кто провёл).
async function syncGoodsSales(salonId) {
  console.log(`[GoodsSync] Salon ${salonId}: starting...`);

  // Берём все записи у которых goods_transactions не пустые
  const records = await db.many(`
    SELECT id, yclients_record_id, client_id, yclients_client_id, visit_date,
           raw_payload->'goods_transactions' AS goods_transactions
    FROM records
    WHERE salon_id = $1
      AND raw_payload->'goods_transactions' IS NOT NULL
      AND raw_payload->'goods_transactions' != 'null'::jsonb
      AND jsonb_array_length(raw_payload->'goods_transactions') > 0
  `, [salonId]);

  console.log(`[GoodsSync] Found ${records.length} records with goods`);

  let inserted = 0, updated = 0;

  for (const rec of records) {
    const items = rec.goods_transactions;
    if (!Array.isArray(items) || !items.length) continue;

    // Сумма всех позиций записи
    const totalAmount = items.reduce((sum, it) => sum + (parseFloat(it.cost_to_pay) || 0), 0);

    // Upsert заголовка продажи
    const sale = await db.one(`
      INSERT INTO goods_sales
        (salon_id, yclients_record_id, source, yclients_client_id, client_id, sale_date, total_amount)
      VALUES ($1, $2, 'record', $3, $4, $5, $6)
      ON CONFLICT (salon_id, yclients_record_id) DO UPDATE
        SET total_amount = EXCLUDED.total_amount,
            synced_at    = NOW()
      RETURNING id, (xmax = 0) AS is_insert
    `, [salonId, rec.yclients_record_id, rec.yclients_client_id,
        rec.client_id, rec.visit_date, totalAmount]);

    if (sale.is_insert) inserted++; else updated++;

    // Upsert позиций
    for (const it of items) {
      await db.query(`
        INSERT INTO goods_sale_items
          (sale_id, yclients_transaction_id, yclients_goods_id, title, article,
           quantity, price_per_unit, total_price, discount,
           assigned_staff_yclients_id, storage_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (yclients_transaction_id) DO UPDATE
          SET sale_id                    = EXCLUDED.sale_id,
              yclients_goods_id          = EXCLUDED.yclients_goods_id,
              title                      = EXCLUDED.title,
              article                    = EXCLUDED.article,
              quantity                   = EXCLUDED.quantity,
              price_per_unit             = EXCLUDED.price_per_unit,
              total_price                = EXCLUDED.total_price,
              discount                   = EXCLUDED.discount,
              assigned_staff_yclients_id = EXCLUDED.assigned_staff_yclients_id,
              storage_id                 = EXCLUDED.storage_id
      `, [
        sale.id,
        it.id,
        it.good_id || null,
        it.title || '',
        it.article || null,
        Math.abs(parseFloat(it.amount) || 1),
        parseFloat(it.cost_per_unit) || 0,
        parseFloat(it.cost_to_pay) || 0,
        parseFloat(it.discount) || 0,
        it.master_id || null,
        it.storage_id || null,
      ]);
    }
  }

  console.log(`[GoodsSync] Done: inserted=${inserted} updated=${updated}`);
  return { inserted, updated, total: records.length };
}

async function getStaffList(salonId) {
  const fromTable = await db.many(
    `SELECT yclients_staff_id AS id, name, specialization, avatar_url
     FROM staff_members WHERE salon_id=$1 AND is_active=TRUE ORDER BY name`,
    [salonId]
  );
  if (fromTable.length > 0) return fromTable;

  return db.many(`
    SELECT DISTINCT
      (se->>'id')::int AS id,
      (se->>'name') AS name,
      (se->>'specialization') AS specialization,
      NULL AS avatar_url
    FROM records r, jsonb_array_elements(r.staff::jsonb) se
    WHERE r.salon_id=$1 AND r.staff IS NOT NULL AND r.staff != '[]'
      AND (se->>'name') IS NOT NULL
    ORDER BY name
  `, [salonId]);
}

async function computeStaffMetrics(salonId, ycStaffId, fromDate, toDate) {
  const sid = parseInt(ycStaffId);
  // В YClients подтверждённые визиты хранятся со статусом 'confirmed'
  const DONE = `status IN ('completed','confirmed')`;
  const CANCELLED = `status IN ('no_show','deleted','cancelled')`;
  const [basic, ret, reapp, sched, consult, goods] = await Promise.all([
    db.one(`
      SELECT
        COUNT(*) FILTER (WHERE ${DONE}) AS visits,
        COALESCE(SUM(amount) FILTER (WHERE ${DONE}), 0) AS revenue,
        COALESCE(AVG(amount) FILTER (WHERE ${DONE}), 0) AS avg_check,
        COUNT(*) FILTER (WHERE ${CANCELLED}) AS cancelled,
        COALESCE(SUM(amount) FILTER (WHERE ${CANCELLED}), 0) AS cancelled_rev
      FROM records WHERE salon_id=$1 AND (staff->>'id')::int = $2
        AND visit_date BETWEEN $3 AND $4
    `, [salonId, sid, fromDate, toDate]),

    db.one(`
      WITH
      period_clients AS (
        SELECT DISTINCT yclients_client_id
        FROM records
        WHERE salon_id=$1 AND (staff->>'id')::int = $2
          AND ${DONE} AND visit_date BETWEEN $3 AND $4
          AND yclients_client_id IS NOT NULL
      ),
      new_clients AS (
        SELECT DISTINCT r.yclients_client_id
        FROM records r
        WHERE r.salon_id=$1 AND (r.staff->>'id')::int = $2
          AND ${DONE} AND r.visit_date BETWEEN $3 AND $4
          AND r.yclients_client_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM records r2
            WHERE r2.salon_id=$1 AND (r2.staff->>'id')::int = $2
              AND ${DONE} AND r2.visit_date < $3
              AND r2.yclients_client_id = r.yclients_client_id
          )
      ),
      base_45 AS (
        SELECT DISTINCT yclients_client_id
        FROM records
        WHERE salon_id=$1 AND (staff->>'id')::int = $2
          AND ${DONE}
          AND visit_date BETWEEN ($3::date - INTERVAL '45 days')::date
                              AND ($3::date - INTERVAL '1 day')::date
          AND yclients_client_id IS NOT NULL
      ),
      returned AS (
        SELECT b.yclients_client_id FROM base_45 b
        JOIN period_clients p USING (yclients_client_id)
      )
      SELECT
        (SELECT COUNT(*) FROM period_clients) AS total,
        (SELECT COUNT(*) FROM new_clients)    AS new_clients,
        (SELECT COUNT(*) FROM base_45)        AS base_45_days,
        (SELECT COUNT(*) FROM returned)       AS returned_count
    `, [salonId, sid, fromDate, toDate]),

    db.one(`
      WITH vis AS (
        SELECT r.id, r.yclients_client_id, r.visit_datetime,
          EXISTS (
            SELECT 1 FROM records r2
            WHERE r2.salon_id=r.salon_id AND r2.yclients_client_id=r.yclients_client_id
              AND r2.id != r.id
              AND (r2.raw_payload::jsonb->>'create_date') IS NOT NULL
              AND (r2.raw_payload::jsonb->>'create_date')::timestamptz
                  BETWEEN r.visit_datetime::timestamptz
                      AND r.visit_datetime::timestamptz + INTERVAL '24 hours'
          ) AS reapp
        FROM records r
        WHERE r.salon_id=$1 AND (r.staff->>'id')::int = $2
          AND ${DONE} AND r.visit_date BETWEEN $3 AND $4
          AND r.visit_datetime IS NOT NULL
      )
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE reapp) AS with_reapp FROM vis
    `, [salonId, sid, fromDate, toDate]),

    // Загрузка: рабочие дни и занятые минуты из raw_payload.seance_length (секунды)
    db.one(`
      SELECT
        COUNT(DISTINCT visit_date) AS working_days,
        COALESCE(SUM(
          CASE WHEN raw_payload IS NOT NULL
                    AND (raw_payload::jsonb->>'seance_length') ~ '^[0-9]+$'
               THEN (raw_payload::jsonb->>'seance_length')::int / 60
               ELSE 0 END
        ), 0) AS booked_mins
      FROM records
      WHERE salon_id=$1 AND (staff->>'id')::int = $2
        AND ${DONE} AND visit_date BETWEEN $3 AND $4
    `, [salonId, sid, fromDate, toDate]),

    db.one(`
      WITH con AS (
        SELECT DISTINCT r.yclients_client_id, r.visit_date
        FROM records r
        CROSS JOIN LATERAL jsonb_array_elements(r.services::jsonb) sv
        JOIN services_config sc ON sc.salon_id=r.salon_id
          AND sc.yclients_service_id=(sv->>'id')::int AND sc.tag='consultation'
        WHERE r.salon_id=$1 AND (r.staff->>'id')::int = $2
          AND ${DONE} AND r.visit_date BETWEEN $3 AND $4
      ),
      conv AS (
        SELECT DISTINCT c.yclients_client_id
        FROM con c WHERE EXISTS (
          SELECT 1 FROM records r2
          WHERE r2.salon_id=$1 AND r2.yclients_client_id=c.yclients_client_id
            AND ${DONE.replace(/r\./g,'')}
            AND r2.visit_date > c.visit_date AND r2.visit_date <= c.visit_date + 30
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(r2.services::jsonb) s2
              CROSS JOIN LATERAL (
                SELECT 1 FROM services_config sc2
                WHERE sc2.salon_id=r2.salon_id
                  AND sc2.yclients_service_id=(s2->>'id')::int AND sc2.tag='consultation'
              ) x
            )
        )
      )
      SELECT COUNT(DISTINCT c.yclients_client_id) AS total,
             COUNT(DISTINCT cv.yclients_client_id) AS converted
      FROM con c LEFT JOIN conv cv ON cv.yclients_client_id=c.yclients_client_id
    `, [salonId, sid, fromDate, toDate]),

    // Продажи товаров по сотруднику за период (атрибуция по master_id позиции)
    db.one(`
      SELECT
        COALESCE(COUNT(gsi.id), 0)        AS count,
        COALESCE(SUM(gsi.total_price), 0) AS revenue
      FROM goods_sale_items gsi
      JOIN goods_sales gs ON gs.id = gsi.sale_id
      WHERE gs.salon_id = $1
        AND gsi.assigned_staff_yclients_id = $2
        AND gs.sale_date BETWEEN $3 AND $4
    `, [salonId, sid, fromDate, toDate]),
  ]);

  const visits       = parseInt(basic.visits) || 0;
  const workingDays  = parseInt(sched.working_days) || 0;
  const bookedMins   = parseInt(sched.booked_mins) || 0;
  // 8-часовой рабочий день = 480 мин — стандарт для медклиники
  const availMins    = workingDays * 480;

  const retTotal    = parseInt(ret.total) || 0;
  const retNew      = parseInt(ret.new_clients) || 0;
  const retBase45   = parseInt(ret.base_45_days) || 0;
  const retReturned = parseInt(ret.returned_count) || 0;

  return {
    totalVisits:        visits,
    totalRevenue:       parseFloat(basic.revenue) || 0,
    avgCheck:           parseFloat(basic.avg_check) || 0,
    cancelledCount:     parseInt(basic.cancelled) || 0,
    cancelledRevenue:   parseFloat(basic.cancelled_rev) || 0,
    // Возвращаемость по методике YClients
    clientsTotal:       retTotal,
    newClients:         retNew,
    returningClients:   retTotal - retNew,
    base45days:         retBase45,
    returnedFrom45:     retReturned,
    retentionRate:      retBase45 > 0 ? parseFloat((retReturned / retBase45 * 100).toFixed(1)) : null,
    reappointmentRate:  reapp.total > 0 ? parseFloat((reapp.with_reapp / reapp.total * 100).toFixed(1)) : 0,
    goodsCount:         parseInt(goods.count) || 0,
    goodsRevenue:       parseFloat(goods.revenue) || 0,
    // Загрузка: занятые минуты / (рабочих дней × 480 мин)
    bookedMins,
    workingDays,
    utilizationRate:    availMins > 0 ? parseFloat(Math.min(100, bookedMins / availMins * 100).toFixed(1)) : null,
    consultConversion:  consult.total > 0 ? parseFloat((consult.converted / consult.total * 100).toFixed(1)) : null,
    totalConsults:      parseInt(consult.total) || 0,
  };
}

async function computeStaffSparklines(salonId, ycStaffId) {
  return db.many(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', visit_date::date), 'YYYY-MM') AS month,
      COUNT(*) FILTER (WHERE status IN ('completed','confirmed')) AS visits,
      COALESCE(AVG(amount) FILTER (WHERE status IN ('completed','confirmed')), 0) AS avg_check,
      COALESCE(SUM(amount) FILTER (WHERE status IN ('completed','confirmed')), 0) AS revenue
    FROM records
    WHERE salon_id=$1 AND (staff->>'id')::int = $2
      AND visit_date >= (CURRENT_DATE - INTERVAL '6 months')::date
    GROUP BY 1 ORDER BY 1
  `, [salonId, parseInt(ycStaffId)]);
}

// ── GET /api/staff-analytics/staff ───────────────────────────
app.get('/api/staff-analytics/staff', auth, async (req, res) => {
  try {
    const staff = await getStaffList(req.user.salonId);
    res.json({ staff });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/staff-analytics/metrics ─────────────────────────
app.get('/api/staff-analytics/metrics', auth, async (req, res) => {
  try {
    const { staffId, from, to } = req.query;
    if (!staffId || !from || !to) return res.status(400).json({ error: 'staffId, from, to required' });

    const days = Math.ceil((new Date(to) - new Date(from)) / 86400000);
    const prevTo   = new Date(new Date(from) - 86400000).toISOString().split('T')[0];
    const prevFrom = new Date(new Date(from) - days * 86400000).toISOString().split('T')[0];

    const [metrics, sparklines, prevMetrics] = await Promise.all([
      computeStaffMetrics(req.user.salonId, staffId, from, to),
      computeStaffSparklines(req.user.salonId, staffId),
      computeStaffMetrics(req.user.salonId, staffId, prevFrom, prevTo),
    ]);
    res.json({ metrics, sparklines, prevMetrics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/staff-analytics/salon-avg ───────────────────────
app.get('/api/staff-analytics/salon-avg', auth, async (req, res) => {
  try {
    const { from, to, excludeStaffId } = req.query;
    let staff = await getStaffList(req.user.salonId);
    // Исключаем текущего сотрудника — сравниваем его с остальными
    if (excludeStaffId) {
      staff = staff.filter(s => String(s.id) !== String(excludeStaffId));
    }
    if (!staff.length) return res.json({ avg: null });

    const all = await Promise.all(
      staff.map(s => computeStaffMetrics(req.user.salonId, s.id, from, to).catch(() => null))
    );
    const valid = all.filter(m => m && m.totalVisits > 0);
    if (!valid.length) return res.json({ avg: null });

    const avg = key => {
      const nonNull = valid.filter(m => m[key] !== null && m[key] !== undefined);
      if (!nonNull.length) return null;
      return nonNull.reduce((s, m) => s + (parseFloat(m[key]) || 0), 0) / nonNull.length;
    };

    // Для товаров: суммарная выручка / суммарное количество позиций по остальным сотрудникам
    const totalGoodsRevenue = valid.reduce((s, m) => s + (parseFloat(m.goodsRevenue) || 0), 0);
    const totalGoodsCount   = valid.reduce((s, m) => s + (parseFloat(m.goodsCount)   || 0), 0);
    const goodsAvgPerItem   = totalGoodsCount > 0 ? totalGoodsRevenue / totalGoodsCount : 0;

    res.json({ avg: {
      avgCheck:          avg('avgCheck'),
      retentionRate:     avg('retentionRate'),
      goodsCount:        avg('goodsCount'),
      goodsRevenue:      avg('goodsRevenue'),
      goodsAvgPerItem,
      reappointmentRate: avg('reappointmentRate'),
      utilizationRate:   avg('utilizationRate'),
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/staff-analytics/sync ───────────────────────────
app.post('/api/staff-analytics/sync', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon?.yclients_company_id) return res.status(400).json({ error: 'YClients не настроен' });
    syncStaffData(salon).catch(e => console.error('[StaffSync manual]', e.message));
    res.json({ ok: true, message: 'Синхронизация запущена' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/goods-sales/sync ────────────────────────────────
app.post('/api/goods-sales/sync', auth, async (req, res) => {
  try {
    const result = await syncGoodsSales(req.user.salonId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/goods-sales/stats ────────────────────────────────
// Быстрая сводка по продажам для проверки данных
app.get('/api/goods-sales/stats', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from, to required' });
    const rows = await db.many(`
      SELECT
        sm.name AS staff_name,
        COUNT(gsi.id)        AS items_count,
        SUM(gsi.quantity)    AS total_qty,
        SUM(gsi.total_price) AS total_revenue
      FROM goods_sale_items gsi
      JOIN goods_sales gs ON gs.id = gsi.sale_id
      LEFT JOIN staff_members sm
        ON sm.salon_id = gs.salon_id
       AND sm.yclients_staff_id = gsi.assigned_staff_yclients_id
      WHERE gs.salon_id = $1
        AND gs.sale_date BETWEEN $2 AND $3
      GROUP BY gsi.assigned_staff_yclients_id, sm.name
      ORDER BY total_revenue DESC NULLS LAST
    `, [req.user.salonId, from, to]);
    res.json({ stats: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/services-config ──────────────────────────────────
app.get('/api/services-config', auth, async (req, res) => {
  try {
    const rows = await db.many(
      'SELECT * FROM services_config WHERE salon_id=$1 ORDER BY service_title',
      [req.user.salonId]
    );
    res.json({ services: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/services-config ──────────────────────────────────
app.put('/api/services-config', auth, async (req, res) => {
  try {
    const { yclients_service_id, service_title, tag } = req.body;
    if (!yclients_service_id) return res.status(400).json({ error: 'yclients_service_id required' });
    if (tag) {
      await db.query(`
        INSERT INTO services_config (salon_id, yclients_service_id, service_title, tag)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (salon_id, yclients_service_id) DO UPDATE SET service_title=$3, tag=$4
      `, [req.user.salonId, yclients_service_id, service_title || null, tag]);
    } else {
      await db.query(
        'DELETE FROM services_config WHERE salon_id=$1 AND yclients_service_id=$2',
        [req.user.salonId, yclients_service_id]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// CSV IMPORT — импорт истории транзакций из CSV файла YClients
// ============================================================

// Парсер CSV с поддержкой кавычек и разных кодировок
function parseCsvBuffer(buf) {
  // Определяем кодировку по BOM
  let str;
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    str = buf.slice(3).toString('utf8'); // UTF-8 BOM
  } else if (buf[0] === 0xFF && buf[1] === 0xFE) {
    str = buf.slice(2).toString('utf16le'); // UTF-16 LE
  } else {
    // Пробуем UTF-8, если не получается — latin1
    try {
      str = buf.toString('utf8');
      if (str.includes('�')) str = buf.toString('latin1');
    } catch { str = buf.toString('latin1'); }
  }

  // Определяем разделитель (;  или ,)
  const firstLine = str.split('\n')[0];
  const sep = firstLine.includes(';') ? ';' : ',';

  const rows = [];
  const lines = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    // Парсим с учётом кавычек
    const cells = [];
    let cur = '', inQ = false;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === sep && !inQ) { cells.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

app.post('/api/import/csv-transactions', auth,
  express.raw({ type: '*/*', limit: '20mb' }),
  async (req, res) => {
  try {
    let fileBuffer = req.body;
    if (!fileBuffer) return res.status(400).json({ error: 'Файл не получен' });
    if (!Buffer.isBuffer(fileBuffer)) fileBuffer = Buffer.from(fileBuffer);

    // Если multipart — извлекаем файл
    if (fileBuffer[0] === 0x2D && fileBuffer[1] === 0x2D) {
      const ct = req.headers['content-type'] || '';
      const bm = ct.match(/boundary=([^;\s]+)/);
      if (bm) {
        const sep = Buffer.from('--' + bm[1].trim());
        let found = false;
        for (let si = 0; si < fileBuffer.length - sep.length; si++) {
          if (fileBuffer.slice(si, si + sep.length).equals(sep)) {
            const hEnd = fileBuffer.indexOf(Buffer.from('\r\n\r\n'), si + sep.length);
            if (hEnd < 0) continue;
            const hdr = fileBuffer.slice(si + sep.length + 2, hEnd).toString();
            if (hdr.includes('filename=')) {
              let end = fileBuffer.indexOf(Buffer.from('\r\n--' + bm[1].trim()), hEnd + 4);
              fileBuffer = end > 0 ? fileBuffer.slice(hEnd + 4, end) : fileBuffer.slice(hEnd + 4);
              found = true; break;
            }
          }
        }
        if (!found) return res.status(400).json({ error: 'Файл не найден в запросе' });
      }
    }

    const rows = parseCsvBuffer(fileBuffer);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV пустой или нечитаемый' });

    // Определяем индексы колонок по заголовку
    const header = rows[0].map(h => h.replace(/['"\s]/g, '').toLowerCase());
    console.log('[CsvImport] header:', header.join('|'));

    // Колонки YClients: Дата|ID филиала|Название|Тип|Акция|Тип карты|Номер карты|Клиент|Сумма|Баланс
    const colDate   = header.findIndex(h => h.includes('дат'));
    const colType   = header.findIndex(h => h.includes('тип') && !h.includes('карт'));
    const colCard   = header.findIndex(h => h.includes('номер') || h.includes('карт') && h.includes('номер') || (h.includes('карт') && !h.includes('тип')));
    const colClient = header.findIndex(h => h.includes('клиент'));
    const colAmt    = header.findIndex(h => h.includes('сумм'));
    const colBal    = header.findIndex(h => h.includes('баланс'));
    const colComment= header.findIndex(h => h.includes('акци') || h.includes('коммент'));

    // Запасной поиск номера карты
    const colCardFinal = colCard >= 0 ? colCard : header.findIndex(h => h.includes('карт'));

    console.log('[CsvImport] cols: date=' + colDate + ' card=' + colCardFinal + ' client=' + colClient + ' amt=' + colAmt + ' bal=' + colBal);

    const salonId = req.user.salonId;
    let imported = 0, skipped = 0, errors = 0;

    for (let ri = 1; ri < rows.length; ri++) {
      const row = rows[ri];
      if (!row || row.length < 3) continue;

      try {
        const dateStr  = colDate >= 0 ? String(row[colDate] || '').trim() : '';
        const txnType  = colType >= 0 ? String(row[colType] || '').trim() : '';
        const cardNum  = colCardFinal >= 0 ? String(row[colCardFinal] || '').replace(/['"]/g,'').trim() : '';
        const clientRaw= colClient >= 0 ? String(row[colClient] || '').trim() : '';
        const amtRaw   = colAmt >= 0 ? String(row[colAmt] || '').replace(/[^\d.\-]/g,'') : '';
        const balRaw   = colBal >= 0 ? String(row[colBal] || '').replace(/[^\d.\-]/g,'') : '';
        const comment  = colComment >= 0 ? String(row[colComment] || '').trim() : txnType;

        if (!dateStr) continue;

        const amount  = parseFloat(amtRaw) || 0;
        const balance = parseFloat(balRaw) || 0;
        if (!amount) { skipped++; continue; }

        const type = amount >= 0 ? 'accrual' : 'redemption';

        let txnDate = null;
        try { txnDate = new Date(dateStr); if (isNaN(txnDate)) txnDate = null; } catch {}

        // Извлекаем телефон из поля клиента (+7...)
        const phoneMatch = clientRaw.match(/[\d]{10,11}/);
        const phone = phoneMatch ? phoneMatch[0].slice(-10) : '';

        // Ищем клиента по номеру карты
        let client = null;
        if (cardNum) {
          const cardStripped = cardNum.replace(/^0+/, '');
          client = await db.one(
            `SELECT id, yclients_card_id FROM clients
             WHERE salon_id=$1 AND yclients_card_number IS NOT NULL
             AND (yclients_card_number=$2 OR yclients_card_number=$3
                  OR yclients_card_number LIKE $4)
             LIMIT 1`,
            [salonId, cardNum, cardStripped, '%' + cardStripped]
          );
        }
        // По телефону
        if (!client && phone) {
          client = await db.one(
            `SELECT id, yclients_card_id FROM clients
             WHERE salon_id=$1 AND regexp_replace(phone,'[^0-9]','','g') LIKE $2 LIMIT 1`,
            [salonId, '%' + phone]
          );
        }

        if (!client) {
          if (skipped < 3) console.log('[CsvImport] Not found: card=' + cardNum + ' phone=' + phone);
          skipped++; continue;
        }

        // Дедупликация — точно по дате+времени и сумме
        if (txnDate) {
          const dup = await db.one(
            `SELECT id FROM loyalty_card_transactions
             WHERE client_id=$1 AND amount=$2
             AND txn_date BETWEEN $3::timestamptz - INTERVAL '30 seconds'
                              AND $3::timestamptz + INTERVAL '30 seconds'
             LIMIT 1`,
            [client.id, amount, txnDate]
          );
          if (dup) { skipped++; continue; }
        } else {
          // Без даты — по сумме+балансу
          const dup = await db.one(
            `SELECT id FROM loyalty_card_transactions
             WHERE client_id=$1 AND amount=$2 AND balance_after=$3
             AND txn_date IS NULL LIMIT 1`,
            [client.id, amount, balance]
          );
          if (dup) { skipped++; continue; }
        }

        await db.query(
          `INSERT INTO loyalty_card_transactions
             (salon_id,client_id,yclients_card_id,type,amount,
              balance_after,title,txn_date,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
          [salonId, client.id, client.yclients_card_id,
           type, amount, balance,
           comment || txnType || (amount >= 0 ? 'Начисление' : 'Списание'),
           txnDate]
        );
        imported++;

      } catch(e) {
        errors++;
        if (errors <= 3) console.log('[CsvImport] row ' + ri + ' error: ' + e.message);
      }
    }

    console.log('[CsvImport] Done: imported=' + imported + ' skipped=' + skipped + ' errors=' + errors + ' total=' + (rows.length-1));
    res.json({ ok: true, imported, skipped, errors, totalRows: rows.length - 1 });

  } catch(e) {
    console.error('[CsvImport]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// CRON
// ============================================================
cron.schedule('0 10 * * *', async () => {
  console.log('[Cron] Birthday bonuses...');
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
             (salon_id,client_id,yclients_card_id,type,amount,
              balance_after,title,txn_date,created_at)
           VALUES ($1,$2,
             (SELECT yclients_card_id FROM clients WHERE id=$3),
             'accrual',$4,$5,'🎂 Подарок на день рождения',NOW(),NOW())`,
          [salon.id, c.id, c.id, bonus, c.bonus_balance + bonus]
        );
        console.log(`[Birthday] ${c.name} +${bonus}`);
      }
    }
  } catch (e) { console.error('[Cron birthday]', e.message); }
}, { timezone: 'Europe/Moscow' });

cron.schedule('0 */3 * * *', async () => {
  console.log('[Cron] Auto-sync...');
  try {
    const salons = await db.many(
      `SELECT * FROM salons WHERE is_active=TRUE
       AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`
    );
    for (const salon of salons) {
      runSync(salon, 'auto').catch(e => console.error(`[AutoSync ${salon.id}]`, e.message));
      syncGoodsCategories(salon).catch(e => console.error(`[GoodsCatSync ${salon.id}]`, e.message));
    }
  } catch (e) { console.error('[Cron sync]', e.message); }
});

cron.schedule('0 * * * *', async () => {
  try {
    const salons = await db.many(
      `SELECT * FROM salons WHERE is_active=TRUE
       AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`
    );
    for (const salon of salons) {
      syncStaffData(salon).catch(e => console.error(`[StaffSync cron ${salon.id}]`, e.message));
    }
  } catch(e) { console.error('[StaffSync cron]', e.message); }
});

// ============================================================
// SEGMENTS ENGINE
// ============================================================

// Segment definitions — order matters for priority
const SEGMENT_DEFS = [
  // blacklist first
  { key: 'blacklist',         zone: 'blacklist',  rank: null, label: 'Чёрный список',      emoji: '🚫', color: '#6b7280' },
  // waiting zone (future appointment)
  { key: 'waiting_champion',  zone: 'waiting',    rank: 3,    label: 'Ожидаем чемпиона',  emoji: '⏳', color: '#8b5cf6' },
  { key: 'waiting_growing',   zone: 'waiting',    rank: 2,    label: 'Ожидаем растущего', emoji: '⏳', color: '#7c3aed' },
  { key: 'waiting_newcomer',  zone: 'waiting',    rank: 1,    label: 'Ожидаем новичка',   emoji: '⏳', color: '#6d28d9' },
  // post-visit (< 7 days since last visit)
  { key: 'post_visit',        zone: 'post_visit', rank: null, label: 'После визита',       emoji: '✅', color: '#10b981' },
  // active zone
  { key: 'champion',          zone: 'active',     rank: 3,    label: 'Чемпион',            emoji: '🏆', color: '#f59e0b' },
  { key: 'growing',           zone: 'active',     rank: 2,    label: 'Растущий',           emoji: '📈', color: '#3b82f6' },
  { key: 'newcomer',          zone: 'active',     rank: 1,    label: 'Новичок',            emoji: '🌱', color: '#06b6d4' },
  // risk zone
  { key: 'champion_risk',     zone: 'risk',       rank: 3,    label: 'Чемпион в риске',   emoji: '⚠️', color: '#f97316' },
  { key: 'growing_risk',      zone: 'risk',       rank: 2,    label: 'Растущий в риске',  emoji: '⚠️', color: '#fb923c' },
  { key: 'newcomer_risk',     zone: 'risk',       rank: 1,    label: 'Новичок в риске',   emoji: '⚠️', color: '#fbbf24' },
  // sleeping zone
  { key: 'sleeping_champion', zone: 'sleeping',   rank: 3,    label: 'Спящий чемпион',    emoji: '💤', color: '#6366f1' },
  { key: 'sleeping_growing',  zone: 'sleeping',   rank: 2,    label: 'Спящий растущий',   emoji: '💤', color: '#818cf8' },
  { key: 'sleeping_newcomer', zone: 'sleeping',   rank: 1,    label: 'Спящий новичок',    emoji: '💤', color: '#a5b4fc' },
  // no visits
  { key: 'no_visit',          zone: 'no_visit',   rank: 0,    label: 'Без визитов',        emoji: '👤', color: '#9ca3af' },
];
const SEG_MAP = Object.fromEntries(SEGMENT_DEFS.map(s => [s.key, s]));

// Calculate the return window (avg days between visits) for a salon
async function calcReturnWindow(salonId) {
  const { rows } = await db.query(`
    SELECT ROUND(AVG(gap_days))::int AS w FROM (
      SELECT client_id,
        (visit_date - LAG(visit_date) OVER (PARTITION BY client_id ORDER BY visit_date)) AS gap_days
      FROM records
      WHERE salon_id = $1
        AND status IN ('completed','confirmed')
        AND visit_date < CURRENT_DATE
        AND visit_date IS NOT NULL
    ) t
    WHERE gap_days > 1 AND gap_days < 365
  `, [salonId]);
  const w = rows[0]?.w;
  return (w && w > 7) ? w : 45; // default 45 days if not enough data
}

// Classify a single client row into a segment key
function classifyClient(c, returnWindow) {
  if (c.is_blacklisted) return 'blacklist';

  const rank = c.visits_count >= 5 ? 3 : c.visits_count >= 3 ? 2 : c.visits_count >= 1 ? 1 : 0;
  if (rank === 0) return 'no_visit';

  // Future appointment?
  if (c.has_future_appointment) {
    return rank === 3 ? 'waiting_champion' : rank === 2 ? 'waiting_growing' : 'waiting_newcomer';
  }

  const daysSince = c.days_since_visit ?? 9999;

  // Post-visit: < 7 days
  if (daysSince <= 7) return 'post_visit';

  // Active: within return window
  if (daysSince <= returnWindow) {
    return rank === 3 ? 'champion' : rank === 2 ? 'growing' : 'newcomer';
  }

  // Risk: returnWindow < daysSince <= returnWindow * 2.5
  if (daysSince <= returnWindow * 2.5) {
    return rank === 3 ? 'champion_risk' : rank === 2 ? 'growing_risk' : 'newcomer_risk';
  }

  // Sleeping
  return rank === 3 ? 'sleeping_champion' : rank === 2 ? 'sleeping_growing' : 'sleeping_newcomer';
}

// Full segment refresh for one salon — writes to client_segments table
async function refreshSegments(salonId) {
  const returnWindow = await calcReturnWindow(salonId);

  // Fetch all clients with derived fields.
  // IMPORTANT: clients.last_visit_at is only updated for 'completed' records,
  // but many salons never move records to completed (stay as 'confirmed').
  // So we compute actual_last_visit from the records table directly.
  const { rows: clients } = await db.query(`
    SELECT
      c.id,
      c.name,
      c.phone,
      c.visits_count,
      c.total_spent,
      c.bonus_balance,
      c.loyalty_level,
      COALESCE(c.is_blacklisted, FALSE) AS is_blacklisted,
      -- Actual last past visit: max visit_date for past records (any non-deleted status)
      -- Falls back to clients.last_visit_at for clients with no records in DB
      COALESCE(
        MAX(r.visit_date) FILTER (
          WHERE r.visit_date < CURRENT_DATE
            AND r.status IN ('completed','confirmed','no_show')
        ),
        c.last_visit_at
      ) AS actual_last_visit,
      -- Days since last past visit (DATE subtraction gives integer days)
      CASE
        WHEN MAX(r.visit_date) FILTER (WHERE r.visit_date < CURRENT_DATE AND r.status IN ('completed','confirmed','no_show')) IS NOT NULL
          THEN (CURRENT_DATE - MAX(r.visit_date) FILTER (WHERE r.visit_date < CURRENT_DATE AND r.status IN ('completed','confirmed','no_show')))::float
        WHEN c.last_visit_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (NOW() - c.last_visit_at))/86400
        ELSE NULL
      END AS days_since_visit,
      -- Future appointment: any record with visit_date >= today
      -- 'waiting' = not yet confirmed, 'confirmed' = confirmed by client
      -- 'completed' with future date = pre-paid booking
      BOOL_OR(
        r.visit_date >= CURRENT_DATE
        AND r.status IN ('waiting','confirmed','completed')
      ) AS has_future_appointment,
      COALESCE(c.visits_count, 0) AS visits_count
    FROM clients c
    LEFT JOIN records r ON r.client_id = c.id AND r.salon_id = $1
    WHERE c.salon_id = $1
    GROUP BY c.id, c.name, c.phone, c.visits_count, c.last_visit_at,
             c.total_spent, c.bonus_balance, c.loyalty_level, c.is_blacklisted
  `, [salonId]);

  if (!clients.length) return { total: 0, returnWindow };

  // Classify each client
  const values = clients.map(c => {
    const segKey = classifyClient(c, returnWindow);
    const def = SEG_MAP[segKey];
    return {
      salon_id: salonId,
      client_id: c.id,
      segment_key: segKey,
      rank: def?.rank ?? null,
      zone: def?.zone ?? 'unknown',
      days_since_visit: c.days_since_visit != null ? Math.round(c.days_since_visit) : null,
      return_window: returnWindow,
    };
  });

  // Upsert in batches of 500
  const BATCH = 500;
  for (let i = 0; i < values.length; i += BATCH) {
    const batch = values.slice(i, i + BATCH);
    const placeholders = batch.map((_, j) => {
      const base = j * 7;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},NOW())`;
    }).join(',');
    const params = batch.flatMap(v => [v.salon_id, v.client_id, v.segment_key, v.rank, v.zone, v.days_since_visit, v.return_window]);
    await db.query(`
      INSERT INTO client_segments
        (salon_id, client_id, segment_key, rank, zone, days_since_visit, return_window, updated_at)
      VALUES ${placeholders}
      ON CONFLICT (salon_id, client_id) DO UPDATE SET
        segment_key      = EXCLUDED.segment_key,
        rank             = EXCLUDED.rank,
        zone             = EXCLUDED.zone,
        days_since_visit = EXCLUDED.days_since_visit,
        return_window    = EXCLUDED.return_window,
        updated_at       = NOW()
    `, params);
  }

  // Remove stale rows (clients no longer in salon)
  await db.query(`
    DELETE FROM client_segments
    WHERE salon_id = $1
      AND client_id NOT IN (SELECT id FROM clients WHERE salon_id = $1)
  `, [salonId]);

  return { total: values.length, returnWindow };
}

// Add segment refresh to cron (every hour alongside staff sync)
cron.schedule('30 * * * *', async () => {
  try {
    const salons = await db.many(
      `SELECT id FROM salons WHERE is_active=TRUE`
    );
    for (const s of salons) {
      refreshSegments(s.id).catch(e => console.error(`[Segments cron ${s.id}]`, e.message));
    }
  } catch(e) { console.error('[Segments cron]', e.message); }
});

// ── GET /api/segments — summary grid ──────────────────────────
app.get('/api/segments', auth, async (req, res) => {
  try {
    const salonId = req.user.salonId;

    // Trigger refresh if data is stale (> 1 hour) or missing
    const { rows: [meta] } = await db.query(
      `SELECT MAX(updated_at) AS last_updated, COUNT(*) AS total FROM client_segments WHERE salon_id=$1`,
      [salonId]
    );
    const staleMinutes = meta?.last_updated
      ? (Date.now() - new Date(meta.last_updated).getTime()) / 60000
      : Infinity;

    if (staleMinutes > 60 || !meta?.total) {
      await refreshSegments(salonId);
    }

    // Get stats per segment
    const { rows: stats } = await db.query(`
      SELECT
        cs.segment_key,
        COUNT(*)                                        AS client_count,
        COALESCE(SUM(c.total_spent), 0)                AS total_spent,
        COALESCE(AVG(c.total_spent), 0)                AS avg_spent,
        COALESCE(AVG(c.visits_count), 0)               AS avg_visits,
        MAX(cs.return_window)                          AS return_window
      FROM client_segments cs
      JOIN clients c ON c.id = cs.client_id AND c.salon_id = cs.salon_id
      WHERE cs.salon_id = $1
      GROUP BY cs.segment_key
    `, [salonId]);

    // Total with visits (for percentage calculations)
    const { rows: [totals] } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE visits_count > 0)  AS with_visits,
        COUNT(*)                                   AS all_clients,
        COALESCE(SUM(total_spent), 0)              AS total_revenue
      FROM clients WHERE salon_id = $1
    `, [salonId]);

    const statsMap = Object.fromEntries(stats.map(s => [s.segment_key, s]));

    const segments = SEGMENT_DEFS.map(def => {
      const s = statsMap[def.key] || {};
      const count = parseInt(s.client_count || 0);
      const withVisits = parseInt(totals.with_visits || 1);
      return {
        key: def.key,
        label: def.label,
        emoji: def.emoji,
        color: def.color,
        zone: def.zone,
        rank: def.rank,
        client_count: count,
        pct: withVisits > 0 ? Math.round(count / parseInt(totals.all_clients || 1) * 100 * 10) / 10 : 0,
        total_spent: Math.round(parseFloat(s.total_spent || 0)),
        avg_check: Math.round(parseFloat(s.avg_spent || 0)),
        avg_visits: Math.round(parseFloat(s.avg_visits || 0) * 10) / 10,
        return_window: parseInt(s.return_window || 0),
      };
    });

    const salon = await db.one('SELECT yclients_company_id FROM salons WHERE id=$1', [salonId]);
    res.json({
      segments,
      totals: {
        all_clients:         parseInt(totals.all_clients || 0),
        with_visits:         parseInt(totals.with_visits || 0),
        total_revenue:       Math.round(parseFloat(totals.total_revenue || 0)),
        return_window:       segments.find(s => s.return_window > 0)?.return_window || 45,
        last_updated:        meta?.last_updated || null,
        yclients_company_id: salon?.yclients_company_id || null,
      }
    });
  } catch(e) { console.error('[Segments]', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /api/segments/:key/clients — clients in a segment ──────
const SEG_CLIENTS_SQL = `
  SELECT
    c.id, c.yclients_client_id, c.name, c.phone, c.email,
    c.visits_count, c.total_spent, c.bonus_balance, c.loyalty_level, c.last_visit_at,
    cs.days_since_visit, cs.zone
  FROM client_segments cs
  JOIN clients c ON c.id = cs.client_id AND c.salon_id = cs.salon_id
  WHERE cs.salon_id = $1
    AND cs.segment_key = $2
    AND ($3 = '' OR c.name ILIKE '%'||$3||'%' OR c.phone ILIKE '%'||$3||'%')
  ORDER BY c.total_spent DESC NULLS LAST
`;

app.get('/api/segments/:key/clients', auth, async (req, res) => {
  try {
    const { key } = req.params;
    const { page = 1, limit = 30, search = '' } = req.query;
    const salonId = req.user.salonId;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { rows: clients } = await db.query(
      SEG_CLIENTS_SQL + ' LIMIT $4 OFFSET $5',
      [salonId, key, search, limit, offset]
    );
    const { rows: [cnt] } = await db.query(`
      SELECT COUNT(*) AS total
      FROM client_segments cs
      JOIN clients c ON c.id = cs.client_id AND c.salon_id = cs.salon_id
      WHERE cs.salon_id = $1 AND cs.segment_key = $2
        AND ($3 = '' OR c.name ILIKE '%'||$3||'%' OR c.phone ILIKE '%'||$3||'%')
    `, [salonId, key, search]);

    res.json({ clients, total: parseInt(cnt.total), page: parseInt(page), limit: parseInt(limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/segments/:key/export — CSV export (token via query param for direct download) ──
function authOrQuery(req, res, next) {
  const h = req.headers.authorization;
  const t = h?.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); } catch { res.status(401).json({ error: 'Token expired' }); }
}
app.get('/api/segments/:key/export', authOrQuery, async (req, res) => {
  try {
    const { key } = req.params;
    const { search = '' } = req.query;
    const salonId = req.user.salonId;
    const seg = SEG_MAP[key];
    const label = seg?.label || key;

    const { rows } = await db.query(SEG_CLIENTS_SQL, [salonId, key, search]);

    const cols = ['Имя','Телефон','Email','Визитов','Сумма (₽)','Дней с последнего визита','Уровень лояльности','Последний визит'];
    const toCsv = (v) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const c of rows) {
      lines.push([
        c.name || '',
        c.phone || '',
        c.email || '',
        c.visits_count || 0,
        Math.round(parseFloat(c.total_spent || 0)),
        c.days_since_visit != null ? Math.round(c.days_since_visit) : '',
        c.loyalty_level || '',
        c.last_visit_at ? new Date(c.last_visit_at).toLocaleDateString('ru') : '',
      ].map(toCsv).join(','));
    }

    const bom = '\uFEFF';
    const csv = bom + lines.join('\r\n');
    const filename = encodeURIComponent(`segment_${label}_${new Date().toISOString().slice(0,10)}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/segments/refresh — manual refresh ────────────────
app.post('/api/segments/refresh', auth, async (req, res) => {
  try {
    const result = await refreshSegments(req.user.salonId);
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/clients/:id/blacklist — toggle blacklist ──────────
app.put('/api/clients/:id/blacklist', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { blacklisted } = req.body;
    await db.query(
      `UPDATE clients SET is_blacklisted = $1 WHERE id = $2 AND salon_id = $3`,
      [blacklisted, id, req.user.salonId]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Home Care catalog helpers ──────────────────────────────────
app.get('/api/home-care/products', auth, async (req, res) => {
  try {
    const { search = '', limit = 10 } = req.query;
    const rows = await db.many(
      `SELECT DISTINCT ON (lower(trim(title))) title, yclients_goods_id as id
       FROM goods_sale_items gsi
       JOIN goods_sales gs ON gs.id = gsi.sale_id
       WHERE gs.salon_id = $1
         AND ($2 = '' OR title ILIKE '%' || $2 || '%')
         AND title IS NOT NULL AND trim(title) != ''
       ORDER BY lower(trim(title)), title
       LIMIT $3`,
      [req.user.salonId, search, parseInt(limit)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/home-care/services', auth, async (req, res) => {
  try {
    const { search = '', limit = 10 } = req.query;
    const rows = await db.many(
      `SELECT DISTINCT ON (lower(trim(svc->>'title'))) svc->>'title' AS title, (svc->>'id')::text AS id
       FROM records r, jsonb_array_elements(COALESCE(r.services, '[]'::jsonb)) svc
       WHERE r.salon_id = $1
         AND svc->>'title' IS NOT NULL AND trim(svc->>'title') != ''
         AND ($2 = '' OR svc->>'title' ILIKE '%' || $2 || '%')
       ORDER BY lower(trim(svc->>'title')), svc->>'title'
       LIMIT $3`,
      [req.user.salonId, search, parseInt(limit)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Service tree: services grouped by category (from visit records)
// Service tree: categories + services from YClients (with fallback to local records)
app.get('/api/home-care/service-tree', auth, async (req, res) => {
  try {
    const { search = '' } = req.query;
    const salonId = req.user.salonId;

    // Use cache for full (no search) requests
    if (!search) {
      const cached = getTreeCache(salonId);
      if (cached && cached.services) return res.json(cached.services);
    }

    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [salonId]);
    let grouped = {};

    if (salon.yclients_company_id && salon.yclients_user_token) {
      const cats = await ycGet(salon, `/service_categories/${salon.yclients_company_id}`);
      const catMap = {};
      for (const c of (cats || [])) catMap[c.id] = c.title;

      const services = await ycGet(salon, `/services/${salon.yclients_company_id}`);
      for (const s of (services || [])) {
        if (!s.title) continue;
        if (search && !s.title.toLowerCase().includes(search.toLowerCase())) continue;
        const cat = catMap[s.category_id] || 'Без категории';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(s.title);
      }
    } else {
      const { rows } = await db.query(
        `SELECT DISTINCT ON (lower(trim(svc->>'title'))) svc->>'title' AS title
         FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
         WHERE r.salon_id=$1 AND svc->>'title' IS NOT NULL AND trim(svc->>'title')!=''
           AND ($2='' OR svc->>'title' ILIKE '%'||$2||'%')
         ORDER BY lower(trim(svc->>'title'))`,
        [salonId, search]
      );
      grouped['Услуги'] = rows.map(r => r.title);
    }

    const result = Object.entries(grouped).sort(([a],[b])=>a.localeCompare(b,'ru')).map(([cat,items])=>({cat,items}));
    if (!search) setTreeCache(salonId, 'services', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reusable: sync goods categories for a salon object
async function syncGoodsCategories(salon) {
  const cid = salon.yclients_company_id;
  if (!cid || !salon.yclients_user_token) return { updated: 0, failed: 0, total: 0 };

  // Step 1: category id → title
  let catMap = {};
  try {
    const cats = await ycGet(salon, `/good_categories/${cid}`);
    if (Array.isArray(cats)) for (const c of cats) if (c.id != null && c.title) catMap[c.id] = c.title;
  } catch (_) {}

  // Step 2: bulk goods → goodId → categoryTitle
  let goodCatMap = {};
  try {
    let page = 1;
    while (true) {
      const goods = await ycGet(salon, `/goods/${cid}`, { count: 200, page });
      if (!Array.isArray(goods) || !goods.length) break;
      for (const g of goods) {
        if (g.id == null) continue;
        if (g.category && typeof g.category === 'object' && g.category.title) goodCatMap[g.id] = g.category.title;
        else if (g.category && typeof g.category === 'string') goodCatMap[g.id] = g.category;
        else if (g.category_id != null && catMap[g.category_id]) goodCatMap[g.id] = catMap[g.category_id];
      }
      if (goods.length < 200) break;
      page++;
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (_) {}

  // Step 3: update DB
  const { rows } = await db.query(
    `SELECT DISTINCT yclients_goods_id FROM goods_sale_items gsi
     JOIN goods_sales gs ON gs.id = gsi.sale_id
     WHERE gs.salon_id = $1 AND yclients_goods_id IS NOT NULL`,
    [salon.id]
  );
  if (!rows.length) return { updated: 0, failed: 0, total: 0 };

  let updated = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const goodId = rows[i].yclients_goods_id;
    try {
      let category = goodCatMap[goodId];
      if (!category) {
        const data = await ycGet(salon, `/goods/${cid}/${goodId}`);
        if (data.category && typeof data.category === 'object') category = data.category.title;
        else if (data.category && typeof data.category === 'string') category = data.category;
        else if (data.category_id != null && catMap[data.category_id]) category = catMap[data.category_id];
        if (i > 0 && i % 10 === 0) await new Promise(r => setTimeout(r, 300));
      }
      if (category) {
        await db.query(
          `UPDATE goods_sale_items SET yclients_category = $1 WHERE yclients_goods_id = $2 AND yclients_category IS DISTINCT FROM $1`,
          [category, goodId]
        );
        updated++;
      }
    } catch (_) { failed++; }
  }

  clearTreeCache(salon.id);
  return { updated, failed, total: rows.length, categories: Object.keys(catMap).length };
}

app.post('/api/home-care/sync-goods-categories', auth, async (req, res) => {
  try {
    const salon = await db.one('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
    if (!salon.yclients_company_id || !salon.yclients_user_token)
      return res.status(400).json({ error: 'YClients не подключён' });
    const result = await syncGoodsCategories(salon);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Product tree: goods grouped by real YClients category (in-memory cache, no search param needed for full tree)
app.get('/api/home-care/product-tree', auth, async (req, res) => {
  try {
    const { search = '' } = req.query;
    const salonId = req.user.salonId;

    // Use cache for full (no search) requests
    if (!search) {
      const cached = getTreeCache(salonId);
      if (cached && cached.products) return res.json(cached.products);
    }

    // Fetch goods with their synced YClients category
    const { rows } = await db.query(
      `SELECT DISTINCT ON (lower(trim(title))) title, yclients_category
       FROM goods_sale_items gsi
       JOIN goods_sales gs ON gs.id = gsi.sale_id
       WHERE gs.salon_id = $1
         AND title IS NOT NULL AND trim(title) != ''
         AND ($2 = '' OR lower(title) LIKE '%' || lower($2) || '%')
       ORDER BY lower(trim(title)) LIMIT 600`,
      [salonId, search]
    );

    // Group by category (null/empty → 'Без категории' — run sync to fix)
    const grouped = {};
    for (const r of rows) {
      const cat = (r.yclients_category || '').trim() || 'Без категории';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(r.title);
    }

    const result = Object.entries(grouped).sort(([a],[b])=>a.localeCompare(b,'ru')).map(([cat,items])=>({cat,items}));
    if (!search) setTreeCache(salonId, 'products', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// HOME CARE
// ============================================================

// List
app.get('/api/home-care', auth, async (req, res) => {
  try {
    const { search = '', page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const rows = await db.many(
      `SELECT p.id, p.created_at, p.updated_at, p.notes,
              c.id as client_id, c.name as client_name, c.phone as client_phone,
              u.name as specialist_name
       FROM home_care_prescriptions p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users u ON u.id = p.specialist_id
       WHERE p.salon_id = $1
         AND ($2 = '' OR c.name ILIKE '%' || $2 || '%' OR c.phone ILIKE '%' || $2 || '%')
       ORDER BY p.created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.user.salonId, search, parseInt(limit), offset]
    );
    const total = await db.one(
      `SELECT COUNT(*) FROM home_care_prescriptions p
       LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.salon_id = $1
         AND ($2 = '' OR c.name ILIKE '%' || $2 || '%' OR c.phone ILIKE '%' || $2 || '%')`,
      [req.user.salonId, search]
    );
    res.json({ rows, total: parseInt(total.count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get single
app.get('/api/home-care/:id', auth, async (req, res) => {
  try {
    const p = await db.one(
      `SELECT p.*, c.name as client_name, c.phone as client_phone, u.name as specialist_name, s.name as salon_name
       FROM home_care_prescriptions p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users u ON u.id = p.specialist_id
       LEFT JOIN salons s ON s.id = p.salon_id
       WHERE p.id = $1 AND p.salon_id = $2`,
      [req.params.id, req.user.salonId]
    );
    if (!p) return res.status(404).json({ error: 'Not found' });
    const items = await db.many(
      `SELECT * FROM home_care_items WHERE prescription_id = $1 ORDER BY time_of_day, sort_order`,
      [req.params.id]
    );
    res.json({ ...p, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create
app.post('/api/home-care', auth, async (req, res) => {
  try {
    const { client_id, face_procedures, body_procedures, hair_procedures, vitamins, notes, items = [] } = req.body;
    const p = await db.one(
      `INSERT INTO home_care_prescriptions
         (salon_id, client_id, specialist_id, face_procedures, body_procedures, hair_procedures, vitamins, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.salonId, client_id || null, req.user.userId,
       face_procedures || null, body_procedures || null, hair_procedures || null,
       vitamins || null, notes || null]
    );
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.query(
        `INSERT INTO home_care_items (prescription_id, time_of_day, category, product_name, instructions, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.id, it.time_of_day, it.category, it.product_name, it.instructions || null, i]
      );
    }
    res.json({ id: p.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update
app.put('/api/home-care/:id', auth, async (req, res) => {
  try {
    const { client_id, face_procedures, body_procedures, hair_procedures, vitamins, notes, items = [] } = req.body;
    const existing = await db.one(
      `SELECT id FROM home_care_prescriptions WHERE id=$1 AND salon_id=$2`,
      [req.params.id, req.user.salonId]
    );
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await db.query(
      `UPDATE home_care_prescriptions SET client_id=$1, face_procedures=$2, body_procedures=$3,
         hair_procedures=$4, vitamins=$5, notes=$6, updated_at=NOW()
       WHERE id=$7`,
      [client_id || null, face_procedures || null, body_procedures || null,
       hair_procedures || null, vitamins || null, notes || null, req.params.id]
    );
    await db.query(`DELETE FROM home_care_items WHERE prescription_id=$1`, [req.params.id]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.query(
        `INSERT INTO home_care_items (prescription_id, time_of_day, category, product_name, instructions, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, it.time_of_day, it.category, it.product_name, it.instructions || null, i]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete
app.delete('/api/home-care/:id', auth, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM home_care_prescriptions WHERE id=$1 AND salon_id=$2`,
      [req.params.id, req.user.salonId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ── Template Settings ──────────────────────────────────────
// ============================================================

app.get('/api/template-settings', auth, async (req, res) => {
  try {
    const row = await db.one(
      `SELECT template_logo_url, template_wm_url, template_accent_color, template_bg_color,
              template_text_color, template_logo_line1, template_logo_line2, template_subtitle,
              template_contact_phone, template_contact_web, template_contact_social
       FROM salons WHERE id=$1`, [req.user.salonId]
    );
    res.json(row || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/template-settings', auth, async (req, res) => {
  try {
    const {
      template_accent_color, template_bg_color, template_text_color,
      template_logo_line1, template_logo_line2, template_subtitle,
      template_contact_phone, template_contact_web, template_contact_social,
    } = req.body;
    await db.query(
      `UPDATE salons SET
        template_accent_color=$1, template_bg_color=$2, template_text_color=$3,
        template_logo_line1=$4, template_logo_line2=$5, template_subtitle=$6,
        template_contact_phone=$7, template_contact_web=$8, template_contact_social=$9
       WHERE id=$10`,
      [template_accent_color, template_bg_color, template_text_color,
       template_logo_line1, template_logo_line2, template_subtitle,
       template_contact_phone, template_contact_web, template_contact_social,
       req.user.salonId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/template-settings/upload/:type', auth, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const type = req.params.type; // 'logo' or 'wm'
    if (!['logo', 'wm'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const col = type === 'logo' ? 'template_logo_url' : 'template_wm_url';
    const url = `/uploads/${req.file.filename}`;
    try {
      await db.query(`UPDATE salons SET ${col}=$1 WHERE id=$2`, [url, req.user.salonId]);
      res.json({ ok: true, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// Helper: convert a relative /uploads/... URL to an absolute one for embedding in HTML
function toAbsUrl(relUrl) {
  if (!relUrl) return null;
  if (/^https?:\/\//.test(relUrl)) return relUrl;
  // Convert to base64 data URL by reading the file from disk
  try {
    const filePath = path.join(__dirname, '../frontend', relUrl);
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      return `data:${mime};base64,${data.toString('base64')}`;
    }
  } catch (_) {}
  return `http://localhost:${process.env.PORT || 3001}${relUrl}`;
}

// Helper: load template config from DB, merged with defaults
async function loadTemplateConfig(salonId, salonName) {
  const row = await db.one(
    `SELECT template_logo_url, template_wm_url, template_accent_color, template_bg_color,
            template_text_color, template_logo_line1, template_logo_line2, template_subtitle,
            template_contact_phone, template_contact_web, template_contact_social
     FROM salons WHERE id=$1`, [salonId]
  ).catch(() => null);
  const parts = (salonName || '').trim().split(/\s+/);
  const base = {
    ...BRAND_CONFIG,
    logoLine1: parts[0] || 'PERI',
    logoLine2: parts.slice(1).join(' ') || 'CLINIC',
  };
  if (!row) return base;
  return {
    ...base,
    ...(row.template_logo_line1 && { logoLine1: row.template_logo_line1 }),
    ...(row.template_logo_line2 !== null && row.template_logo_line2 !== undefined && { logoLine2: row.template_logo_line2 }),
    ...(row.template_subtitle   && { subtitle: row.template_subtitle }),
    ...(row.template_accent_color && { accentColor: row.template_accent_color }),
    ...(row.template_bg_color   && { bgColor: row.template_bg_color }),
    ...(row.template_text_color && { textColor: row.template_text_color }),
    ...(row.template_logo_url   && { logoImageUrl: toAbsUrl(row.template_logo_url) }),
    ...(row.template_wm_url     && { wmImageUrl:   toAbsUrl(row.template_wm_url) }),
    ...(row.template_contact_phone  && { contactPhone: row.template_contact_phone }),
    ...(row.template_contact_web    && { contactWeb: row.template_contact_web }),
    ...(row.template_contact_social && { contactSocial: row.template_contact_social }),
  };
}

// HTML-превью (тот же шаблон, без puppeteer — быстро открывается в браузере)
app.get('/api/home-care/:id/preview', auth, async (req, res) => {
  try {
    const p = await db.one(
      `SELECT p.*, c.name as client_name, c.phone as client_phone,
              u.name as specialist_name, s.name as salon_name
       FROM home_care_prescriptions p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users u ON u.id = p.specialist_id
       LEFT JOIN salons s ON s.id = p.salon_id
       WHERE p.id = $1 AND p.salon_id = $2`,
      [req.params.id, req.user.salonId]
    );
    if (!p) return res.status(404).json({ error: 'Not found' });
    const items = await db.many(
      `SELECT * FROM home_care_items WHERE prescription_id=$1 ORDER BY time_of_day, sort_order`,
      [req.params.id]
    );
    const config = await loadTemplateConfig(req.user.salonId, p.salon_name);
    const html = buildHomeCareHtml({ ...p, items }, config);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PDF — генерация через puppeteer
app.get('/api/home-care/:id/pdf', auth, async (req, res) => {
  let browser;
  try {
    const p = await db.one(
      `SELECT p.*, c.name as client_name, c.phone as client_phone,
              u.name as specialist_name, s.name as salon_name
       FROM home_care_prescriptions p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN users u ON u.id = p.specialist_id
       LEFT JOIN salons s ON s.id = p.salon_id
       WHERE p.id = $1 AND p.salon_id = $2`,
      [req.params.id, req.user.salonId]
    );
    if (!p) return res.status(404).json({ error: 'Not found' });
    const items = await db.many(
      `SELECT * FROM home_care_items WHERE prescription_id=$1 ORDER BY time_of_day, sort_order`,
      [req.params.id]
    );
    const prescription = { ...p, items };
    const config = await loadTemplateConfig(req.user.salonId, prescription.salon_name);
    const html = buildHomeCareHtml(prescription, config);

    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    // Give web fonts (Google Fonts) a moment to finish loading
    await page.evaluate(() => new Promise(r => setTimeout(r, 1200)));
    const pdfData = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top:'10mm', bottom:'12mm', left:'13mm', right:'13mm' },
    });
    await browser.close();
    // puppeteer ≥22 returns Uint8Array; convert to Buffer for Express
    const pdf = Buffer.isBuffer(pdfData) ? pdfData : Buffer.from(pdfData);

    const clientName = (prescription.client_name || 'назначение').replace(/[^а-яёa-z0-9_\- ]/gi,'').slice(0,30);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Домашний уход — ' + clientName)}.pdf`);
    res.send(pdf);
  } catch (e) {
    if (browser) await browser.close().catch(()=>{});
    console.error('[PDF]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3001;
pool.connect()
  .then(async client => {
    // ── Migrations ────────────────────────────────────────────
    await client.query(`
      ALTER TABLE loyalty_settings
        ADD COLUMN IF NOT EXISTS bonuses_enabled BOOLEAN NOT NULL DEFAULT TRUE
    `).catch(() => {});
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS finances_log_record_id_unique
      ON finances_log (yclients_record_id)
    `).catch(() => {});
    await client.query(`
      ALTER TABLE finances_log
        ADD COLUMN IF NOT EXISTS cashback_amount NUMERIC DEFAULT 0
    `).catch(() => {});
    // ── Staff analytics tables ─────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_members (
        id SERIAL PRIMARY KEY,
        salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
        yclients_staff_id INTEGER NOT NULL,
        name VARCHAR(255),
        specialization VARCHAR(255),
        avatar_url TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        synced_at TIMESTAMP,
        UNIQUE(salon_id, yclients_staff_id)
      )
    `).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_schedule (
        id SERIAL PRIMARY KEY,
        salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
        yclients_staff_id INTEGER NOT NULL,
        date DATE NOT NULL,
        from_time VARCHAR(10),
        to_time VARCHAR(10),
        work_minutes INTEGER DEFAULT 0,
        UNIQUE(salon_id, yclients_staff_id, date)
      )
    `).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS services_config (
        id SERIAL PRIMARY KEY,
        salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
        yclients_service_id INTEGER NOT NULL,
        service_title VARCHAR(255),
        tag VARCHAR(50),
        UNIQUE(salon_id, yclients_service_id)
      )
    `).catch(() => {});
    // ── Home Care tables ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS home_care_prescriptions (
        id SERIAL PRIMARY KEY,
        salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
        client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
        specialist_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        face_procedures TEXT,
        body_procedures TEXT,
        hair_procedures TEXT,
        vitamins TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`
      CREATE TABLE IF NOT EXISTS home_care_items (
        id SERIAL PRIMARY KEY,
        prescription_id INTEGER REFERENCES home_care_prescriptions(id) ON DELETE CASCADE,
        time_of_day VARCHAR(20) NOT NULL,
        category VARCHAR(100) NOT NULL,
        product_name TEXT NOT NULL,
        instructions TEXT,
        sort_order INTEGER DEFAULT 0
      )
    `).catch(() => {});
    // ── Goods category column ─────────────────────────────────
    await client.query(`
      ALTER TABLE goods_sale_items ADD COLUMN IF NOT EXISTS yclients_category VARCHAR(200)
    `).catch(() => {});
    // ── Client blacklist flag ──────────────────────────────────
    await client.query(`
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_blacklisted BOOLEAN NOT NULL DEFAULT FALSE
    `).catch(() => {});
    // ── Client segments table ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS client_segments (
        salon_id         INTEGER NOT NULL,
        client_id        INTEGER NOT NULL,
        segment_key      VARCHAR(40) NOT NULL,
        rank             SMALLINT,
        zone             VARCHAR(20),
        days_since_visit INTEGER,
        return_window    INTEGER,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (salon_id, client_id)
      )
    `).catch(() => {});
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_client_segments_salon_key
        ON client_segments (salon_id, segment_key)
    `).catch(() => {});
    // ── Role-based access: user management columns ────────────
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id)`).catch(() => {});
    await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS plan VARCHAR(20) NOT NULL DEFAULT 'basic'`).catch(() => {});
    await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS max_users INTEGER NOT NULL DEFAULT 5`).catch(() => {});
    // ── Template settings columns ──────────────────────────────
    const tmplCols = [
      'template_logo_url TEXT',
      'template_wm_url TEXT',
      'template_accent_color VARCHAR(20)',
      'template_bg_color VARCHAR(20)',
      'template_text_color VARCHAR(20)',
      'template_logo_line1 VARCHAR(100)',
      'template_logo_line2 VARCHAR(100)',
      'template_subtitle VARCHAR(200)',
      'template_contact_phone VARCHAR(100)',
      'template_contact_web VARCHAR(200)',
      'template_contact_social VARCHAR(200)',
    ];
    for (const col of tmplCols) {
      await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    }
    client.release();
    app.listen(PORT, () => {
      console.log(`✓ LoyalPro server running on port ${PORT}`);
      console.log(`  Webhook endpoint: POST /yclients/webhook.v2/:companyId`);
      console.log(`  Register: POST /api/auth/register`);
    });
  })
  .catch(e => {
    console.error('✗ PostgreSQL error:', e.message);
    app.listen(PORT, () => console.log(`⚠ Server started WITHOUT DB on port ${PORT}`));
  });
