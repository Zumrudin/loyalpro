'use strict';

const { mergeRanges } = require('./equipment');

// ============================================================
// ПЛОТНАЯ ЗАПИСЬ: какое из свободных времён предложить пациенту первым.
//
// Инцидент 2026-08-06 (диалог 79037504378): пациентка времени не называла,
// get_available_slots вернул 11:00…14:00 строго по возрастанию, модель взяла из
// начала списка и записала на 11:30. У мастера при этом был сплошной блок
// 14:30–21:00, то есть запись оставила огрызок 11:00–11:30 и 2.5 часа простоя.
// Вплотную к блоку встаёт ровно один слот — 14:00.
//
// Промпт-правилами это не чинится: правило «предлагай 1–2 времени из slots»
// модель выполнила дословно, а понятия «плотно» у неё нет вовсе. Считаем кодом.
//
// Все интервалы — минуты от полуночи по Москве, конец эксклюзивный: [start, end).
// Без БД и HTTP — юнит-тестируемо (agent-slot-density.test.js).
// ============================================================

const SEANCE_STEP_MIN = 5;   // шаг сетки /timetable/seances
// Ровно столько, сколько промпт велит называть («предложи 1 или 2 времени»).
// Экспортируется РАДИ ТЕСТОВ: фикстура с зашитой двойкой осталась бы зелёной и
// после сдвига капа.
const MAX_OFFER_SLOTS = 2;

// Половины дня словами пациента. Границы утверждены с салоном 07.08: «до обеда» —
// строго ДО 14:00, «после обеда» — с 14:00, «вечером» — с 17:00 (вечер и вторая
// половина намеренно ПЕРЕСЕКАЮТСЯ: 14:00 вечером никто не назовёт, а «после обеда»
// вечер включает). Список закрытый: незнакомое значение фильтром не считается —
// пустая выдача из-за опечатки модели читалась бы пациентом как отказ клиники.
const DAY_PARTS = {
  morning:   { from: 0,        to: 14 * 60 },
  afternoon: { from: 14 * 60,  to: 24 * 60 },
  evening:   { from: 17 * 60,  to: 24 * 60 },
};

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

// Сетка /timetable/seances → занятые интервалы мастера.
//
// ЗАЧЕМ сетка, а не /records: она уже загружена в schedule-ветке инструмента —
// расчёт не стоит ни одного лишнего запроса в YClients. И она знает не только
// записи, но и любую другую занятость кресла (перерыв, блокировку), а примыкать
// к перерыву для плотности так же хорошо, как к записи.
//
// ГОТЧА: границы сетки = границы смены (проверено на проде: смена 11:00–21:00 →
// ровно 120 точек 11:00…20:55). Поэтому края смены в занятость НЕ попадают и
// анкорами не становятся. Если YClients когда-нибудь начнёт присылать сутки
// целиком с is_free:false вне смены, слот в начале смены получит разрыв 0 и
// снова победит — то есть фикс сломается МОЛЧА. На это стоит тест.
function seancesToBusy(seances) {
  const out = [];
  for (const s of (Array.isArray(seances) ? seances : [])) {
    if (!s || s.is_free) continue;
    const start = toMin(s.time);
    if (!Number.isFinite(start)) continue;
    out.push({ start, end: start + SEANCE_STEP_MIN });
  }
  return mergeRanges(out);
}

// Стоимость слота [start, start+dur): расстояние до ближайшей занятости слева и
// справа. Бесконечность = с этой стороны занятости нет вовсе.
//
// anchor — КРАЙ занятости, к которому слот примыкает ближе всего: `b<минута>` —
// конец блока слева, `a<минута>` — начало блока справа. По нему слоты дедуплицируются
// (см. pickOfferSlots), поэтому ключ — именно край, а не блок: у одного блока их два
// («вплотную перед началом» и «сразу после конца»), и оба законны.
function slotCost(slot, busy, durationMin) {
  const start = toMin(slot.time);
  const fromSlot = Math.round((Number(slot.seance_length) || 0) / 60);
  const dur = fromSlot > 0 ? fromSlot : (durationMin > 0 ? durationMin : 0);
  const end = start + dur;
  let before = Infinity;
  let after = Infinity;
  let beforeEdge = null;
  let afterEdge = null;
  for (const b of busy) {
    if (b.end <= start && start - b.end < before) { before = start - b.end; beforeEdge = b.end; }
    if (b.start >= end && b.start - end < after) { after = b.start - end; afterEdge = b.start; }
  }
  const near = Math.min(before, after);
  // Ничьё (before === after) отдаём левому краю — лишь бы детерминированно:
  // такой слот и так лучший в обеих группах, а порядок ключей менять нельзя,
  // иначе выдача перестаёт быть воспроизводимой при разборе инцидента.
  const anchor = near === Infinity ? 'none' : (before <= after ? `b${beforeEdge}` : `a${afterEdge}`);
  return { near, far: Math.max(before, after), start, anchor };
}

// Сравнение чисел ВЫЧИТАНИЕМ ЗАПРЕЩЕНО: у слота без соседей near/far равны
// Infinity, а Infinity - Infinity === NaN. Компаратор, вернувший NaN, оставляет
// порядок неопределённым — и «пустой день → самые ранние» тихо перестаёт
// работать ровно там, где регресс никто не заметит.
const cmp = (a, b) => (a === b ? 0 : (a < b ? -1 : 1));

// Топ-N слотов по плотности, НЕ БОЛЬШЕ ОДНОГО НА КАЖДЫЙ КРАЙ ЗАНЯТОСТИ. Критерий
// (утверждён с салоном): минимум мёртвого времени до/после ближайшей существующей
// записи; при равенстве — слот, который примыкает ВТОРОЙ стороной тоже (закрывает
// дыру целиком); при равенстве — раньше по времени.
//
// ЗАЧЕМ дедуп по анкору (правка 07.08). Раньше брались просто два лучших по
// стоимости — а это соседние окошки ОДНОГО свободного куска: на боевом дне Пери
// 07.08 выдача была «13:30 и 14:00» (у салона — «13:00 и 13:30»). Второе время не
// просто бесполезно: возьми пациент раннее из пары, между ним и блоком останется
// дыра ровно в шаг сетки. Полезных времён у занятого блока ровно два — вплотную
// ПЕРЕД началом и сразу ПОСЛЕ конца, и это два разных края.
//
// Слот возвращается ЦЕЛЫМ объектом из входного массива: модель цитирует то же
// самое, что лежит в slots, и create_booking получает тот же datetime.
//
// Поля-причины («примыкает к записи») тут намеренно НЕТ: модель процитирует её
// пациенту, а это внутренняя кухня клиники — тот же класс, что «у главного врача
// на завтра всё занято» (инцидент 2026-08-04).
function pickOfferSlots(slots, busy, opts = {}) {
  const list = (Array.isArray(slots) ? slots : []).filter(s => s && s.time);
  if (!list.length) return [];
  const ranges = Array.isArray(busy) ? busy : [];
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : MAX_OFFER_SLOTS;
  const durationMin = Number(opts.durationMin) || 0;
  // Занятости нет вовсе — анкоров нет, дедуплицировать нечего. Это путь ДЕГРАДАЦИИ
  // (сетка сеансов не ответила): отдаём прежние самые ранние. Реально свободный день
  // сюда не приходит — его отдельно ловит chooseOffer и времени не называет вообще.
  if (!ranges.length) return list.slice(0, limit);
  const scored = list.map((slot, i) => Object.assign({ slot, i }, slotCost(slot, ranges, durationMin)));
  scored.sort((a, b) => cmp(a.near, b.near) || cmp(a.far, b.far) || cmp(a.start, b.start) || cmp(a.i, b.i));
  const out = [];
  const seen = new Set();
  for (const s of scored) {
    if (seen.has(s.anchor)) continue;   // этот край занятости уже закрыт лучшим слотом
    seen.add(s.anchor);
    out.push(s.slot);
    if (out.length >= limit) break;
  }
  return out;
}

// Слоты внутри половины дня, названной ПАЦИЕНТОМ. Незнакомое значение (модель
// прислала 'утро' или 'day') фильтром не считается — см. DAY_PARTS.
function filterByDayPart(slots, dayPart) {
  const list = Array.isArray(slots) ? slots : [];
  const part = DAY_PARTS[String(dayPart || '').trim().toLowerCase()];
  if (!part) return list;
  return list.filter((s) => {
    const m = s && s.time ? toMin(s.time) : NaN;
    return Number.isFinite(m) && m >= part.from && m < part.to;
  });
}

// Края интервала: самое раннее и самое позднее время. Нужны там, где анкоров нет
// вовсе (у мастера ни одной записи), а пациент уже назвал половину дня: «плотного»
// времени в пустом дне не существует, зато края смены/половины не оставляют
// висящего огрызка с одной стороны — и это выбор из двух, а не соседние окошки.
function pickEdgeSlots(slots, limit = MAX_OFFER_SLOTS) {
  const list = (Array.isArray(slots) ? slots : []).filter(s => s && s.time);
  if (!list.length) return [];
  const sorted = list.slice().sort((a, b) => cmp(toMin(a.time), toMin(b.time)));
  if (limit < 2 || sorted.length === 1) return [sorted[0]];
  return [sorted[0], sorted[sorted.length - 1]];
}

// ЧТО ПРЕДЛОЖИТЬ ПАЦИЕНТУ — единственное решение, собранное в одном месте.
// Вход: слоты (уже после lead-time и вычета оборудования), занятость мастера,
// busyKnown (сетка сеансов реально получена) и dayPart (половина дня, которую
// назвал пациент). Выход: { offer, freeDay, dayPartEmpty }.
//
//  • freeDay — у мастера в этот день НЕТ ни одной записи. Времени не предлагаем
//    вовсе: любое разрывает пустой день на две дыры, «плотного» варианта не
//    существует. Промпт по этому флагу спрашивает половину дня (решение салона
//    07.08), а не угадывает за пациента.
//  • dayPart задан — вопрос уже задан и отвечен: freeDay не выставляется НИКОГДА,
//    иначе модель спросила бы о половине дня второй раз и зациклилась.
//  • dayPartEmpty — в названной половине свободного времени нет. Молчать нельзя, и
//    спрашивать заново нечего: считаем по ОСТАЛЬНОМУ дню и отдаём флаг, по которому
//    промпт честно говорит «в это время занято» и предлагает найденное.
//  • busyKnown=false (сетка не ответила) — «день свободен» утверждать НЕ на чем:
//    деградируем в прежнее поведение (самые ранние), а не в вопрос о половине дня.
function chooseOffer(slots, busy, opts = {}) {
  const list = (Array.isArray(slots) ? slots : []).filter(s => s && s.time);
  const none = { offer: [], freeDay: false, dayPartEmpty: false };
  if (!list.length) return none;
  const ranges = Array.isArray(busy) ? busy : [];
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : MAX_OFFER_SLOTS;
  const durationMin = Number(opts.durationMin) || 0;
  const asked = Boolean(DAY_PARTS[String(opts.dayPart || '').trim().toLowerCase()]);
  const pool = asked ? filterByDayPart(list, opts.dayPart) : list;
  const dayPartEmpty = asked && !pool.length;
  const effective = dayPartEmpty ? list : pool;
  const freeDay = Boolean(opts.busyKnown) && !ranges.length;
  if (freeDay && !asked) return { offer: [], freeDay: true, dayPartEmpty: false };
  const offer = freeDay
    ? pickEdgeSlots(effective, limit)
    : pickOfferSlots(effective, ranges, { durationMin, limit });
  return { offer, freeDay: false, dayPartEmpty };
}

module.exports = {
  seancesToBusy, pickOfferSlots, filterByDayPart, pickEdgeSlots, chooseOffer,
  MAX_OFFER_SLOTS, DAY_PARTS,
};
