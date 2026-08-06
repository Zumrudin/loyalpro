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
function slotCost(slot, busy, durationMin) {
  const start = toMin(slot.time);
  const fromSlot = Math.round((Number(slot.seance_length) || 0) / 60);
  const dur = fromSlot > 0 ? fromSlot : (durationMin > 0 ? durationMin : 0);
  const end = start + dur;
  let before = Infinity;
  let after = Infinity;
  for (const b of busy) {
    if (b.end <= start) before = Math.min(before, start - b.end);
    if (b.start >= end) after = Math.min(after, b.start - end);
  }
  return { near: Math.min(before, after), far: Math.max(before, after), start };
}

// Сравнение чисел ВЫЧИТАНИЕМ ЗАПРЕЩЕНО: у слота без соседей near/far равны
// Infinity, а Infinity - Infinity === NaN. Компаратор, вернувший NaN, оставляет
// порядок неопределённым — и «пустой день → самые ранние» тихо перестаёт
// работать ровно там, где регресс никто не заметит.
const cmp = (a, b) => (a === b ? 0 : (a < b ? -1 : 1));

// Топ-N слотов по плотности. Критерий (утверждён с салоном): минимум мёртвого
// времени до/после ближайшей существующей записи; при равенстве — слот, который
// примыкает ВТОРОЙ стороной тоже (закрывает дыру целиком); при равенстве —
// раньше по времени.
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
  const scored = list.map((slot, i) => Object.assign({ slot, i }, slotCost(slot, ranges, durationMin)));
  scored.sort((a, b) => cmp(a.near, b.near) || cmp(a.far, b.far) || cmp(a.start, b.start) || cmp(a.i, b.i));
  return scored.slice(0, limit).map(x => x.slot);
}

module.exports = { seancesToBusy, pickOfferSlots, MAX_OFFER_SLOTS };
