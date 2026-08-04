'use strict';

// ── Память Милы между ходами: детерминированная выжимка журнала инструментов ──
// Чистый модуль: вход — строки agent_tool_events (tool-events.loadRecent),
// выход — строки блока «ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ» для волатильного хвоста промпта.
// Без БД и HTTP. Рендер обязан быть детерминированным (nowMs передаётся снаружи):
// иначе не работает префикс-кэш провайдера.
//
// Правила отбора:
//  • только доставленные ходы (delivered=true) — факты, которые пациент видел;
//  • ИСКЛЮЧЕНИЕ: write-инструменты рендерятся при ЛЮБОМ delivered — запись в
//    YClients существует независимо от судьбы реплики, забыть её опаснее всего;
//  • ошибочные вызовы (is_error) не рендерятся: провалы уже обработаны
//    диспетчером в том же ходе (bookingFailed/falseSuccess);
//  • слоты: конкретные времена — только если событию < 30 минут; старше — лишь
//    факт «смотрела слоты» (иначе память воспроизвела бы инцидент со стухшими
//    слотами 2026-07-31, TIME_UNAVAILABLE);
//  • PII-аргументы (client_phone/client_name/comment) в рендер не попадают
//    никогда — тот же список, что у лога вызовов в оркестраторе.

const MSK = 'Europe/Moscow';
const WRITE_TOOLS = new Set([
  'create_booking', 'book_chain', 'cancel_booking', 'reschedule_booking', 'modify_booking_services',
]);
const PII_ARGS = new Set(['client_phone', 'client_name', 'comment']);

const SLOT_TIMES_FRESH_MS = 30 * 60 * 1000;
const MAX_EVENTS = 30;
const MAX_CHARS = 4000;   // ≈1–1.5k токенов кириллицы — потолок блока в промпте

function parseMaybe(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

function mskParts(tsMs) {
  const d = new Date(tsMs);
  return {
    day: new Intl.DateTimeFormat('en-CA', { timeZone: MSK }).format(d),
    human: new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, day: 'numeric', month: 'long' }).format(d),
    time: new Intl.DateTimeFormat('ru-RU', { timeZone: MSK, hour: '2-digit', minute: '2-digit', hour12: false }).format(d),
  };
}

function timeLabel(tsMs, nowMs) {
  const e = mskParts(tsMs);
  if (e.day === mskParts(nowMs).day) return `сегодня ${e.time}`;
  if (e.day === mskParts(nowMs - 86400000).day) return `вчера ${e.time}`;
  return `${e.day} ${e.time}`;
}

// Дата-время записи из ISO-строки input.datetime → «5 августа 14:00» (мск).
function fmtDatetime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = mskParts(d.getTime());
  return `${p.human} ${p.time}`;
}

// Скалярные аргументы без PII: k=v через запятую (как summarizeToolInput в логе).
function fmtArgs(input) {
  if (!input || typeof input !== 'object') return '';
  const bits = [];
  for (const [k, v] of Object.entries(input)) {
    if (PII_ARGS.has(k)) continue;
    if (v === null || v === undefined || typeof v === 'object') continue;
    bits.push(`${k}=${String(v).slice(0, 40)}`);
  }
  return bits.join(',').slice(0, 120);
}

// Скалярные поля результата для фолбэк-экстрактора.
function fmtResultScalars(result) {
  if (!result || typeof result !== 'object') return '';
  const bits = [];
  for (const [k, v] of Object.entries(result)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    bits.push(`${k}=${String(v).slice(0, 60)}`);
    if (bits.length >= 4) break;
  }
  return bits.join(', ').slice(0, 160);
}

function compactVisit(v) {
  if (!v || typeof v !== 'object') return 'запись';
  const when = v.datetime || v.date || '';
  const services = Array.isArray(v.services)
    ? v.services.map(s => (s && (s.title || s.name)) || s).filter(Boolean).join('+') : (v.title || '');
  return [when, services].filter(Boolean).join(' ').slice(0, 80) || 'запись';
}

// Экстракторы: событие → одна строка факта (или null — событие пропустить).
// ctx.fresh — событию меньше SLOT_TIMES_FRESH_MS.
const EXTRACTORS = {
  create_booking(e) {
    const inp = e.input || {}, res = e.result || {};
    const bits = [`создала запись record_id=${res.record_id}`];
    if (inp.datetime) bits.push(`на ${fmtDatetime(inp.datetime)}`);
    if (inp.service_yc_id) bits.push(`service_yc_id=${inp.service_yc_id}`);
    if (inp.staff_yc_id) bits.push(`staff_yc_id=${inp.staff_yc_id}`);
    return bits.join(' ');
  },
  book_chain(e) {
    const res = e.result || {};
    const recs = Array.isArray(res.records) ? res.records : [];
    const items = recs.slice(0, 4).map(r => `${fmtDatetime(r.datetime)} (record_id=${r.record_id})`);
    if (!items.length) return null;
    const head = res.booked_all ? 'оформила цепочку записей' : 'цепочка записей оформлена ЧАСТИЧНО';
    return `${head}: ${items.join('; ')}`;
  },
  cancel_booking(e) {
    return `отменила запись record_id=${(e.input || {}).record_id}`;
  },
  reschedule_booking(e) {
    const inp = e.input || {};
    return `перенесла запись record_id=${inp.record_id}${inp.datetime ? ` на ${fmtDatetime(inp.datetime)}` : ''}`;
  },
  modify_booking_services(e) {
    const inp = e.input || {};
    const add = (Array.isArray(inp.add_service_yc_ids) ? inp.add_service_yc_ids : []).join('+');
    const rm = (Array.isArray(inp.remove_service_yc_ids) ? inp.remove_service_yc_ids : []).join('+');
    return `изменила состав записи record_id=${inp.record_id}${add ? `, добавила ${add}` : ''}${rm ? `, убрала ${rm}` : ''}`;
  },
  get_available_slots(e, ctx) {
    const inp = e.input || {}, res = e.result || {};
    const base = `смотрела слоты service_yc_id=${inp.service_yc_id} staff_yc_id=${inp.staff_yc_id} на ${inp.date}`;
    if (!ctx.fresh) return `${base} (выдача устарела — при вопросе о времени перезапроси)`;
    const slots = Array.isArray(res.slots) ? res.slots : [];
    if (!slots.length) {
      return `${base}: свободного времени не было${res.alternative_staff ? ', предлагала альтернативных мастеров' : ''}`;
    }
    const times = slots.slice(0, 12).map(s => s && s.time).filter(Boolean);
    return `${base}: показаны ${times.join(', ')}${slots.length > 12 ? '…' : ''}`;
  },
  get_service_masters(e) {
    const res = e.result || {};
    const svcs = Array.isArray(res.services) ? res.services : [];
    if (!svcs.length) return null;
    const parts = svcs.slice(0, 3).map(s => {
      const st = (Array.isArray(s.staff) ? s.staff : []).slice(0, 5)
        .map(m => `${m.name} ${m.price_display}`).join(', ');
      return `«${s.title}»: ${st || 'мастеров нет'}`;
    });
    return `называла цены — ${parts.join('; ')}`;
  },
  get_client_visit_history(e) {
    const res = e.result || {};
    const visits = Array.isArray(res.visits) ? res.visits : [];
    if (!visits.length) return `читала историю визитов: пусто${res.reason ? ` (${res.reason})` : ''}`;
    return `читала историю визитов: ${visits.length} шт., свежие — ${visits.slice(0, 3).map(compactVisit).join('; ')}`;
  },
  list_client_bookings(e) {
    const res = e.result || {};
    const bookings = Array.isArray(res.bookings) ? res.bookings : [];
    if (!bookings.length) return `смотрела актуальные записи пациента: нет${res.reason ? ` (${res.reason})` : ''}`;
    return `смотрела актуальные записи пациента: ${bookings.length} шт. — ${bookings.slice(0, 3).map(compactVisit).join('; ')}`;
  },
  search_knowledge_base(e) {
    const inp = e.input || {};
    return `искала в базе знаний: «${String(inp.query || '').slice(0, 60)}»`;
  },
};

function extract(e, ctx) {
  const fn = EXTRACTORS[e.tool];
  if (fn) {
    try { return fn(e, ctx); } catch (err) { /* падение экстрактора → фолбэк */ }
  }
  const args = fmtArgs(e.input);
  const res = fmtResultScalars(e.result);
  return `${e.tool}(${args})${res ? ` → ${res}` : ''}`;
}

// Главная функция: строки журнала → { lines, dropped }.
// rows — из tool-events.loadRecent (хронологический порядок, age_ms из SQL).
function renderMemory(rows, opts = {}) {
  const nowMs = opts.nowMs || 0;   // без nowMs всё считается устаревшим (безопасно)
  const events = (Array.isArray(rows) ? rows : []).map(r => ({
    tool: String(r.tool || ''),
    input: parseMaybe(r.input),
    result: parseMaybe(r.result),
    isError: !!r.is_error,
    delivered: r.delivered,
    tsMs: nowMs - Number(r.age_ms || 0),
  }));

  const visible = events.filter(e =>
    !e.isError && (e.delivered === true || WRITE_TOOLS.has(e.tool)));

  // Кап по числу событий: write не срезаются никогда, read — старейшие первыми.
  const writes = visible.filter(e => WRITE_TOOLS.has(e.tool));
  const reads = visible.filter(e => !WRITE_TOOLS.has(e.tool));
  const keptReads = reads.slice(-Math.max(0, MAX_EVENTS - writes.length));
  const kept = writes.concat(keptReads).sort((a, b) => a.tsMs - b.tsMs);

  let items = kept.map(e => {
    const fact = extract(e, { fresh: nowMs - e.tsMs < SLOT_TIMES_FRESH_MS });
    if (!fact) return null;
    return { write: WRITE_TOOLS.has(e.tool), line: `[${timeLabel(e.tsMs, nowMs)}] ${fact}` };
  }).filter(Boolean);

  // Кап по символам: пока не влезает — выбрасываем старейший read-факт.
  let total = items.reduce((n, it) => n + it.line.length + 1, 0);
  while (total > MAX_CHARS) {
    const idx = items.findIndex(it => !it.write);
    if (idx === -1) break;   // остались только write — их не режем
    total -= items[idx].line.length + 1;
    items.splice(idx, 1);
  }

  return { lines: items.map(it => it.line), dropped: visible.length - items.length };
}

module.exports = { renderMemory, SLOT_TIMES_FRESH_MS, MAX_EVENTS, MAX_CHARS, WRITE_TOOLS };
