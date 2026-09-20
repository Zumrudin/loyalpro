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
const { extractTimes } = require('./reply-guard');

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

// Тройки {ms, staff, name} из результата одного вызова. Ошибочные результаты
// (error) не считаются: их слоты могли быть частью отказа. Имя мастера — для
// сверки предложенного времени по паре «дата + мастер» (offer-attribution):
// у get_available_slots оно в staff_name (запрошенный) и name (альтернативы /
// варианты выбора), у стыковки — staff_name звена; гости get_parallel_slots и
// available_slots ретрая имени не несут (null — «мастер неизвестен»).
function extractPairs(tool, input, result) {
  const out = [];
  if (!result || typeof result !== 'object' || result.error) return out;
  const push = (datetime, staff, name, service) => {
    const ms = toMs(datetime);
    if (Number.isFinite(ms)) {
      out.push({ ms, staff: idOrNull(staff), name: (typeof name === 'string' && name.trim()) || null,
        service: idOrNull(service) });
    }
  };
  const pushSlots = (list, staff, name, service) => {
    for (const s of (Array.isArray(list) ? list : [])) if (s) push(s.datetime, staff, name, service);
  };
  const inputStaff = input && input.staff_yc_id;
  const inputService = input && input.service_yc_id;

  if (tool === 'get_available_slots') {
    pushSlots(result.slots, inputStaff, result.staff_name, inputService);
    for (const key of ['alternative_staff', 'staff_options']) {
      for (const item of (Array.isArray(result[key]) ? result[key] : [])) {
        // Один вызов — одна услуга: alternative_staff/staff_options ищут ТУ ЖЕ
        // услугу у других мастеров, service_yc_id общий для всей выдачи.
        if (item) pushSlots(item.slots, item.staff_yc_id, item.name, inputService);
      }
    }
  } else if (tool === 'get_sequential_slots') {
    for (const v of (Array.isArray(result.variants) ? result.variants : [])) {
      for (const st of (Array.isArray(v && v.starts) ? v.starts : [])) {
        for (const link of (Array.isArray(st && st.chain) ? st.chain : [])) {
          if (link) push(link.datetime, link.staff_yc_id, link.staff_name, link.service_yc_id);
        }
      }
    }
  } else if (tool === 'get_parallel_slots') {
    for (const st of (Array.isArray(result.starts) ? result.starts : [])) {
      for (const g of (Array.isArray(st && st.guests) ? st.guests : [])) {
        if (g) push(g.datetime, g.staff_yc_id, null, g.service_yc_id);
      }
    }
  } else if (tool === 'create_booking') {
    // Ретрай после отказа YClients по времени кладёт в ответ свежие старты
    // того же мастера (withFreshSlotsOnTimeFailure). Сам отвергнутый datetime
    // из input сюда НЕ попадает.
    pushSlots(result.available_slots, inputStaff, null, inputService);
  }
  return out;
}

// Московские дата и время момента — ключи для сверки «дата + мастер».
const MSK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
function moscowDateKey(ms) { return MSK_DATE.format(new Date(ms)); }

function createSlotEvidence() {
  const byMs = new Map();   // ms → Set<staff|null>
  const rows = [];          // {ms, staff, name, service} — для slotsOn и service-сверки
  const seen = new Set();   // дедуп rows по ms|staff|name|service
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
        const k = `${p.ms}|${p.staff}|${p.name}|${p.service}`;
        if (!seen.has(k)) { seen.add(k); rows.push(p); }
      }
    },
    // Старты на московскую дату YYYY-MM-DD: [{time:'HH:MM', staffId, name}].
    slotsOn(dateKey) {
      return rows.filter(r => moscowDateKey(r.ms) === dateKey)
        .map(r => ({ time: moscowHHMM(r.ms), staffId: r.staff, name: r.name }));
    },
    dateKeys() {
      return [...new Set(rows.map(r => moscowDateKey(r.ms)))].sort();
    },
    // @param {string} datetime  ISO (или «YYYY-MM-DD HH:MM:SS») из аргументов write
    // @param {{staffYcId?: number, serviceYcIds?: number[]}} opts
    //   serviceYcIds — реальные услуги записи (при переносе); непустой список
    //   требует, чтобы подтверждающая строка evidence либо не знала услуги
    //   (fail-open — старый источник без service_yc_id), либо несла ОДНУ из
    //   перечисленных. Инцидент 2026-09-19 (79096664042): слот найден под
    //   услугу, которую назвал пациент СВОИМИ словами, а не под ту, что
    //   реально стоит в переносимой записи — совпало по счастливой случайности
    //   (одинаковая длительность), а могло и не совпасть.
    has(datetime, opts = {}) {
      const ms = toMs(datetime);
      if (!Number.isFinite(ms) || !byMs.has(ms)) return false;
      const want = idOrNull(opts.staffYcId);
      const set = byMs.get(ms);
      if (want !== null && !(set.has(want) || set.has(null))) return false;
      const wantServices = Array.isArray(opts.serviceYcIds)
        ? opts.serviceYcIds.map(idOrNull).filter(v => v !== null)
        : null;
      if (!wantServices || !wantServices.length) return true;
      const matches = rows.filter(r => r.ms === ms && (want === null || r.staff === want || r.staff === null));
      return matches.some(r => r.service === null || wantServices.includes(r.service));
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

// ── Согласие пациента: время обязано ЗВУЧАТЬ в хвосте диалога ────────────────
// Тот же инцидент: слоты могли быть запрошены, но модель переносит, не спросив
// пациента («пн утро» → сразу 10:00). Детерминированный минимум: HH:MM нового
// времени (по Москве) встречается цифрами в последних репликах — пациент назвал
// его сам либо Мила предложила, а пациент ответил на это предложение.
const MSK_HM = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false,
});

function moscowHHMM(datetime) {
  const ms = typeof datetime === 'number' ? datetime : toMs(datetime);
  return Number.isFinite(ms) ? MSK_HM.format(new Date(ms)) : null;
}

function timeMentioned(datetime, text) {
  const hm = moscowHHMM(datetime);
  return !!hm && extractTimes(String(text || '')).includes(hm);
}

// Тексты hint-ответов — экспортируются ради тестов промпта (связь правила
// Сценария 3 с кодом) и оркестратора.
function unverifiedSlotHint(datetime, { reschedule } = {}) {
  const what = reschedule ? 'перенос' : 'запись';
  return `Время ${datetime} не подтверждено ни одной выдачей слотов за последние 30 минут — ${what} на него ` +
    'делать нельзя. Сначала вызови get_available_slots на эту дату' +
    (reschedule ? ' (со staff_yc_id мастера существующей записи)' : '') +
    ', затем — если пациент подтвердил конкретное время — повтори вызов с datetime ДОСЛОВНО из выдачи (поле datetime). ' +
    'Пациенту про эту проверку не пиши.';
}

function needsConfirmationHint(datetime) {
  const hm = moscowHHMM(datetime) || datetime;
  return `Время ${hm} не звучало в последних сообщениях переписки — ни пациент его не называл, ни ты не предлагала. ` +
    'Перенос делается ТОЛЬКО после явного согласия: назови пациенту это время цифрами, спроси, подходит ли, и вызови ' +
    'reschedule_booking снова после его ответа «да». Сейчас запись НЕ перенесена — не пиши «перенесла».';
}

// Гейт booking-modify.rescheduleBookingRecord: слот найден по ДРУГОЙ услуге,
// чем та, что реально стоит в переносимой записи (инцидент 2026-09-19).
function wrongServiceHint(datetime, recordServiceIds) {
  return `Слот ${datetime} подтверждён выдачей get_available_slots, но по ДРУГОЙ услуге, чем в переносимой ` +
    `записи (её реальные услуги: id ${recordServiceIds.join(', ')}). Перенос ВСЕГДА сохраняет исходную услугу ` +
    'записи — вызови get_available_slots заново с РЕАЛЬНЫМ service_yc_id этой записи (не тем, что пациент назвал ' +
    'своими словами; мастер — тот же, что уже используется в переносе, если пациент не просил его сменить), и ' +
    'повтори reschedule_booking с datetime ДОСЛОВНО из новой выдачи. Пациенту про эту проверку не пиши.';
}

// Связь промпта с кодом (Сценарий 3, Шаг 5): правило обязано называть все три
// hint-ответа по имени — иначе модель прочтёт их как провал и уйдёт в
// «извинись и escalate». Проверяется в agent-system-prompt.test.js.
const PROMPT_RULE_MARKERS = ['unverified_slot', 'needs_confirmation', 'wrong_service'];

module.exports = {
  createSlotEvidence, SLOT_EVIDENCE_TOOLS, extractPairs,
  timeMentioned, moscowHHMM, moscowDateKey, unverifiedSlotHint, needsConfirmationHint, wrongServiceHint,
  PROMPT_RULE_MARKERS,
};
