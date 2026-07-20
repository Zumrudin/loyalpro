'use strict';

const { ycGetResources, ycGetDayRecords } = require('../yclients-booking');
const { ycGetServiceMeta } = require('../yclients');
const eq = require('./equipment');

// ── Загрузчик данных об оборудовании на дату (I/O-обвязка вокруг equipment.js). ──
// Чистая логика живёт в equipment.js; здесь только сходить в YClients и собрать
// то, что ей нужно. Деградирует мягко: если API недоступен, возвращаем пустую
// занятость — агент тогда работает как раньше (по графику мастера), а не падает.

async function loadEquipmentContext(salon, date) {
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
