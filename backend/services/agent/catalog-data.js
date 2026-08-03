'use strict';

// Общий загрузчик каталога услуг для трёх потребителей: инструмента
// list_services (legacy-режим), блока «КАТАЛОГ УСЛУГ» в системном промпте
// (AGENT_CATALOG_IN_PROMPT) и инструмента get_service_masters. Логика
// фильтров видимости, deny-пар и дерева категорий — одна на всех.
const { db } = require('../../db');
const { ycGetServiceCatalog, ycGetServiceMeta } = require('../yclients');
const settings = require('../agent-settings');
const svcFilter = require('./service-filter');
const categoryTree = require('./category-tree');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentCatalogData');

// Обобщённые услуги, на которые промпт ОБЯЗЫВАЕТ записывать, когда пациент не
// назвал препарат/филлер (правило «ПРЕПАРАТ/ФИЛЛЕР НЕ УТОЧНЯЕМ» в system-prompt.js).
// В YClients они выключены (active=0) и попадают в каталог только явной галочкой
// «включить из каталога» (allow-правило). Инцидент 2026-07-31: галочки не было,
// модель не видела «Биоревитализацию» в каталоге и записала пациента на конкретный
// препарат «Revi Silk 1 ml» — правило было невыполнимым, и это нигде не всплывало.
// «Ботулинотерапия Ботулакс 1 ед» — тот же паттерн для зон: пациент не назвал
// зону → запись на единицу Ботулакса, зоны и дозу определяет врач на визите
// (инцидент 2026-07-31: запрос «записаться на ботокс» свёлся к консультации).
const GENERIC_SERVICE_TITLES = ['Биоревитализация', 'Увеличение губ', 'Контурная пластика', 'Ботулинотерапия Ботулакс 1 ед'];
const warnedMissing = new Set();   // один лог на процесс, а не на каждый ход диалога

// Совпадение названия: после схлопывания пробелов — точное ИЛИ с техническим
// хвостом в скобках. В YClients «Ботулакс» называется
// «Ботулинотерапия  Ботулакс 1 ед ( 30 минут )» — двойной пробел и длительность.
const normTitle = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
function matchesGenericTitle(catalogTitle, genericTitle) {
  const t = normTitle(catalogTitle);
  const g = normTitle(genericTitle);
  return t === g || (t.startsWith(g) && t.slice(g.length).trim().startsWith('('));
}

function warnMissingGenericServices(salonId, services) {
  for (const title of GENERIC_SERVICE_TITLES) {
    const key = `${salonId}:${title}`;
    if (warnedMissing.has(key)) continue;
    if (services.some(s => matchesGenericTitle(s.title, title))) continue;
    warnedMissing.add(key);
    logger.warn(`salon ${salonId}: обобщённой услуги «${title}» нет в каталоге агента — ` +
      'правило «препарат не уточняем» невыполнимо, модель запишет на конкретный препарат. ' +
      'Включи услугу в админке (Агент → услуги) или сними deny-правило.');
  }
}

// → [{ yc_id, title, duration_min, price_min, price_max, category_path, staff:[{yc_id,name,price_min,price_max}] }]
async function loadCatalogServices(salonId) {
  // service_title/tag из админки — используем как фолбэк, если YClients недоступен.
  const cfg = await db.any(
    `SELECT yclients_service_id, service_title
       FROM services_config WHERE salon_id = $1`,
    [salonId]);

  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);

  // Имена активных мастеров по yclients_staff_id — чтобы подставить в каждую услугу.
  const staffRows = await db.any(
    `SELECT yclients_staff_id, name
       FROM staff_members
      WHERE salon_id = $1 AND is_active = true`, [salonId]);
  const staffNameById = new Map(staffRows.map(s => [String(s.yclients_staff_id), s.name]));

  const filter = await settings.loadServiceFilterSafe(salonId);
  // Оверлей-дерево подкатегорий (fail-open): для category_path каждой услуги.
  const tree = await settings.loadCategoryTreeSafe(salonId);

  // Достоверная привязка услуга→мастера строится per-staff запросами (поле staff
  // в общем /services урезано). staffIdsByService: svcIdStr → Set(staffIdStr).
  let priced = [], staffIdsByService = new Map();
  let categories = [], durationByService = new Map(), staffPricesByService = new Map();
  if (salon && salon.yclients_company_id) {
    try {
      const cat = await ycGetServiceCatalog(salon, staffRows.map(r => r.yclients_staff_id));
      priced = cat.priced;
      categories = cat.categories || [];
      staffIdsByService = cat.staffIdsByService;
    } catch (_) { /* YClients недоступен → фолбэк на заголовки из конфига */ }
    // Длительность услуги (service-level): per-staff длительности в YClients нет.
    // Оттуда же — ПЕРСОНАЛЬНЫЕ цены мастеров (svcIdStr → Map<staffIdStr,{price_min,price_max}>):
    // цена процедуры отличается у врача и у главного врача, и только management-каталог
    // их отдаёт. Мета недоступна → у всех останется базовая цена услуги (как и было).
    const meta = await ycGetServiceMeta(salon).catch(() => null);
    durationByService = (meta && meta.durationByService) || new Map();
    staffPricesByService = (meta && meta.staffPricesByService) || new Map();
  }

  // Мастера, кто делает услугу: только активные, реально привязанные; минус deny-пары.
  // У каждого — его цена за услугу (фолбэк на общий диапазон услуги, если per-staff нет).
  const staffOf = (s) => {
    const priceMap = staffPricesByService.get(String(s.id)) || new Map();
    return svcFilter
      .filterServiceStaff(filter, s.id, [...(staffIdsByService.get(String(s.id)) || new Set())])
      .map(id => {
        const name = staffNameById.get(String(id));
        if (!name) return null;
        // Ключ есть только у мастера с ПЕРСОНАЛЬНОЙ ценой; у остальных — базовая
        // цена услуги целиком (обе границы), без смешивания с чужой.
        const p = priceMap.get(String(id));
        return {
          // yc_id здесь избавляет от лишнего list_staff: слоты и бронь требуют
          // id мастера, а раньше его приходилось добывать отдельным вызовом и
          // сопоставлять по имени.
          yc_id: Number(id),
          name,
          price_min: p ? p.price_min : s.price_min,
          price_max: p ? p.price_max : s.price_max,
        };
      })
      .filter(Boolean);
  };

  let services;
  if (priced.length) {
    // Индекс дерева категорий/подкатегорий для category_path каждой услуги.
    const idx = categoryTree.indexTree(categories, tree.subcats, tree.placements);
    services = priced
      .filter(s => svcFilter.decideOfferVisible(filter, s.id, s.active === 1))
      .map(s => {
        const staff = staffOf(s);   // только реальные исполнители (минус deny-пары), с ценой каждого
        const dur = durationByService.get(String(s.id));
        return {
          yc_id: s.id,
          title: s.title,
          duration_min: dur ? Math.round(dur / 60) : null,
          // Диапазон цены — АГРЕГАТ по отфильтрованным мастерам, а НЕ сырой диапазон
          // каталога YClients (тот включал бы «теневых» мастеров без реальной услуги).
          price_min: staff.length ? Math.min(...staff.map(m => m.price_min)) : null,
          price_max: staff.length ? Math.max(...staff.map(m => m.price_max)) : null,
          // Путь категорий сверху вниз (направление → подкатегория) для ответов
          // Милы про группу/направление услуг.
          category_path: categoryTree.categoryPathForService(idx, s.id, s.category_id),
          staff,
        };
      })
      .filter(s => s.staff.length > 0);   // услуга без исполнителей после deny-пар не предлагается
  } else {
    // Нет живых данных (нет YClients-компании или API упал) → отдаём хотя бы заголовки из конфига.
    services = cfg.map(c => ({
      yc_id: c.yclients_service_id,
      title: c.service_title,
      duration_min: null,
      price_min: null,
      price_max: null,
      category_path: [],
      staff: [],
    }));
  }

  warnMissingGenericServices(salonId, services);
  return services;
}

module.exports = { loadCatalogServices, GENERIC_SERVICE_TITLES, warnMissingGenericServices, matchesGenericTitle };
