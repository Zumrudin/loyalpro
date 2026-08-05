'use strict';

const { ycGetResources, ycGetDayRecords } = require('../yclients-booking');
const { ycGetServiceMeta } = require('../yclients');
const eq = require('./equipment');

// ── Загрузчик данных об оборудовании на дату (I/O-обвязка вокруг equipment.js). ──
// Чистая логика живёт в equipment.js; здесь только сходить в YClients и собрать
// то, что ей нужно. Деградирует мягко: если API недоступен, возвращаем пустую
// занятость — агент тогда работает как раньше (по графику мастера), а не падает.

// Дедуп ОДНОВРЕМЕННЫХ загрузок: ключ «салон+компания+дата» → летящий промис.
// Пациент, не назвавший врача, запускает до MAX_STAFF_OPTIONS параллельных
// computeStaffSlots, и каждый зовёт сюда с одними и теми же salon/date. У PERI
// онлайн-запись выключена почти на всём каталоге (активны 4 услуги из 317),
// значит ycGetBookTimes пуст и путь ВСЕГДА идёт в fallback — три одинаковых
// одновременных /records (count=300) на каждое «а когда можно?», причём
// ycGetDayRecords, в отличие от ycGetResources/ycGetServiceMeta, не кэширован.
// У проекта уже был инцидент с 429 (молча пропали категории косметики).
//
// ЭТО НЕ КЭШ И НЕ ДОЛЖНО ИМ СТАТЬ: запись из карты удаляется, как только промис
// завершился (при успехе и при ошибке одинаково), результат нигде не живёт.
// Занятость кресел и аппаратов меняется постоянно, а устаревший контекст
// оборудования — это предложенный пациенту ЗАНЯТЫЙ слот, то есть отказ YClients
// уже ПОСЛЕ согласования времени. Лишний запрос дешевле. TTL сюда не добавлять.
const inFlight = new Map();

function loadEquipmentContext(salon, date) {
  const key = `${(salon && salon.id) || ''}:${(salon && salon.yclients_company_id) || ''}|${date}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = fetchEquipmentContext(salon, date).finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

async function fetchEquipmentContext(salon, date) {
  try {
    const [resources, records, meta] = await Promise.all([
      ycGetResources(salon).catch(() => []),
      ycGetDayRecords(salon, date).catch(() => []),
      ycGetServiceMeta(salon).catch(() => null),
    ]);
    return {
      resources,
      busy: eq.recordsToResourceBusy(records, date),
      resourceIdsByService: (meta && meta.resourceIdsByService) || new Map(),
      durationByService: (meta && meta.durationByService) || new Map(),
      degraded: !meta,
    };
  } catch (_) {
    return {
      resources: [], busy: new Map(),
      resourceIdsByService: new Map(), durationByService: new Map(), degraded: true,
    };
  }
}

// Экземпляры аппарата, нужные услуге (пусто = услуга без оборудования).
function instancesFor(ctx, ycServiceId) {
  return eq.instancesForService(ctx.resourceIdsByService, ctx.resources, ycServiceId);
}

// Занятость именно тех экземпляров, что нужны услуге — чтобы вычесть её из
// свободных окон мастера. Если у аппарата несколько экземпляров, занятым
// считаем только время, когда заняты ВСЕ (иначе услугу можно делать).
function busyForService(ctx, ycServiceId) {
  const insts = instancesFor(ctx, ycServiceId);
  if (!insts.length) return [];
  const perInstance = insts.map(i => ctx.busy.get(String(i)) || []);
  if (perInstance.length === 1) return perInstance[0];
  return perInstance.reduce((acc, cur) => eq.intersectRanges(acc, cur));
}

// Длительность услуги в минутах (0 = неизвестна).
function durationMin(ctx, ycServiceId) {
  return Math.round((Number(ctx.durationByService.get(String(ycServiceId))) || 0) / 60);
}

module.exports = { loadEquipmentContext, instancesFor, busyForService, durationMin };
