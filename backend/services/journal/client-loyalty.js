'use strict';
// «Лояльность» клиента в карточке записи журнала: карты лояльности, абонементы
// и сертификаты. Карты, абонементы и сертификаты живут в YClients (у нас их нет),
// поэтому читаются живьём; история операций карты — наша (loyalty_card_transactions).
// Каждая часть читается отдельно: сбой одной (null + текст в errors) не прячет
// остальные. Отдаются ВСЕ элементы с флагом active, фильтр «только активные» — на фронте.
const { db } = require('../../db');
const { ycGet, ycGetClientCardsStrict, ycGetClientAbonements, ycSearchClientIdByPhone } = require('../yclients');
const clientSummary = require('./client-summary');
const m = require('./model');

const HISTORY_LIMIT = 200;
// Статусы YClients, после которых абонемент/сертификат уже не используется.
const INACTIVE_SLUG = /expired|used|finish|closed|block|cancel|deactiv|archiv/i;

const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const day = v => (v ? String(v).slice(0, 10) : null);
const pastDay = (date, todayKey) => !!date && date < todayKey;
function mskToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);
}

function cardView(c, linkedCardId) {
  return {
    kind: 'card',
    id: num(c?.id),
    number: c?.number != null ? String(c.number) : null,
    title: String(c?.type?.title || 'Карта лояльности'),
    network: c?.salon_group?.title ? String(c.salon_group.title) : null,
    balance: num(c?.balance) ?? 0,
    points: num(c?.points) ?? 0,
    maxDiscountPercent: num(c?.max_discount_percent) ?? 0,
    maxDiscountAmount: num(c?.max_discount_amount) ?? 0,
    soldAmount: num(c?.sold_amount) ?? 0,
    paidAmount: num(c?.paid_amount) ?? 0,
    visits: num(c?.visits_count) ?? 0,
    programs: (Array.isArray(c?.programs) ? c.programs : []).map(p => String(p?.title || p?.name || '')).filter(Boolean),
    linked: linkedCardId != null && num(c?.id) === Number(linkedCardId),
    active: true,
    history: null,
  };
}

function abonementView(a, todayKey) {
  const links = Array.isArray(a?.balance_container?.links) ? a.balance_container.links : [];
  const unlimited = !!a?.is_united_balance_unlimited;
  const balance = unlimited ? 'безлимит'
    : a?.is_united_balance ? num(a.united_balance_services_count) ?? 0
    : links.reduce((s, l) => s + (num(l?.count) || 0), 0);
  const expires = day(a?.expiration_date);
  const slug = String(a?.status?.slug || '');
  const services = links.map(l => l?.service
    ? { category: '', service: String(l.service.title || ''), count: l.is_unlimited ? 'безлимит' : num(l.count) }
    : { category: String(l?.category?.title || ''), service: 'Все услуги', count: l?.is_unlimited ? 'безлимит' : num(l?.count) });
  return {
    kind: 'abonement',
    id: num(a?.id),
    number: a?.number != null ? String(a.number) : null,
    title: String(a?.type?.title || a?.balance_string || 'Абонемент'),
    status: a?.status ? String(a.status.extended_title || a.status.title || '') : null,
    created: day(a?.created_date),
    activated: day(a?.activated_date),
    expires,
    expirationType: a?.type?.expiration_type_title ? String(a.type.expiration_type_title) : null,
    balance,
    united: !!a?.is_united_balance,
    frozen: !!a?.is_frozen,
    cost: num(a?.type?.cost),
    services,
    active: (balance === 'безлимит' || balance > 0) && !pastDay(expires, todayKey) && !INACTIVE_SLUG.test(slug),
  };
}

function certificateView(c, todayKey) {
  const expires = day(c?.expiration_date);
  const balance = num(c?.balance) ?? 0;
  const slug = String(c?.status?.slug || '');
  return {
    kind: 'certificate',
    id: num(c?.id),
    number: c?.number != null ? String(c.number) : null,
    title: String(c?.type?.title || 'Сертификат'),
    status: c?.status?.title ? String(c.status.title) : null,
    created: day(c?.created_date),
    expires,
    balance,
    nominal: num(c?.default_balance) ?? num(c?.type?.balance),
    appliesTo: c?.type?.item_type?.title ? String(c.type.item_type.title) : null,
    active: balance > 0 && !pastDay(expires, todayKey) && !INACTIVE_SLUG.test(slug),
  };
}

const HISTORY_SQL = `SELECT yclients_card_id, txn_date, created_at, amount, title, type FROM loyalty_card_transactions
  WHERE salon_id=$1 AND client_id=$2 ORDER BY COALESCE(txn_date, created_at) DESC NULLS LAST, id DESC LIMIT ${HISTORY_LIMIT}`;
const LINKED_CARD_SQL = 'SELECT yclients_card_id FROM clients WHERE salon_id=$1 AND id=$2';

// Операции карты — только те, что записаны за этой картой; строки без id карты
// принадлежат привязанной карте программы салона (так их пишет loyalty.js).
function historyFor(card, rows, linkedCardId) {
  return rows.filter(r => r.yclients_card_id != null
    ? Number(r.yclients_card_id) === card.id
    : linkedCardId != null && card.id === Number(linkedCardId))
    .map(r => {
      const at = r.txn_date || r.created_at;
      return { date: at ? mskToday(new Date(at)) : null, title: String(r.title || (Number(r.amount) >= 0 ? 'Начисление' : 'Списание')), amount: Number(r.amount) || 0 };
    });
}

async function load(salonId, query = {}, deps = {}) {
  const yc = { ycGet, ycGetClientCardsStrict, ycGetClientAbonements, ycSearchClientIdByPhone, ...deps };
  const { salon, client, yc: resolvedYcId, ph } = await clientSummary.resolveClient(salonId, query);
  const requestedYcId = query.ycClientId != null && query.ycClientId !== '' ? Number(query.ycClientId) : null;
  // The cards endpoint has no company id in its path. Never send it a client id
  // unless that id was linked by a tenant-scoped clients lookup. A phone can be
  // resolved safely below through YClients' company-scoped client search.
  if (requestedYcId != null && (!client || Number(client.yclients_client_id) !== requestedYcId) && !ph) {
    m.fail('Клиент не найден.', 404);
  }
  const ycId0 = requestedYcId != null && (!client || Number(client.yclients_client_id) !== requestedYcId)
    ? null : resolvedYcId;
  const todayKey = mskToday(deps.now || new Date());
  const errors = {};
  const live = !!salon.yclients_company_id;

  let linkedCardId = null;
  let historyRows = [];
  if (client) {
    linkedCardId = (await db.oneOrNone(LINKED_CARD_SQL, [salonId, client.id]))?.yclients_card_id ?? null;
    historyRows = await db.any(HISTORY_SQL, [salonId, client.id]);
  }

  let cards = null;
  if (live) {
    try {
      let ycId = ycId0;
      if (!ycId && ph) ycId = await yc.ycSearchClientIdByPhone(salon, ph);
      cards = ycId ? (await yc.ycGetClientCardsStrict(salon, ycId)).map(c => cardView(c, linkedCardId)) : [];
      for (const c of cards) c.history = historyFor(c, historyRows, linkedCardId);
    } catch (_) { cards = null; errors.cards = 'Не удалось получить карты лояльности.'; }
  } else errors.cards = 'Салон не подключён к YClients.';

  let abonements = null;
  let certificates = null;
  if (live && ph) {
    const [ab, cert] = await Promise.allSettled([
      yc.ycGetClientAbonements(salon, ph),
      yc.ycGet(salon, '/loyalty/certificates/', { company_id: salon.yclients_company_id, phone: ph }),
    ]);
    if (ab.status === 'fulfilled') abonements = (Array.isArray(ab.value) ? ab.value : []).map(a => abonementView(a, todayKey));
    else errors.abonements = 'Не удалось получить абонементы.';
    if (cert.status === 'fulfilled') certificates = (Array.isArray(cert.value) ? cert.value : []).map(c => certificateView(c, todayKey));
    else errors.certificates = 'Не удалось получить сертификаты.';
  } else {
    errors.abonements = errors.certificates = live ? 'Телефон клиента неизвестен.' : 'Салон не подключён к YClients.';
  }

  return { clientId: client?.id ?? null, name: client?.name || null, phone: ph, cards, abonements, certificates, errors };
}

module.exports = { load, cardView, abonementView, certificateView, historyFor, HISTORY_SQL, LINKED_CARD_SQL };
