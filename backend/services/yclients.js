// ============================================================
// YClients API Service
// ============================================================
const axios = require('axios');
const config = require('../config');

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

async function ycWebLogin(salon) {
  const cached = ycWebSessions[salon.id];
  if (cached && Date.now() - cached.ts < 4 * 60 * 60 * 1000) return cached.cookie;

  if (!salon.yclients_web_cookie)
    throw new Error('Куки YClients не заданы. Вставьте куки браузера в Настройках.');

  console.log(`[WebLogin] Using manual cookie for salon ${salon.id} (len=${salon.yclients_web_cookie.length})`);
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
      console.warn(`[WebTxns] WARNING: groupId == companyId (${companyId}). Chain ID не настроен!`);
    }
    console.log(`[WebTxns] groupId=${groupId} companyId=${companyId} clientYcId=${clientYcId} phone=${phoneClean}`);

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

    if (!resp.data?.success && urlsToTry.length > 1) {
      console.log(`[WebTxns] Trying fallback URL (without phone)`);
      resp = await axios.get(urlsToTry[1], { headers: reqHeaders, validateStatus: s=>s<500, timeout:15000 });
      console.log(`[WebTxns] Fallback status=${resp.status} success=${resp.data?.success}`);
    }

    if (resp.status === 404) { console.log(`[WebTxns] 404 — client not found`); return []; }
    if (!resp.data?.success) { console.log(`[WebTxns] Not success:`, JSON.stringify(resp.data).slice(0,200)); return []; }

    const html = resp.data.html || '';
    console.log(`[WebTxns] Got HTML, length=${html.length}`);
    const txns = parseCardTransactionsHtml(html);
    console.log(`[WebTxns] Parsed ${txns.length} transactions`);
    return txns;

  } catch (e) {
    console.error(`[WebTxns] Error:`, e.message);
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

module.exports = {
  ycHeaders, ycGet, ycPost, ycAuth,
  ycGetCardTypes, ycGetClientCards, ycWebLogin, ycGetCardTransactions,
  parseCardTransactionsHtml, ycAccrueCard,
  ycWebSessions,
  getTreeCache, setTreeCache, clearTreeCache,
};
