'use strict';
// Чистый отбор диалог-дней прогона по строкам store.listDialogDays.
// «Менялся ли диалог-день» решается по max_ts сообщений против source_max_ts
// сохранённого вердикта, а не по updated_at: эхо tdlib/MAX ложится в БД с
// задержкой, а msg_ts у него — время самого сообщения.

const num = v => (v == null ? null : Number(v));

function integer(v, name) {
  if (v == null) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new TypeError(`${name} must be an integer`);
    if (!Number.isSafeInteger(v)) throw new RangeError(`${name} number must be a safe integer`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new TypeError(`${name} must be an integer`);
}

function pickPending(rows, { recompute = false, onlyStale = false, sinceTs = null, taxonomyVersion } = {}) {
  const out = [];
  for (const r of rows || []) {
    let maxTs;
    if (sinceTs != null) {
      maxTs = integer(r.max_ts, 'max_ts');
      if (maxTs == null || maxTs < integer(sinceTs, 'sinceTs')) continue;
    }
    const has = r.verdict_id != null;
    if (onlyStale) {
      if (has && (num(r.taxonomy_version) < taxonomyVersion || r.status === 'other')) out.push(r);
      continue;
    }
    if (recompute || !has) {
      out.push(r);
      continue;
    }
    maxTs = maxTs === undefined ? integer(r.max_ts, 'max_ts') : maxTs;
    const sourceMaxTs = integer(r.source_max_ts, 'source_max_ts');
    if (maxTs != null && (sourceMaxTs == null || maxTs > sourceMaxTs)) out.push(r);
  }
  return out;
}

// → [[day, rows], …], дни по убыванию (свежие первыми: бэкфилл начинает с нужного).
function groupByDayDesc(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!m.has(r.day)) m.set(r.day, []);
    m.get(r.day).push(r);
  }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
}

function chunks(arr, size) {
  if (typeof size !== 'number') throw new TypeError('size must be a number');
  if (!Number.isInteger(size) || size <= 0) throw new RangeError('size must be a positive integer');
  const out = [];
  for (let i = 0; i < (arr || []).length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = { pickPending, groupByDayDesc, chunks };
