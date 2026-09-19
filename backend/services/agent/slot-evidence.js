'use strict';

// ── Старты, которые инструменты РЕАЛЬНО вернули за ход (+ свежий журнал) ─────
//
// ЗАЧЕМ. Инцидент 2026-09-19 (79651442032): «Можно перенести на пн утро?» →
// модель ПЕРВЫМ действием позвала reschedule_booking на 21.09 10:00 и 11:00, не
// вызвав ни одного слот-инструмента — времена выдуманы (у мастера в понедельник
// выходной). Требование «datetime — ТОЧНУЮ строку из get_available_slots» жило
// только в описании инструмента и в промпте, кода за ним не было ни у переноса,
// ни у создания записи. Мораторий на промпт-правила (CLAUDE.md): защита — в коде.
//
// Инвариант: write-инструмент (create_booking / reschedule_booking) принимает
// datetime, ТОЛЬКО если такой старт вернул слот-инструмент в этом ходу или в
// журнале не старше SLOT_TIMES_FRESH_MS (пациент подтвердил ходом позже). Иначе
// инструмент отвечает hint-ом «сначала запроси слоты» БЕЗ похода в YClients.
//
// Сравнение — по МОМЕНТУ (Date.parse), а не по строке: «+03:00», «Z» и
// «2026-09-23 17:00:00» одного момента обязаны совпадать. Мастер сверяется,
// только когда известен с ОБЕИХ сторон: старт get_sequential_slots несёт
// staff_yc_id звена, старт alternative_staff — своего мастера; write без
// staff_yc_id (перенос без смены мастера) сверяется по одному времени.
//
// Чистый модуль: без БД и HTTP; журнал приходит строками tool-events.loadRecent.

const { SLOT_TIMES_FRESH_MS } = require('./tool-memory');

const SLOT_EVIDENCE_TOOLS = new Set([
  'get_available_slots', 'get_sequential_slots', 'get_parallel_slots', 'create_booking',
]);

function toMs(datetime) {
  if (typeof datetime !== 'string' || !datetime.trim()) return NaN;
  return Date.parse(datetime.trim().replace(' ', 'T'));
}

function idOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Пары {ms, staff} из результата одного вызова. Ошибочные результаты (error)
// не считаются: их слоты могли быть частью отказа.
function extractPairs(tool, input, result) {
  const out = [];
  if (!result || typeof result !== 'object' || result.error) return out;
  const push = (datetime, staff) => {
    const ms = toMs(datetime);
    if (Number.isFinite(ms)) out.push({ ms, staff: idOrNull(staff) });
  };
  const pushSlots = (list, staff) => {
    for (const s of (Array.isArray(list) ? list : [])) if (s) push(s.datetime, staff);
  };
  const inputStaff = input && input.staff_yc_id;

  if (tool === 'get_available_slots') {
    pushSlots(result.slots, inputStaff);
    for (const key of ['alternative_staff', 'staff_options']) {
      for (const item of (Array.isArray(result[key]) ? result[key] : [])) {
        if (item) pushSlots(item.slots, item.staff_yc_id);
      }
    }
  } else if (tool === 'get_sequential_slots') {
    for (const v of (Array.isArray(result.variants) ? result.variants : [])) {
      for (const st of (Array.isArray(v && v.starts) ? v.starts : [])) {
        for (const link of (Array.isArray(st && st.chain) ? st.chain : [])) {
          if (link) push(link.datetime, link.staff_yc_id);
        }
      }
    }
  } else if (tool === 'get_parallel_slots') {
    for (const st of (Array.isArray(result.starts) ? result.starts : [])) {
      for (const g of (Array.isArray(st && st.guests) ? st.guests : [])) {
        if (g) push(g.datetime, g.staff_yc_id);
      }
    }
  } else if (tool === 'create_booking') {
    // Ретрай после отказа YClients по времени кладёт в ответ свежие старты
    // того же мастера (withFreshSlotsOnTimeFailure). Сам отвергнутый datetime
    // из input сюда НЕ попадает.
    pushSlots(result.available_slots, inputStaff);
  }
  return out;
}

function createSlotEvidence() {
  const byMs = new Map();   // ms → Set<staff|null>
  const api = {
    get size() {
      let n = 0;
      for (const set of byMs.values()) n += set.size;
      return n;
    },
    add(tool, input, result) {
      if (!SLOT_EVIDENCE_TOOLS.has(tool)) return;
      for (const p of extractPairs(tool, input, result)) {
        if (!byMs.has(p.ms)) byMs.set(p.ms, new Set());
        byMs.get(p.ms).add(p.staff);
      }
    },
    // @param {string} datetime  ISO (или «YYYY-MM-DD HH:MM:SS») из аргументов write
    // @param {{staffYcId?: number}} opts мастер на стороне write (если известен)
    has(datetime, opts = {}) {
      const ms = toMs(datetime);
      if (!Number.isFinite(ms) || !byMs.has(ms)) return false;
      const want = idOrNull(opts.staffYcId);
      if (want === null) return true;
      const set = byMs.get(ms);
      return set.has(want) || set.has(null);
    },
    // Строки tool-events.loadRecent ({tool,input,result,is_error,age_ms}).
    // Выброшенный черновик (delivered=false) засевает: слот был реален в момент
    // выдачи, пациент его не видел — но и запись на него не выдумка.
    seedFromJournal(rows, opts = {}) {
      if (!Array.isArray(rows)) return;
      const maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : SLOT_TIMES_FRESH_MS;
      for (const r of rows) {
        if (!r || r.is_error) continue;
        const age = Number(r.age_ms);
        if (!Number.isFinite(age) || age > maxAge) continue;
        api.add(r.tool, r.input, r.result);
      }
    },
  };
  return api;
}

module.exports = { createSlotEvidence, SLOT_EVIDENCE_TOOLS, extractPairs };
