'use strict';

const { db } = require('../../../db');
const { ycGetServiceCatalog, ycGetServiceMeta } = require('../../yclients');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
const categoryTree = require('../category-tree');

const schema = {
  name: 'list_services',
  description: 'Список услуг салона: актуальная цена из YClients и мастера, которые эту услугу выполняют. ' +
    'Использовать, когда клиент спрашивает «что делаете / сколько стоит / кто делает такую-то услугу / что делает мастер».',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input) {
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
  // staffPricesByService: svcIdStr → Map<staffIdStr,{price_min,price_max}> — цена
  // у конкретного мастера (может отличаться: врач vs. главный врач).
  let priced = [], staffIdsByService = new Map(), staffPricesByService = new Map();
  let categories = [], durationByService = new Map();
  if (salon && salon.yclients_company_id) {
    try {
      const cat = await ycGetServiceCatalog(salon, staffRows.map(r => r.yclients_staff_id));
      priced = cat.priced;
      categories = cat.categories || [];
      staffIdsByService = cat.staffIdsByService;
      staffPricesByService = cat.staffPricesByService || new Map();
    } catch (_) { /* YClients недоступен → фолбэк на заголовки из конфига */ }
    // Длительность услуги (service-level): per-staff длительности в YClients нет.
    const meta = await ycGetServiceMeta(salon).catch(() => null);
    durationByService = (meta && meta.durationByService) || new Map();
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
        const p = priceMap.get(String(id));
        return {
          // yc_id здесь избавляет от лишнего list_staff: слоты и бронь требуют
          // id мастера, а раньше его приходилось добывать отдельным вызовом и
          // сопоставлять по имени.
          yc_id: Number(id),
          name,
          price_min: p && p.price_min ? p.price_min : s.price_min,
          price_max: p && p.price_max ? p.price_max : s.price_max,
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

  return { services };
}

module.exports = { schema, run };
