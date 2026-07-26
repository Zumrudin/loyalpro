'use strict';

// ============================================================
// Чистая логика ПОСЛЕДОВАТЕЛЬНОЙ стыковки услуг одного клиента
// («встык», одна за другой). Без БД/HTTP — юнит-тестируемо
// (sequential.test.js). Параллельная запись двоих — equipment.js.
//
// Все интервалы — минуты от полуночи по Москве, конец эксклюзивный
// [start, end). entries — по одной записи на услугу В ПОРЯДКЕ
// выполнения: { ranges, durationMin }, где ranges — свободные окна
// мастера этой услуги, уже за вычетом занятости аппаратов.
// ============================================================

const eq = require('./equipment');

const GRID_STEP = 30;     // сетка стартов первой услуги (чистые :00/:30)
const LINK_ALIGN = 5;     // выравнивание стартов внутри цепочки
const MAX_LINK_GAP = 15;  // максимальный зазор между услугами для «встык»

// Ближайший старт ≥ from (выравнивание к 5-мин сетке), где услуга
// длительностью dur влезает целиком в одно из окон. null — не влезает.
function earliestFitAtOrAfter(ranges, from, dur) {
  for (const r of eq.mergeRanges(ranges)) {
    let s = Math.max(r.start, from);
    s = Math.ceil(s / LINK_ALIGN) * LINK_ALIGN;
    if (s + dur <= r.end) return s;
  }
  return null;
}

// Подогнать цепочку от старта t первой услуги. Каждая следующая —
// с ближайшего подходящего времени; зазор звена ≤ maxLinkGap.
// Возврат { starts:[минуты по услугам], totalGap } или null.
function fitChain(entries, t, opts = {}) {
  const maxLinkGap = opts.maxLinkGap === undefined ? MAX_LINK_GAP : opts.maxLinkGap;
  if (!entries.length || !eq.fitsIn(entries[0].ranges, t, entries[0].durationMin)) return null;
  const starts = [t];
  let cursor = t + entries[0].durationMin;
  let totalGap = 0;
  for (let i = 1; i < entries.length; i++) {
    const s = earliestFitAtOrAfter(entries[i].ranges, cursor, entries[i].durationMin);
    if (s === null || s - cursor > maxLinkGap) return null;
    starts.push(s);
    totalGap += s - cursor;
    cursor = s + entries[i].durationMin;
  }
  return { starts, totalGap };
}

// Все старты первой услуги на чистой сетке GRID_STEP, где цепочка
// собирается. Возврат [{ start, starts, totalGap }] по возрастанию.
function chainStarts(entries, opts = {}) {
  if (!entries || !entries.length) return [];
  const step = opts.step || GRID_STEP;
  const out = [];
  for (const r of eq.mergeRanges(entries[0].ranges)) {
    for (let t = Math.ceil(r.start / step) * step; t + entries[0].durationMin <= r.end; t += step) {
      const fit = fitChain(entries, t, opts);
      if (fit) out.push({ start: t, starts: fit.starts, totalGap: fit.totalGap });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Лучший вариант «с перерывом»: минимальный суммарный зазор,
// при равенстве — более ранний старт. null — не собирается вовсе.
function bestGapChain(entries, opts = {}) {
  let best = null;
  for (const c of chainStarts(entries, { ...opts, maxLinkGap: Infinity })) {
    if (!best || c.totalGap < best.totalGap) best = c;
  }
  return best;
}

module.exports = {
  GRID_STEP, LINK_ALIGN, MAX_LINK_GAP,
  earliestFitAtOrAfter, fitChain, chainStarts, bestGapChain,
};
