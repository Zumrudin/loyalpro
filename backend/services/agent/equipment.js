'use strict';

// ============================================================
// Чистая логика расписания: интервальная арифметика + занятость оборудования.
// Без БД/HTTP — юнит-тестируемо (equipment.test.js).
//
// Зачем: у салона с bookable:false слоты считаются из management-графика
// (/timetable/seances), который знает ТОЛЬКО занятость кресла мастера и слеп
// к аппаратам. При этом у каждого аппарата обычно ровно один экземпляр, а на
// один аппарат завязаны десятки услуг (вся эпиляция — на одном Pacer one Pro).
// Значит две услуги на одном аппарате параллельно невозможны в принципе, а
// одиночная запись может упереться в аппарат, занятый чужой записью.
//
// Все интервалы — минуты от полуночи по Москве, конец эксклюзивный: [start, end).
// ============================================================

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// ── Интервальная арифметика ─────────────────────────────────────────────────

// Склеить пересекающиеся и смежные интервалы, отсортировав по началу.
function mergeRanges(ranges) {
  const sorted = (ranges || []).slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) { last.end = Math.max(last.end, r.end); }
    else { out.push({ start: r.start, end: r.end }); }
  }
  return out;
}

// free минус busy. Одно свободное окно может распасться на несколько.
function subtractRanges(free, busy) {
  const cuts = mergeRanges(busy);
  let out = (free || []).map(r => ({ start: r.start, end: r.end }));
  for (const b of cuts) {
    const next = [];
    for (const r of out) {
      if (b.end <= r.start || b.start >= r.end) { next.push(r); continue; }   // не пересекаются
      if (b.start > r.start) next.push({ start: r.start, end: b.start });     // хвост слева
      if (b.end < r.end) next.push({ start: b.end, end: r.end });             // хвост справа
    }
    out = next;
  }
  return out;
}

// Общие участки двух наборов интервалов.
function intersectRanges(a, b) {
  const A = mergeRanges(a), B = mergeRanges(b);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    const start = Math.max(A[i].start, B[j].start);
    const end = Math.min(A[i].end, B[j].end);
    if (start < end) out.push({ start, end });
    if (A[i].end < B[j].end) i++; else j++;
  }
  return out;
}

// Влезает ли [t, t+dur) целиком в один из интервалов.
function fitsIn(ranges, t, dur) {
  return (ranges || []).some(r => t >= r.start && t + dur <= r.end);
}

// ── Занятость оборудования из записей дня ───────────────────────────────────

// Записи YClients (/records) → Map<instanceIdStr, [{start,end}]>.
// В записи уже лежит resource_instance_ids — маппить услуги на аппараты не нужно.
// Удалённые записи не занимают ресурс; неявившиеся (attendance=-1) — занимают,
// пока запись не удалена: считаем консервативно, лучше не предложить, чем упереться.
function recordsToResourceBusy(records, date) {
  const busy = new Map();
  for (const r of (records || [])) {
    if (!r || r.deleted) continue;
    const ids = Array.isArray(r.resource_instance_ids) ? r.resource_instance_ids : [];
    if (!ids.length) continue;
    const dt = String(r.datetime || '');
    const [dPart, tPart] = dt.split('T');
    if (!tPart || dPart !== date) continue;
    const start = toMin(tPart.slice(0, 5));
    const end = start + Math.round((Number(r.seance_length) || 0) / 60);
    if (!(end > start)) continue;
    for (const id of ids) {
      const k = String(id);
      if (!busy.has(k)) busy.set(k, []);
      busy.get(k).push({ start, end });
    }
  }
  for (const [k, v] of busy) busy.set(k, mergeRanges(v));
  return busy;
}

// Экземпляры аппаратов, нужные услуге: svcId → resource_ids → instance_ids.
// resources — ответ /resources/{cid}: [{id, instances:[{id}]}].
function instancesForService(resourceIdsByService, resources, ycServiceId) {
  const resIds = (resourceIdsByService.get(String(ycServiceId)) || []).map(String);
  if (!resIds.length) return [];
  const out = [];
  for (const r of (resources || [])) {
    if (!resIds.includes(String(r.id))) continue;
    for (const inst of (r.instances || [])) out.push(String(inst.id));
  }
  return out;
}

// ── Распределение экземпляров между параллельными записями ──────────────────

// Двудольное паросочетание (алгоритм Куна): каждой заявке — свой экземпляр.
// Размеры крошечные (2–3 заявки), поэтому простая рекурсия дешевле любой эвристики
// и, в отличие от жадности, не ошибается на пересекающихся пулах аппаратов.
function maxMatching(candidatesPerEntry) {
  const matchOf = new Map();   // instanceId → индекс заявки
  const tryAssign = (i, seen) => {
    for (const inst of candidatesPerEntry[i]) {
      if (seen.has(inst)) continue;
      seen.add(inst);
      const holder = matchOf.get(inst);
      if (holder === undefined || tryAssign(holder, seen)) {
        matchOf.set(inst, i);
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (let i = 0; i < candidatesPerEntry.length; i++) {
    if (!candidatesPerEntry[i].length) { matched++; continue; }   // аппарат не нужен
    if (tryAssign(i, new Set())) matched++;
  }
  return matched;
}

// Аппаратов физически не хватит на эти заявки одновременно — независимо от времени.
// Возвращает отсортированный список задействованных экземпляров или null.
function hardResourceConflict(entries) {
  const cands = (entries || []).map(e => (e.instances || []).map(String));
  if (maxMatching(cands) === cands.length) return null;
  const involved = new Set();
  for (const c of cands) for (const i of c) involved.add(i);
  return [...involved].sort();
}

// ── Подбор общих стартов ────────────────────────────────────────────────────

// entries: [{ ranges, durationMin, instances }] — свободные окна мастера,
// длительность услуги и допустимые экземпляры аппарата (пусто = аппарат не нужен).
// opts: { step, busy } — шаг сетки стартов и Map занятости экземпляров.
// Возвращает старты (минуты), где ВСЕ заявки помещаются одновременно и каждой
// хватает своего свободного экземпляра аппарата.
function parallelStarts(entries, opts = {}) {
  const step = opts.step || 30;
  const busy = opts.busy || new Map();
  if (!entries || entries.length < 2) return [];
  if (hardResourceConflict(entries)) return [];

  // Мастера должны пересекаться — по этому пересечению и строим сетку.
  let common = entries[0].ranges || [];
  for (let i = 1; i < entries.length; i++) common = intersectRanges(common, entries[i].ranges || []);
  if (!common.length) return [];

  const out = [];
  for (const win of common) {
    // Старт — на чистой сетке (кратной step от полуночи → :00/:30), а не с win.start:
    // иначе смещённое начало окна давало параллельные слоты вида 19:05/20:05.
    for (let t = Math.ceil(win.start / step) * step; t <= win.end; t += step) {
      // 1) у каждого мастера окно вмещает его услугу целиком
      if (!entries.every(e => fitsIn(e.ranges, t, e.durationMin))) continue;
      // 2) каждой заявке достаётся свободный в её интервале экземпляр аппарата.
      // Важно: пустой список ПОСЛЕ фильтрации означает «все экземпляры заняты» —
      // это отказ, а не «аппарат не нужен» (пустой список ДО фильтрации).
      const needs = entries.map(e => (e.instances || []).map(String));
      const cands = entries.map((e, i) => needs[i].filter(inst => {
        const b = busy.get(inst) || [];
        return !b.some(r => r.start < t + e.durationMin && r.end > t);
      }));
      if (cands.some((c, i) => needs[i].length && !c.length)) continue;
      if (maxMatching(cands) !== entries.length) continue;
      out.push(t);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Убрать старты, которые уже прошли — только если дата совпадает с сегодняшней.
// now: { date:'YYYY-MM-DD', minutes } (moscowNow).
function dropPastStarts(starts, date, now) {
  if (!now || date !== now.date) return starts;
  return (starts || []).filter(t => t > now.minutes);
}

module.exports = {
  toMin, toHHMM,
  mergeRanges, subtractRanges, intersectRanges, fitsIn,
  recordsToResourceBusy, instancesForService,
  maxMatching, hardResourceConflict, parallelStarts, dropPastStarts,
};
