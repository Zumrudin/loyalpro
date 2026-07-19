// ============================================================
// YClients API Service
// ============================================================
const axios = require('axios');
const config = require('../config');
const { createLogger } = require('../logger');
const logger = createLogger('YClients');

const YC = config.YC;

// In-memory cache: web session cookies per salonId
const ycWebSessions = {};

// In-memory cache: product/service trees per salonId
const _treeCache = {};
function getTreeCache(salonId) { return _treeCache[salonId] || null; }
function setTreeCache(salonId, key, data) {
  if (!_treeCache[salonId]) _treeCache[salonId] = {};
  _treeCache[salonId][key] = data;
  _treeCache[salonId].ts = Date.now();
}
function clearTreeCache(salonId) { delete _treeCache[salonId]; }

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

async function ycGetCardTypes(salon) {
  const { data } = await axios.get(
    `${YC}/loyalty/card_types/salon/${salon.yclients_company_id}`,
    { headers: ycHeaders(salon), timeout: 15000 }
  );
  if (!data.success) return [];
  return data.data || [];
}

async function ycGetClientCards(salon, yclClientsId) {
  try {
    const { data } = await axios.get(
      `${YC}/loyalty/client_cards/${yclClientsId}`,
      { headers: ycHeaders(salon), timeout: 15000 }
    );
    logger.info(`client=${yclClientsId} success=${data.success} count=${Array.isArray(data.data)?data.data.length:'n/a'}`);
    if (Array.isArray(data.data) && data.data.length > 0) {
      logger.info(`first card keys: ${Object.keys(data.data[0]).join(',')}`);
      logger.info(`first card sample: ${JSON.stringify(data.data[0]).slice(0,400)}`);
    }
    if (!data.success) return [];
    return data.data || [];
  } catch (e) {
    logger.error(`error for client ${yclClientsId}: ${e.message}`);
    return [];
  }
}

async function ycWebLogin(salon) {
  const cached = ycWebSessions[salon.id];
  if (cached && Date.now() - cached.ts < 4 * 60 * 60 * 1000) return cached.cookie;

  if (!salon.yclients_web_cookie)
    throw new Error('Куки YClients не заданы. Вставьте куки браузера в Настройках.');

  logger.info(`Using manual cookie for salon ${salon.id} (len=${salon.yclients_web_cookie.length})`);
  ycWebSessions[salon.id] = { cookie: salon.yclients_web_cookie, ts: Date.now() };
  return salon.yclients_web_cookie;
}

async function ycGetCardTransactions(salon, clientYcId, phone, chainId) {
  try {
    const cookie    = await ycWebLogin(salon);
    const companyId = salon.yclients_company_id;
    const groupId   = chainId || salon.yclients_chain_id || companyId;
    const phoneClean = String(phone || '').replace(/\D/g, '');

    if (groupId === companyId) {
      logger.warn(`WARNING: groupId == companyId (${companyId}). Chain ID не настроен!`);
    }
    logger.info(`groupId=${groupId} companyId=${companyId} clientYcId=${clientYcId} phone=${phoneClean}`);

    const urlsToTry = phoneClean
      ? [
          `https://yclients.com/loyalty_cards/get_client_loyalty_cards_json/${groupId}/${companyId}/${clientYcId}/${phoneClean}?show_redesign_view=false&_=${Date.now()}`,
          `https://yclients.com/loyalty_cards/get_client_loyalty_cards_json/${groupId}/${companyId}/${clientYcId}?show_redesign_view=false&_=${Date.now()}`,
        ]
      : [
          `https://yclients.com/loyalty_cards/get_client_loyalty_cards_json/${groupId}/${companyId}/${clientYcId}?show_redesign_view=false&_=${Date.now()}`,
        ];

    const url = urlsToTry[0];
    logger.info(`GET ${url}`);

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
    logger.info(`status=${resp.status} success=${resp.data?.success}`);

    if (!resp.data?.success && urlsToTry.length > 1) {
      logger.info(`Trying fallback URL (without phone)`);
      resp = await axios.get(urlsToTry[1], { headers: reqHeaders, validateStatus: s=>s<500, timeout:15000 });
      logger.info(`Fallback status=${resp.status} success=${resp.data?.success}`);
    }

    if (resp.status === 404) { logger.info(`404 — client not found`); return []; }
    if (!resp.data?.success) { logger.info(`Not success: ${JSON.stringify(resp.data).slice(0,200)}`); return []; }

    const html = resp.data.html || '';
    logger.info(`Got HTML, length=${html.length}`);
    const txns = parseCardTransactionsHtml(html);
    logger.info(`Parsed ${txns.length} transactions`);
    return txns;

  } catch (e) {
    logger.error(`WebTxns error: ${e.message}`);
    delete ycWebSessions[salon.id];
    return [];
  }
}

function parseCardTransactionsHtml(html) {
  const txns = [];
  const dateRegex   = /data-locator="tr_data">\s*([\d.]+)\s*<\/div>/g;
  const amountRegex = /col-xs-2 text-right">\s*([-\d.]+)\s*<\/div>/g;
  const titleRegex  = /(?:data-locator="tr_amount"|<span>)([^<]{3,100})<\/span>/g;

  const dates = [], amounts = [], titles = [];
  let m;
  while ((m = dateRegex.exec(html))   !== null) dates.push(m[1].trim());
  while ((m = amountRegex.exec(html)) !== null) amounts.push(parseFloat(m[1].trim()));
  while ((m = titleRegex.exec(html))  !== null) {
    const t = m[1].trim();
    if (t && !t.includes('показать') && !t.includes('Показать') && t.length > 2) titles.push(t);
  }

  const len = Math.min(dates.length, amounts.length);
  for (let i = 0; i < len; i++) {
    let txnDate = null;
    try {
      const parts = dates[i].split('.');
      if (parts.length === 3) txnDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).toISOString();
    } catch {}
    txns.push({
      id: null, date: dates[i], txn_date: txnDate, amount: amounts[i],
      title: titles[i] || (amounts[i] >= 0 ? 'Начисление' : 'Списание'),
      type: amounts[i] >= 0 ? 'accrual' : 'redemption',
    });
  }
  return txns;
}

async function ycAccrueCard(salon, cardId, amount, title) {
  const { data } = await axios.post(
    `${YC}/company/${salon.yclients_company_id}/loyalty/cards/${cardId}/manual_transaction`,
    { amount, title },
    { headers: ycHeaders(salon), timeout: 15000 }
  );
  if (!data.success) throw new Error(data.meta?.message || 'Card transaction failed');
  return data.data;
}

async function ycListFinanceTransactions(salon, { dateFrom, dateTo, page = 1, count = 200 } = {}) {
  return ycGet(salon, `/transactions/${salon.yclients_company_id}`, {
    start_date: dateFrom,
    end_date: dateTo,
    page,
    count,
  });
}

// Сумма платежей клиента за медуслуги («Оказание услуг») за период [dateFrom..dateTo]
// напрямую из YClients. Эндпоинт фильтрует по client_id на сервере; пагинируем
// до пустой страницы. Категорию определяем тем же классификатором, что и при
// записи revenue_operations (expense.title → 'services').
async function ycSumServicePayments(salon, clientId, dateFrom, dateTo) {
  const { classifyExpense } = require('./revenue');
  let page = 1, total = 0;
  for (;;) {
    const txns = await ycGet(salon, `/transactions/${salon.yclients_company_id}`, {
      start_date: dateFrom, end_date: dateTo, client_id: clientId, count: 200, page,
    });
    if (!Array.isArray(txns) || txns.length === 0) break;
    for (const t of txns) {
      if (classifyExpense(t.expense && t.expense.title) === 'services') {
        total += parseFloat(t.amount) || 0;
      }
    }
    if (txns.length < 200) break;
    page++;
  }
  return Math.round(total * 100) / 100;
}

// ── Каталог услуг с ДОСТОВЕРНОЙ привязкой мастеров ───────────────────────────
// Поле service.staff в общем ответе /services/{cid} НЕДОСТОВЕРНО: YClients кладёт
// туда лишь урезанный набор мастеров (у части мастеров услуги теряются). Правда
// доступна только через запрос услуг по КАЖДОМУ мастеру: /services/{cid}?staff_id=.
// Поэтому строим карту service→staff объединением per-staff ответов.
// Возвращает { priced, categories, staffIdsByService: Map<svcIdStr, Set<staffIdStr>> }.
const _svcCatalogCache = {};                 // salonId → { ts, data }
const SVC_CATALOG_TTL = 2 * 60 * 1000;       // 2 мин: режем нагрузку, окно устаревания мало

async function ycGetServiceCatalog(salon, staffIds = []) {
  const cid = salon && salon.yclients_company_id;
  if (!cid) return { priced: [], categories: [], staffIdsByService: new Map() };

  const key = salon.id;
  const cached = _svcCatalogCache[key];
  if (cached && (Date.now() - cached.ts) < SVC_CATALOG_TTL) return cached.data;

  const uniqStaff = [...new Set((staffIds || []).map(String))].filter(Boolean);
  const [catalog, categories, ...perStaff] = await Promise.all([
    ycGet(salon, `/services/${cid}`).catch(() => []),
    ycGet(salon, `/service_categories/${cid}`).catch(() => []),
    ...uniqStaff.map(id => ycGet(salon, `/services/${cid}`, { staff_id: id })
      .then(d => ({ id, services: Array.isArray(d) ? d : [] }))
      .catch(() => ({ id, services: [] }))),
  ]);

  const priced = (Array.isArray(catalog) ? catalog : []).filter(s => Number(s.price_max) > 0);
  const staffIdsByService = new Map();
  // Достоверная цена per-staff: в ответе /services?staff_id={id} price_min/price_max
  // относятся к цене этого мастера за услугу. staffPricesByService: svcIdStr →
  // Map<staffIdStr, {price_min, price_max}>. Нужна, т.к. цена процедуры может
  // отличаться между специалистами (врач vs. главный врач).
  const staffPricesByService = new Map();
  for (const { id, services } of perStaff) {
    for (const s of services) {
      const k = String(s.id);
      if (!staffIdsByService.has(k)) staffIdsByService.set(k, new Set());
      staffIdsByService.get(k).add(String(id));
      if (!staffPricesByService.has(k)) staffPricesByService.set(k, new Map());
      staffPricesByService.get(k).set(String(id), {
        price_min: Number(s.price_min) || 0,
        price_max: Number(s.price_max) || 0,
      });
    }
  }
  const data = { priced, categories: Array.isArray(categories) ? categories : [], staffIdsByService, staffPricesByService };
  _svcCatalogCache[key] = { ts: Date.now(), data };
  return data;
}

function clearServiceCatalogCache(salonId) { delete _svcCatalogCache[salonId]; }

module.exports = {
  ycHeaders, ycGet, ycPost, ycAuth,
  ycGetCardTypes, ycGetClientCards, ycWebLogin, ycGetCardTransactions,
  parseCardTransactionsHtml, ycAccrueCard, ycListFinanceTransactions, ycSumServicePayments,
  ycWebSessions,
  getTreeCache, setTreeCache, clearTreeCache,
  ycGetServiceCatalog, clearServiceCatalogCache,
};
