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
//  • инструменты из SKIP_TOOLS не рендерятся вовсе (см. список ниже);
//  • слоты: конкретные времена — только если событию < 30 минут; старше — лишь
//    факт «смотрела слоты» (иначе память воспроизвела бы инцидент со стухшими
//    слотами 2026-07-31, TIME_UNAVAILABLE); гейт свежести действует на ВСЕХ
//    четырёх слот-инструментах (get_available_slots/get_available_dates/
//    get_sequential_slots/get_parallel_slots), не только на первом —
//    у каждого свой экстрактор, фолбэк ctx.fresh не проверяет;
//  • PII-поля (телефон/имя/email клиента, свободный комментарий) в рендер не
//    попадают никогда — ни из input (аргументы вызова), ни из result (поля
//    ответа инструмента). Сегодня это гарантируют только выделенные
//    экстракторы: они явно перечисляют, какие поля результата показывать.
//    Фолбэк для НЕИЗВЕСТНОГО инструмента (fmtResultScalars) фильтрует те же
//    ключи по имени — иначе он был бы «безопасен» только случайно, пока
//    ни один инструмент не кладёт PII скаляром верхнего уровня результата.

const MSK = 'Europe/Moscow';
const WRITE_TOOLS = new Set([
  'create_booking', 'book_chain', 'cancel_booking', 'reschedule_booking', 'modify_booking_services',
]);
// Точные имена полей (как LOG_PII_ARGS в orchestrator.js) + паттерн на класс
// «телефон/полное имя/email» — покрывает будущие инструменты, кладущие PII
// скаляром верхнего уровня результата, а не только сегодняшние три поля.
const PII_EXACT_KEYS = new Set(['client_phone', 'client_name', 'comment']);
const PII_KEY_RE = /phone|client_name|full_name|e-?mail/i;
function isPiiKey(k) {
  return PII_EXACT_KEYS.has(k) || PII_KEY_RE.test(k);
}

// Времена, которые пациент РЕАЛЬНО услышал. Инструмент подбирает их сам
// (offer_slots — слоты, примыкающие к существующим записям мастера), и в журнал
// должно попадать именно это: рендер первых элементов полного slots писал бы в
// память время, которое модель никогда не называла, и следующим ходом она
// сослалась бы на него как на предложенное.
// Старые события журнала (до выката offer_slots) живут в памяти ещё 48 часов —
// для них фолбэк на slots обязателен.
// free_day (день у мастера пустой) — времён не было НАМЕРЕННО: правило промпта
// велит вместо времени спросить половину дня. Фолбэк на slots написал бы в память
// «показаны 11:00, 11:30…», и следующим ходом модель сослалась бы на время, которое
// пациент никогда не слышал — тот же дефект, из-за которого рендер вообще перевели
// с начала slots на offer_slots.
function shownTimes(holder, cap) {
  if (holder && holder.free_day) return [];
  const offer = Array.isArray(holder.offer_slots) ? holder.offer_slots : [];
  const all = Array.isArray(holder.slots) ? holder.slots : [];
  const src = offer.length ? offer : all;
  return src.slice(0, cap).map(s => s && s.time).filter(Boolean);
}

// Инструменты, которых в памяти быть НЕ должно. Фолбэк (fmtResultScalars)
// задуман для НЕИЗВЕСТНОГО инструмента — будущего, у которого экстрактора ещё
// нет; на ЗАРЕГИСТРИРОВАННЫХ (tools/index.js) он давал либо вредную строку,
// либо пустышку вроде «list_staff()», которая занимает место в бюджете
// MAX_EVENTS и вытесняет настоящие факты. Общий критерий: строка памяти нужна
// только для факта, которого НЕТ в транскрипте, — id записи, сырые времена
// слотов, названные цены. Всё, что Мила уже проговорила пациенту текстом, и
// так вернётся к ней транскриптом, дублировать это в промпте незачем.
const SKIP_TOOLS = new Set([
  // escalate_to_operator: результат {escalated:true, reason:<текст модели>} —
  // reason скаляр, PII-фильтр по именам его не ловит, и он уходил бы в промпт
  // ПОСЛЕДНИМ блоком, то есть свежее всего. После кнопки «Вернуть боту» промпт
  // отдельным блоком говорит считать конфликт РАЗРЕШЁННЫМ, а память тянула бы
  // назад его формулировку — ровно тот класс регресса (спам-хендовер и
  // ре-эскалация после возврата боту), который уже чинился блоком де-эскалации.
  'escalate_to_operator',
  // Живые персональные данные, которые по памяти называть нельзя: баланс — по
  // прямому правилу промпта, остаток абонемента меняется после каждого визита.
  // Фолбэк давал «found=true» и «note=Активных абонементов не найдено.» — цифры
  // никакой, зато соблазн ответить не перезванивая инструмент.
  'get_bonus_balance',
  'get_client_abonements',
  // get_client: результат — факт наличия карточки (PII-гейт отдаёт имя только
  // по номеру самого собеседника, и то объектом, который фолбэк не печатает).
  // Идентификация пациента и так в промпте отдельным блоком; «get_client() →
  // found=true» не добавляет ничего.
  'get_client',
  // Статические справочники: список мастеров и каталог услуг не меняются между
  // ходами, всегда доступны одним вызовом (а в режиме AGENT_CATALOG_IN_PROMPT
  // каталог прямо в промпте). Фолбэк рендерил голое «list_staff()» — «инструмент
  // был вызван» и ни одного факта.
  'list_staff',
  'list_services',
]);

const SLOT_TIMES_FRESH_MS = 30 * 60 * 1000;
const MAX_EVENTS = 30;
// ≈1–1.5k токенов кириллицы — потолок блока в промпте. Не включает префикс
// "- " (~2 символа/строку), который дописывает сборщик блока в system-prompt.js
// — фактический размер блока чуть больше MAX_CHARS, это осознанно.
const MAX_CHARS = 4000;

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
    if (isPiiKey(k)) continue;
    if (v === null || v === undefined || typeof v === 'object') continue;
    bits.push(`${k}=${String(v).slice(0, 40)}`);
  }
  return bits.join(',').slice(0, 120);
}

// Скалярные поля результата для фолбэк-экстрактора. Тот же PII-фильтр, что и
// у аргументов: результат НЕИЗВЕСТНОГО инструмента может положить персональные
// данные скаляром верхнего уровня (напр. будущий `client_full_name`) — без
// фильтра по имени поля это утекло бы в промпт как «безопасное» число/строку.
function fmtResultScalars(result) {
  if (!result || typeof result !== 'object') return '';
  const bits = [];
  for (const [k, v] of Object.entries(result)) {
    if (isPiiKey(k)) continue;
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
    // Мастера в запросе могло не быть вовсе: пациент его не называл, и инструмент
    // посчитал окна у ВСЕХ исполнителей услуги (staff_options вместо slots) —
    // выбор специалиста делает пациент. Читая только res.slots, память писала
    // «staff_yc_id=undefined … свободного времени не было» — то есть врала ровно
    // там, где тем же ходом пациенту показали времена трёх мастеров.
    const who = inp.staff_yc_id ? `staff_yc_id=${inp.staff_yc_id}` : 'у всех исполнителей';
    // Половина дня, названная пациентом, сужает выдачу — без неё узкий список времён
    // читается следующим ходом как «больше у мастера ничего нет».
    const part = inp.day_part ? ` day_part=${String(inp.day_part).slice(0, 16)}` : '';
    const base = `смотрела слоты service_yc_id=${inp.service_yc_id} ${who} на ${inp.date}${part}`;
    if (!ctx.fresh) return `${base} (выдача устарела — при вопросе о времени перезапроси)`;
    if (Array.isArray(res.staff_options)) {
      // В строку идут только имя мастера и времена: должность (position) уже была
      // названа пациенту в реплике и вернётся транскриптом, а бюджет блока общий.
      // Многоточие при срезе — обязательное, как в одномастерной ветке ниже:
      // «Юлия: 12:00, 12:30, 13:00, 13:30, 14:00, 14:30» без него читается как
      // ПОЛНЫЙ список окон, и следующим ходом модель отвечает пациенту «больше
      // у Юлии времени нет» — про окна, которые сама же показала часом раньше.
      const per = res.staff_options.slice(0, 3).map((o) => {
        const all = Array.isArray(o.slots) ? o.slots : [];
        const times = shownTimes(o, 6);
        // Пустой день мастера: времён не называли намеренно (спрашивали половину дня).
        if (!times.length) return `${o.name}: весь день свободен, время не называла`;
        return `${o.name}: ${times.join(', ')}${all.length > times.length ? '…' : ''}`;
      });
      if (per.length) return `${base}: показаны ${per.join('; ')}${res.staff_options.length > 3 ? '…' : ''}`;
      // Пустой выбор — это ДВА разных случая, и путать их нельзя (тот же водораздел,
      // что в самом инструменте): «нет ни у кого» законно только когда все исполнители
      // реально ответили. Недостижимый из-за сбоя YClients мастер выпадает из выдачи
      // так же, как занятый, и выданный за занятого превращается в выдуманный отказ
      // клиники — класс инцидента 2026-07-31 («это время только что заняли»).
      return res.no_staff_available
        ? `${base}: свободного времени не было ни у кого из исполнителей`
        : `${base}: свободных окон не нашла, но проверить удалось не всех исполнителей — перезапроси`;
    }
    const slots = Array.isArray(res.slots) ? res.slots : [];
    if (!slots.length) {
      const alt = res.alternative_staff ? ', предлагала альтернативных мастеров' : '';
      // «Занят» и «в отпуске» — разные факты, и в журнале их путать нельзя:
      // из «свободного времени не было» следующий ход делает вывод «день был
      // расписан» и идёт перебирать соседние даты, хотя мастера нет в графике
      // ещё три недели (инцидент 2026-08-10, 79166524647).
      if (res.staff_not_working) {
        const next = res.staff_next_working_date
          ? `, ближайший приёмный день ${res.staff_next_working_date}`
          : ', других рабочих дней в проверенном периоде не было';
        return `${base}: мастер в этот день НЕ РАБОТАЕТ (нет в графике)${next}${alt}`;
      }
      return `${base}: свободного времени не было${alt}`;
    }
    const times = shownTimes(res, 12);
    // Тот же случай в одномастерной ветке: окна есть, но пациенту их не называли —
    // у мастера весь день свободен, и вместо времени задавался вопрос о половине дня.
    if (!times.length) return `${base}: у мастера весь день свободен, время не называла — спрашивала половину дня`;
    return `${base}: показаны ${times.join(', ')}${slots.length > times.length ? '…' : ''}`;
  },
  get_available_dates(e, ctx) {
    const inp = e.input || {}, res = e.result || {};
    const period = (inp.date_from || inp.date_to) ? ` ${inp.date_from || '…'}–${inp.date_to || '…'}` : '';
    const base = `смотрела график мастера staff_yc_id=${inp.staff_yc_id}${period}`;
    if (!ctx.fresh) return `${base} (выдача устарела — при вопросе о графике перезапроси)`;
    const schedule = Array.isArray(res.schedule) ? res.schedule : [];
    if (!schedule.length) return `${base}: рабочих дней в периоде не нашла`;
    const days = schedule.slice(0, 6).map(d => {
      const hrs = Array.isArray(d.hours) && d.hours.length
        ? ` ${d.hours[0].from}-${d.hours[d.hours.length - 1].to}` : '';
      return `${d.date}${hrs}`;
    });
    return `${base}: рабочие дни — ${days.join(', ')}${schedule.length > 6 ? '…' : ''}`;
  },
  get_parallel_slots(e, ctx) {
    const inp = e.input || {}, res = e.result || {};
    const guests = Array.isArray(inp.guests) ? inp.guests : [];
    const guestDesc = guests.map(g => `staff_yc_id=${g && g.staff_yc_id}`).join('+');
    const base = `смотрела параллельные слоты на ${inp.date} (${guests.length} гостя: ${guestDesc})`;
    if (!ctx.fresh) return `${base} (выдача устарела — при вопросе о времени перезапроси)`;
    const starts = Array.isArray(res.starts) ? res.starts : [];
    if (!starts.length) {
      return `${base}: общего окна не нашла${res.reason ? ` (${res.reason})` : ''}`;
    }
    const times = starts.slice(0, 12).map(s => s && s.time).filter(Boolean);
    return `${base}: показаны ${times.join(', ')}${starts.length > 12 ? '…' : ''}`;
  },
  get_sequential_slots(e, ctx) {
    const inp = e.input || {}, res = e.result || {};
    const svcCount = Array.isArray(inp.services) ? inp.services.length : 0;
    const base = `смотрела стыковку ${svcCount} услуг подряд с ${inp.date}`;
    if (!ctx.fresh) return `${base} (выдача устарела — используй витрину активных вариантов, не эти времена)`;
    const variants = Array.isArray(res.variants) ? res.variants : [];
    if (!variants.length) return `${base}: подходящих вариантов не нашла${res.reason ? ` (${res.reason})` : ''}`;
    // ТОЛЬКО факт и времена — option_id внутренний и живёт в отдельной витрине
    // «АКТИВНЫЕ ВАРИАНТЫ СТЫКОВКИ» (sequential-offers.js); протухший id из
    // памяти модель не должна цитировать пациенту мимо этой витрины.
    const parts = variants.slice(0, 3).map(v => {
      const staffNames = (Array.isArray(v.staff) ? v.staff : []).map(s => s && s.name).filter(Boolean).join('+');
      const times = (Array.isArray(v.starts) ? v.starts : []).slice(0, 3)
        .map(s => s && s.time).filter(Boolean).join(', ');
      return `${v.date}${staffNames ? ` у ${staffNames}` : ''}: ${times}`;
    });
    return `${base}: показаны варианты — ${parts.join('; ')}`;
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
  // Прайс в картинках: факт «этот лист пациент уже видел». Без него на «пришлите
  // ещё раз» модель не знает, что уже слала. Название направления пришло из
  // индекса, где оно уже прочищено price-list.cell — в промпт идёт безопасным.
  send_price_list(e) {
    const res = e.result || {};
    const cat = String(res.category || (e.input || {}).category || '').slice(0, 60);
    if (res.attached) {
      return `отправила пациенту фото прайс-листа: ${cat}${res.photos ? ` (${res.photos} фото)` : ''}`;
    }
    return `прайс-лист «${cat}» не отправила (${res.reason || '—'}) — предлагала ссылку на сайт`;
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
  // idx — исходная позиция в rows (порядок loadRecent, хронологический). Нужен
  // как тай-брейк при сортировке: все события ОДНОГО хода флашатся одним
  // multi-row INSERT с DEFAULT NOW(), поэтому у них совпадает created_at и,
  // следовательно, tsMs — без тай-брейка Array.sort по равным ключам стабильно
  // сохранял бы пред-сортировочный порядок writes.concat(keptReads), который
  // ВСЕГДА ставит write впереди read независимо от реальной причинности хода
  // (инцидент: «сначала посмотрела историю, потом записала» рендерился в
  // обратном порядке).
  const events = (Array.isArray(rows) ? rows : []).map((r, idx) => ({
    tool: String(r.tool || ''),
    input: parseMaybe(r.input),
    result: parseMaybe(r.result),
    isError: !!r.is_error,
    delivered: r.delivered,
    tsMs: nowMs - Number(r.age_ms || 0),
    idx,
  }));

  // SKIP_TOOLS отсеиваются ДО капов: их строки не должны ни попадать в промпт,
  // ни съедать бюджет MAX_EVENTS, ни считаться срезанными в dropped.
  const visible = events.filter(e =>
    !e.isError && !SKIP_TOOLS.has(e.tool) && (e.delivered === true || WRITE_TOOLS.has(e.tool)));

  // Кап по числу событий: write не срезаются НИКОГДА (даже если их больше
  // MAX_EVENTS — итог тогда осознанно превышает MAX_EVENTS, запись в YClients
  // важнее лимита строк), read — старейшие первыми, в пределах оставшегося
  // бюджета. readsBudget обязан быть проверен явно: `reads.slice(-0)` в JS
  // эквивалентен slice(0) (весь массив), а НЕ пустому срезу — при
  // writes.length >= MAX_EVENTS отрицательный ноль тихо возвращал бы все read.
  const writes = visible.filter(e => WRITE_TOOLS.has(e.tool));
  const reads = visible.filter(e => !WRITE_TOOLS.has(e.tool));
  const readsBudget = Math.max(0, MAX_EVENTS - writes.length);
  const keptReads = readsBudget ? reads.slice(-readsBudget) : [];
  const droppedByCountCap = reads.length - keptReads.length;
  const kept = writes.concat(keptReads).sort((a, b) => (a.tsMs - b.tsMs) || (a.idx - b.idx));

  // fact===null — экстрактору нечего сказать (напр. book_chain без records,
  // get_service_masters с пустым services). Это НЕ срез капом — событие само
  // по себе пустое, dropped его не считает (см. droppedByCountCap/CharCap ниже).
  let items = kept.map(e => {
    const fact = extract(e, { fresh: nowMs - e.tsMs < SLOT_TIMES_FRESH_MS });
    if (!fact) return null;
    return { write: WRITE_TOOLS.has(e.tool), line: `[${timeLabel(e.tsMs, nowMs)}] ${fact}` };
  }).filter(Boolean);

  // Кап по символам: пока не влезает — выбрасываем старейший read-факт.
  let total = items.reduce((n, it) => n + it.line.length + 1, 0);
  let droppedByCharCap = 0;
  while (total > MAX_CHARS) {
    const idx = items.findIndex(it => !it.write);
    if (idx === -1) break;   // остались только write — их не режем
    total -= items[idx].line.length + 1;
    items.splice(idx, 1);
    droppedByCharCap++;
  }

  // dropped означает РОВНО «срезано капом» (число + символы) — оркестратор
  // логирует dropped>0 как «журнал срезан капом»; событие без факта не должно
  // попадать в этот счётчик, иначе лог врал бы про срез там, где ничего не резали.
  return { lines: items.map(it => it.line), dropped: droppedByCountCap + droppedByCharCap };
}

module.exports = { renderMemory, SLOT_TIMES_FRESH_MS, MAX_EVENTS, MAX_CHARS, WRITE_TOOLS, SKIP_TOOLS };
