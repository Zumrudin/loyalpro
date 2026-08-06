'use strict';
// ============================================================
// Agent settings — настройки ИИ-агента и списки номеров (БД).
// Таблицы agent_settings / agent_number_rules (migrations.js).
// Решение допуска делегируется чистому services/agent-gate.
// ============================================================
const { db } = require('../db');
const { ycGetServiceCatalog } = require('./yclients');
const { normalizePhoneKey, decideGate, parseHhMm, nowMskMinutes,
        minutesSinceWindowStart } = require('./agent-gate');

const DEFAULTS = {
  enabled: false, mode: 'all',
  scheduleEnabled: false, scheduleStart: '22:00', scheduleEnd: '09:30',
};

// Строка БД → camelCase-настройки для API и гейта.
function rowToSettings(row) {
  return {
    enabled: !!row.enabled,
    mode: row.mode === 'whitelist' ? 'whitelist' : 'all',
    scheduleEnabled: !!row.schedule_enabled,
    scheduleStart: row.schedule_start || DEFAULTS.scheduleStart,
    scheduleEnd: row.schedule_end || DEFAULTS.scheduleEnd,
  };
}

// Валидация времени из тела запроса. undefined и null → оставить текущее значение.
function pickTime(raw, current) {
  if (raw == null) return current;   // undefined и null → оставить текущее
  if (parseHhMm(raw) === null) { const e = new Error('bad time'); e.code = 'BAD_TIME'; throw e; }
  return String(raw).trim();
}

async function getSettings(salonId) {
  if (!salonId) return { ...DEFAULTS };
  const row = await db.oneOrNone(
    `SELECT enabled, mode, schedule_enabled, schedule_start, schedule_end
       FROM agent_settings WHERE salon_id=$1`, [salonId]
  );
  return row ? rowToSettings(row) : { ...DEFAULTS };
}

// Поля расписания, не переданные в теле, сохраняют текущее значение — иначе
// старый закэшированный фронт (шлёт только enabled+mode) молча сбросил бы окно.
// enabled/mode ведут себя иначе — отсутствие поля означает false/'all': это
// прежний контракт роута, менять его в рамках фичи расписания не стали.
async function updateSettings(salonId, body) {
  const { enabled, mode, scheduleEnabled, scheduleStart, scheduleEnd } = body || {};
  const cur = await getSettings(salonId);
  const m = mode === 'whitelist' ? 'whitelist' : 'all';
  // null трактуем как «поле не передано»: фронт очищает контрол в null, и
  // разная реакция на него (400 для времени, тихое выключение для флага) была бы ловушкой.
  const schedOn = scheduleEnabled == null ? cur.scheduleEnabled : !!scheduleEnabled;
  const start = pickTime(scheduleStart, cur.scheduleStart);
  const end = pickTime(scheduleEnd, cur.scheduleEnd);
  const row = await db.one(
    `INSERT INTO agent_settings
       (salon_id, enabled, mode, schedule_enabled, schedule_start, schedule_end, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET
       enabled=$2, mode=$3, schedule_enabled=$4,
       schedule_start=$5, schedule_end=$6, updated_at=NOW()
     RETURNING enabled, mode, schedule_enabled, schedule_start, schedule_end`,
    [salonId, !!enabled, m, schedOn, start, end]
  );
  return rowToSettings(row);
}

async function listNumberRules(salonId, ruleType) {
  return db.any(
    `SELECT id, phone, rule_type, note, created_at
       FROM agent_number_rules
      WHERE salon_id=$1 AND ($2::text IS NULL OR rule_type=$2)
      ORDER BY created_at DESC`,
    [salonId, ruleType || null]
  );
}

async function addNumberRule(salonId, { phone, ruleType, note }) {
  const key = normalizePhoneKey(phone);
  if (!key) { const e = new Error('invalid phone'); e.code = 'BAD_PHONE'; throw e; }
  const type = ruleType === 'block' ? 'block' : 'allow';
  return db.one(
    `INSERT INTO agent_number_rules (salon_id, phone, rule_type, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (salon_id, phone, rule_type) DO UPDATE SET note=EXCLUDED.note
     RETURNING id, phone, rule_type, note, created_at`,
    [salonId, key, type, note || null]
  );
}

async function removeNumberRule(salonId, id) {
  await db.query('DELETE FROM agent_number_rules WHERE salon_id=$1 AND id=$2', [salonId, id]);
}

// Комбинированный допуск: настройки + списки → решение чистого гейта.
//
// @param {{ignoreSchedule?: boolean}} opts
//   ignoreSchedule — НЕ сужать допуск окном расписания. Окно проектировалось
//   для ВХОДЯЩИХ сообщений («когда Мила отвечает клиентам»), и на исходящие
//   плановые касания «Отдела заботы» оно не распространяется: время касания
//   задаёт САМ салон в программе (send_time), это уже осознанное решение о
//   том, когда писать пациенту. Второй фильтр поверх него означал, что
//   дневное касание при ночном окне не уходит НИКОГДА (см. worker.js).
//   Чёрный список, режим whitelist и тумблер агента продолжают действовать —
//   отменяется ровно окно.
async function isAllowed(salonId, phone, opts = {}) {
  // Fail-closed без салона: не даём авто-ответ на неопознанный инстанс,
  // независимо от DEFAULTS (нет salon_id → нет контекста списков).
  if (!salonId) return { allow: false, reason: 'no-salon' };
  const settings = await getSettings(salonId);
  if (!settings.enabled) return { allow: false, reason: 'disabled' };
  const rules = await listNumberRules(salonId, null);
  const allow = rules.filter(r => r.rule_type === 'allow').map(r => r.phone);
  const block = rules.filter(r => r.rule_type === 'block').map(r => r.phone);
  const nowMinutes = nowMskMinutes();
  const window = {
    scheduleEnabled: settings.scheduleEnabled && !opts.ignoreSchedule,
    scheduleStart: settings.scheduleStart,
    scheduleEnd: settings.scheduleEnd,
    nowMinutes,
  };
  return {
    ...decideGate({ enabled: true, mode: settings.mode, allow, block, phone, ...window }),
    // Сколько минут назад открылось окно расписания (null — расписание выключено
    // или мы вне окна). Диспетчер снимает по нему протухшую паузу «отвечал
    // администратор» — считаем здесь, чтобы не читать настройки салона дважды.
    minutesSinceWindowStart: minutesSinceWindowStart(window),
  };
}

// ── Фильтр услуг агента ─────────────────────────────────────
async function getServiceMode(salonId) {
  if (!salonId) return 'all';
  const row = await db.oneOrNone(
    'SELECT service_mode FROM agent_settings WHERE salon_id=$1', [salonId]);
  return (row && row.service_mode === 'allowlist') ? 'allowlist' : 'all';
}

async function updateServiceMode(salonId, mode) {
  const m = mode === 'allowlist' ? 'allowlist' : 'all';
  const row = await db.one(
    `INSERT INTO agent_settings (salon_id, service_mode, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET service_mode=$2, updated_at=NOW()
     RETURNING service_mode`,
    [salonId, m]);
  return { serviceMode: row.service_mode };
}

async function listServiceRules(salonId) {
  return db.any(
    `SELECT id, yc_service_id, yc_staff_id, rule_type, note, created_at
       FROM agent_service_rules WHERE salon_id=$1 ORDER BY created_at DESC`,
    [salonId]);
}

async function addServiceRule(salonId, { ycServiceId, ycStaffId, ruleType, note }) {
  const svc = parseInt(ycServiceId, 10);
  if (!svc) { const e = new Error('bad service'); e.code = 'BAD_SERVICE'; throw e; }
  const staff = (ycStaffId === undefined || ycStaffId === null || ycStaffId === '')
    ? null : parseInt(ycStaffId, 10);
  // Пары поддерживают только deny (см. спеку); услуга целиком — allow|deny.
  let type = ruleType === 'allow' ? 'allow' : 'deny';
  if (staff !== null) type = 'deny';
  return db.one(
    `INSERT INTO agent_service_rules (salon_id, yc_service_id, yc_staff_id, rule_type, note)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (salon_id, yc_service_id, COALESCE(yc_staff_id,0), rule_type)
       DO UPDATE SET note=EXCLUDED.note
     RETURNING id, yc_service_id, yc_staff_id, rule_type, note, created_at`,
    [salonId, svc, staff, type, note || null]);
}

async function removeServiceRule(salonId, id) {
  await db.query('DELETE FROM agent_service_rules WHERE salon_id=$1 AND id=$2', [salonId, id]);
}

// Удалить правило по составному ключу (без знания id) — нужно для bulk-операций.
async function removeServiceRuleByKey(salonId, svcId, staffId, ruleType) {
  await db.query(
    `DELETE FROM agent_service_rules
      WHERE salon_id=$1 AND yc_service_id=$2
        AND COALESCE(yc_staff_id,0)=COALESCE($3::int,0) AND rule_type=$4`,
    [salonId, svcId, staffId ?? null, ruleType]);
}

// Применить желаемую видимость услуги целиком (та же логика, что тумблер на фронте).
// Всегда чистим противоположное правило, чтобы deny+allow не противоречили.
//   allowlist — видимость = наличие allow (active не важен).
//   all + active  — по умолчанию видна: скрыть = deny, показать = снять deny.
//   all + !active — по умолчанию скрыта: показать = allow, скрыть = снять allow.
async function applyServiceVisibility(salonId, { ycServiceId, active, wantVisible }, mode) {
  const svc = parseInt(ycServiceId, 10);
  if (!svc) return;
  const isActive = !!active;
  if (mode === 'allowlist') {
    if (wantVisible) await addServiceRule(salonId, { ycServiceId: svc, ruleType: 'allow' });
    else await removeServiceRuleByKey(salonId, svc, null, 'allow');
  } else if (wantVisible) {
    await removeServiceRuleByKey(salonId, svc, null, 'deny');
    if (!isActive) await addServiceRule(salonId, { ycServiceId: svc, ruleType: 'allow' });
  } else {
    await removeServiceRuleByKey(salonId, svc, null, 'allow');
    if (isActive) await addServiceRule(salonId, { ycServiceId: svc, ruleType: 'deny' });
  }
}

// Массовая установка видимости (тумблер категории). items: [{ycServiceId, active, wantVisible}].
async function setServicesVisibilityBulk(salonId, items) {
  const mode = await getServiceMode(salonId);
  for (const it of (items || [])) await applyServiceVisibility(salonId, it, mode);
  return { ok: true };
}

// Загрузчик правил → структуры для service-filter. Кидает при сбое БД.
async function loadServiceFilter(salonId) {
  const mode = await getServiceMode(salonId);
  const rows = await db.any(
    `SELECT yc_service_id, yc_staff_id, rule_type FROM agent_service_rules WHERE salon_id=$1`,
    [salonId]);
  const denyServices = new Set(), allowServices = new Set(), denyPairs = new Set();
  for (const r of rows) {
    const sid = String(r.yc_service_id);
    if (r.yc_staff_id === null || r.yc_staff_id === undefined) {
      if (r.rule_type === 'deny') denyServices.add(sid);
      else allowServices.add(sid);
    } else if (r.rule_type === 'deny') {
      denyPairs.add(`${sid}:${String(r.yc_staff_id)}`);
    }
  }
  return { mode, denyServices, allowServices, denyPairs };
}

// Fail-open обёртка: при любом сбое БД → пустой пермиссивный фильтр (mode 'all',
// пустые множества → видно всё). Транзиентный сбой не должен ломать агента.
async function loadServiceFilterSafe(salonId) {
  try { return await loadServiceFilter(salonId); }
  catch (e) {
    return { mode: 'all', denyServices: new Set(), allowServices: new Set(), denyPairs: new Set() };
  }
}

// ── Стоп-темы: чем клиника не занимается вообще (даже не консультирует) ──
// Отдаёт массив строк тем. Кидает при сбое БД.
async function loadStopTopics(salonId) {
  if (!salonId) return [];
  const rows = await db.any(
    `SELECT topic FROM agent_stop_topics WHERE salon_id=$1 ORDER BY id`, [salonId]);
  return rows.map(r => String(r.topic || '').trim()).filter(Boolean);
}

// Fail-open обёртка: при сбое БД → пустой список. Осознанный компромисс —
// транзиентный сбой БД не должен ронять весь диалог. Риск: в этот момент агент
// не увидит стоп-темы. Если понадобится fail-closed, менять здесь.
async function loadStopTopicsSafe(salonId) {
  try { return await loadStopTopics(salonId); }
  catch (_) { return []; }
}

// Список стоп-тем для админки (с id, чтобы можно было удалять).
async function listStopTopics(salonId) {
  return db.any(
    `SELECT id, topic, note, created_at FROM agent_stop_topics
      WHERE salon_id=$1 ORDER BY id`, [salonId]);
}

async function addStopTopic(salonId, topic, note) {
  const t = String(topic || '').trim();
  if (!t) throw new Error('Пустая стоп-тема');
  return db.oneOrNone(
    `INSERT INTO agent_stop_topics (salon_id, topic, note) VALUES ($1,$2,$3)
     ON CONFLICT (salon_id, lower(topic)) DO NOTHING
     RETURNING id, topic, note`,
    [salonId, t, note || null]);
}

async function removeStopTopic(salonId, id) {
  await db.query('DELETE FROM agent_stop_topics WHERE salon_id=$1 AND id=$2', [salonId, id]);
}

// ── Подкатегории услуг агента + перемещение услуг ───────────────────────────
// Локальный оверлей поверх плоских YClients-категорий (см. category-tree.js).

// Все подкатегории салона (по якорю-категории, затем по порядку).
async function listSubcategories(salonId) {
  return db.any(
    `SELECT id, salon_id, yc_category_id, parent_id, title, display_order, created_at, updated_at
       FROM agent_service_subcategories
      WHERE salon_id=$1
      ORDER BY yc_category_id, display_order, id`,
    [salonId]);
}

// Создать подкатегорию. Вложенная (parentId) наследует yc_category_id родителя;
// верхняя требует ycCategoryId. display_order = (max среди сиблингов) + 1.
async function addSubcategory(salonId, { ycCategoryId, parentId, title }) {
  const t = String(title || '').trim();
  if (!t) { const e = new Error('bad title'); e.code = 'BAD_TITLE'; throw e; }

  let ycCat, parent = null;
  const pid = (parentId === undefined || parentId === null || parentId === '')
    ? null : parseInt(parentId, 10);
  if (pid) {
    parent = await db.oneOrNone(
      `SELECT id, yc_category_id FROM agent_service_subcategories WHERE salon_id=$1 AND id=$2`,
      [salonId, pid]);
    if (!parent) { const e = new Error('bad parent'); e.code = 'BAD_PARENT'; throw e; }
    ycCat = parent.yc_category_id;
  } else {
    ycCat = parseInt(ycCategoryId, 10);
    if (!ycCat) { const e = new Error('bad category'); e.code = 'BAD_CATEGORY'; throw e; }
  }

  const maxRow = await db.oneOrNone(
    `SELECT COALESCE(MAX(display_order), -1) AS m
       FROM agent_service_subcategories
      WHERE salon_id=$1 AND yc_category_id=$2
        AND COALESCE(parent_id,0)=COALESCE($3::int,0)`,
    [salonId, ycCat, pid]);
  const order = (Number(maxRow && maxRow.m) || 0) + 1;

  return db.one(
    `INSERT INTO agent_service_subcategories (salon_id, yc_category_id, parent_id, title, display_order)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, salon_id, yc_category_id, parent_id, title, display_order, created_at, updated_at`,
    [salonId, ycCat, pid, t, order]);
}

// Переименовать подкатегорию (scope по salon_id).
async function renameSubcategory(salonId, id, title) {
  const t = String(title || '').trim();
  if (!t) { const e = new Error('bad title'); e.code = 'BAD_TITLE'; throw e; }
  return db.one(
    `UPDATE agent_service_subcategories SET title=$3, updated_at=NOW()
      WHERE salon_id=$1 AND id=$2
     RETURNING id, salon_id, yc_category_id, parent_id, title, display_order, created_at, updated_at`,
    [salonId, id, t]);
}

// Удалить подкатегорию (каскад детей + placements → услуги вернутся в категорию).
async function removeSubcategory(salonId, id) {
  await db.query('DELETE FROM agent_service_subcategories WHERE salon_id=$1 AND id=$2', [salonId, id]);
}

// Батч-переупорядочивание подкатегорий. items:[{id, displayOrder}].
async function reorderSubcategories(salonId, items) {
  for (const it of (items || [])) {
    const id = parseInt(it && it.id, 10);
    if (!id) continue;
    await db.query(
      `UPDATE agent_service_subcategories SET display_order=$3, updated_at=NOW()
        WHERE salon_id=$1 AND id=$2`,
      [salonId, id, Number(it.displayOrder) || 0]);
  }
  return { ok: true };
}

// Все привязки услуг салона.
async function listPlacements(salonId) {
  return db.any(
    `SELECT id, salon_id, yc_service_id, subcategory_id, display_order, created_at, updated_at
       FROM agent_service_placements WHERE salon_id=$1`,
    [salonId]);
}

// Поместить услугу в подкатегорию (или снять placement при пустом subcategoryId).
async function placeService(salonId, { ycServiceId, subcategoryId }) {
  const svc = parseInt(ycServiceId, 10);
  if (!svc) { const e = new Error('bad service'); e.code = 'BAD_SERVICE'; throw e; }
  // Пусто/null → вернуть услугу в родную категорию (снять placement).
  if (subcategoryId === undefined || subcategoryId === null || subcategoryId === '') {
    await db.query(
      'DELETE FROM agent_service_placements WHERE salon_id=$1 AND yc_service_id=$2', [salonId, svc]);
    return { removed: true };
  }
  const subId = parseInt(subcategoryId, 10);
  const sub = subId ? await db.oneOrNone(
    'SELECT id FROM agent_service_subcategories WHERE salon_id=$1 AND id=$2', [salonId, subId]) : null;
  if (!sub) { const e = new Error('bad subcategory'); e.code = 'BAD_SUBCATEGORY'; throw e; }
  return db.one(
    `INSERT INTO agent_service_placements (salon_id, yc_service_id, subcategory_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (salon_id, yc_service_id)
       DO UPDATE SET subcategory_id=EXCLUDED.subcategory_id, updated_at=NOW()
     RETURNING id, salon_id, yc_service_id, subcategory_id, display_order, created_at, updated_at`,
    [salonId, svc, subId]);
}

// Снять placement (услуга → родная категория).
async function unplaceService(salonId, ycServiceId) {
  const svc = parseInt(ycServiceId, 10);
  if (!svc) return;
  await db.query(
    'DELETE FROM agent_service_placements WHERE salon_id=$1 AND yc_service_id=$2', [salonId, svc]);
}

// Загрузчик оверлей-дерева → { subcats, placements }. Кидает при сбое БД.
async function loadCategoryTree(salonId) {
  const [subcats, placements] = await Promise.all([
    listSubcategories(salonId),
    listPlacements(salonId),
  ]);
  return { subcats, placements };
}

// Fail-open обёртка: при любом сбое БД → пустой оверлей (услуги в родных
// YClients-категориях). Транзиентный сбой не должен ломать list_services агента.
async function loadCategoryTreeSafe(salonId) {
  try { return await loadCategoryTree(salonId); }
  catch (_) { return { subcats: [], placements: [] }; }
}

// Полный каталог услуг, сгруппированный по категориям, с ДОСТОВЕРНЫМИ мастерами
// (кто реально выполняет услугу) и текущей видимостью — для экрана админки.
// Структура: { serviceMode, categories: [вложенное дерево с подкатегориями] }.
async function getServicesForAdmin(salonId) {
  const salon = await db.oneOrNone(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  const staffRows = await db.any(
    `SELECT yclients_staff_id, name FROM staff_members
      WHERE salon_id=$1 AND is_active=true`, [salonId]);
  const staffNameById = new Map(staffRows.map(s => [String(s.yclients_staff_id), s.name]));

  const { priced, categories, staffIdsByService } = salon
    ? await ycGetServiceCatalog(salon, staffRows.map(s => s.yclients_staff_id))
    : { priced: [], categories: [], staffIdsByService: new Map() };

  const filter = await loadServiceFilter(salonId);   // админке нужен реальный статус, не fail-open
  const svcFilter = require('./agent/service-filter');
  const categoryTree = require('./agent/category-tree');
  const { subcats, placements } = await loadCategoryTree(salonId);
  const placementBySvc = new Map(placements.map(p => [String(p.yc_service_id), p.subcategory_id]));

  // Услуга → объект с мастерами (только активные, реально выполняющие), отсортированными.
  const svcObjs = priced.map(s => {
    const performerIds = staffIdsByService.get(String(s.id)) || new Set();
    const staff = [...performerIds]
      .filter(id => staffNameById.has(id))
      .map(id => ({
        yc_id: Number(id),
        name: staffNameById.get(id),
        hidden: filter.denyPairs.has(`${String(s.id)}:${id}`),
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    return {
      yc_id: s.id,
      title: s.title,
      price_min: s.price_min,
      price_max: s.price_max,
      active: s.active === 1,
      visible: svcFilter.decideOfferVisible(filter, s.id, s.active === 1),
      category_id: s.category_id ?? null,
      subcategory_id: placementBySvc.has(String(s.id)) ? placementBySvc.get(String(s.id)) : null,
      _weight: Number(s.weight) || 0,
      staff,
    };
  });

  // Вложенное дерево категория → услуги + подкатегории (см. category-tree.js).
  const tree = categoryTree.buildAdminTree(categories, svcObjs, subcats, placements);
  return { serviceMode: filter.mode, categories: tree };
}

module.exports = {
  getSettings, updateSettings, listNumberRules, addNumberRule, removeNumberRule, isAllowed,
  getServiceMode, updateServiceMode, listServiceRules, addServiceRule, removeServiceRule,
  removeServiceRuleByKey, applyServiceVisibility, setServicesVisibilityBulk,
  loadServiceFilter, loadServiceFilterSafe, getServicesForAdmin,
  loadStopTopics, loadStopTopicsSafe, listStopTopics, addStopTopic, removeStopTopic,
  listSubcategories, addSubcategory, renameSubcategory, removeSubcategory, reorderSubcategories,
  listPlacements, placeService, unplaceService, loadCategoryTree, loadCategoryTreeSafe,
};
