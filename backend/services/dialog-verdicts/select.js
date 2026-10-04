'use strict';
// Чистый отбор диалог-дней прогона по строкам store.listDialogDays.
// «Менялся ли диалог-день» решается по max_ts сообщений против source_max_ts
// сохранённого вердикта, а не по updated_at: эхо tdlib/MAX ложится в БД с
// задержкой, а msg_ts у него — время самого сообщения.

const num = v => (v == null ? null : Number(v));

function pickPending(rows, { recompute = false, onlyStale = false, sinceTs = null, taxonomyVersion } = {}) {
  const out = [];
  for (const r of rows || []) {
    if (sinceTs != null && num(r.max_ts) < sinceTs) continue;
    const has = r.verdict_id != null;
    if (onlyStale) {
      if (has && (num(r.taxonomy_version) < taxonomyVersion || r.status === 'other')) out.push(r);
      continue;
    }
    if (recompute || !has || num(r.max_ts) > num(r.source_max_ts)) out.push(r);
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
  const out = [];
  for (let i = 0; i < (arr || []).length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = { pickPending, groupByDayDesc, chunks };
