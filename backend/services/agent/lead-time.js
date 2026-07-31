'use strict';

// ── Минимальный срок до визита (бизнес-правило клиники). ────────────────────
// Специалисты выходят в клинику под конкретную запись, поэтому запись «впритык»
// запрещена:
//   • день в день — старт не раньше, чем через SAME_DAY_LEAD_MIN от «сейчас»;
//   • сообщение в 22:00 и позже — на завтра старт не раньше 12:00, даже если
//     раньше есть свободные окна (персонал прочитает переписку только утром и
//     не успеет вызвать специалиста к раннему времени);
//   • сообщение ночью (00:00–06:59) — на сегодня тоже не раньше 12:00: это та же
//     «вечерняя» ситуация, просто после полуночи целевой день стал «сегодня»,
//     и одно правило +2ч пропускало бы утреннюю запись, о которой персонал
//     узнает слишком поздно.
// Чистые функции: «сейчас» подаётся снаружи как {date:'YYYY-MM-DD', minutes}
// по Москве (см. moscowNow). Правило применяется в инструментах слотов
// (get_available_slots / get_parallel_slots / get_sequential_slots) И в
// write-инструментах (create_booking / reschedule_booking) — иначе клиент,
// назвавший раннее время сам, обошёл бы фильтр выдачи.

const SAME_DAY_LEAD_MIN = 120;       // день в день: минимум +2 часа от текущего момента
const EVENING_FROM_MIN = 22 * 60;    // «поздний вечер» — с 22:00 включительно
const NIGHT_UNTIL_MIN = 7 * 60;      // «ночь» длится до 07:00: заявка ночью на сегодня — тоже не раньше 12:00
const NEXT_DAY_FLOOR_MIN = 12 * 60;  // вечерняя/ночная заявка: не раньше 12:00

const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Текущий момент по Москве: { date:'YYYY-MM-DD', minutes: часы*60+минуты }.
// Та же реализация, что в инструментах слотов, — вынесена сюда для write-guard'ов.
function moscowNow(ms) {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB',
    { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const [h, m] = hm.split(':').map(Number);
  return { date, minutes: h * 60 + m };
}

// Нижняя граница старта визита (минуты от полуночи, старт валиден при
// slotMin >= floor) для записи на date при текущем моменте now.
// 0 — ограничений нет. Прошедшие даты не наша забота: их отрезают
// существующие проверки «не предлагать прошлое», а floor для сегодня
// (now + 2ч) сам по себе строже любой из них.
function minStartMin(now, date) {
  if (!now || !date) return 0;
  if (date === now.date) {
    const lead = now.minutes + SAME_DAY_LEAD_MIN;
    // Ночью (до 07:00) действует та же граница 12:00, что и вечером на завтра;
    // берём максимум с +2ч — вдруг границы когда-нибудь сблизят.
    return now.minutes < NIGHT_UNTIL_MIN ? Math.max(lead, NEXT_DAY_FLOOR_MIN) : lead;
  }
  if (now.minutes >= EVENING_FROM_MIN && date === addDays(now.date, 1)) return NEXT_DAY_FLOOR_MIN;
  return 0;
}

// Разбор ISO-строки слота ('YYYY-MM-DDTHH:MM[:SS][±TZ]' / 'YYYY-MM-DD HH:MM')
// → {date, minutes}. null — не распознано. Часовой пояс не пересчитываем:
// слоты по всему агенту ходят в московском времени (+03:00).
function parseSlotDatetime(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return { date: m[1], minutes: Number(m[2]) * 60 + Number(m[3]) };
}

// Guard для create_booking / reschedule_booking: нарушает ли datetime
// минимальный срок. null — всё в порядке (в т.ч. непонятный формат: fail-open,
// кривой datetime отловят существующие проверки ниже по конвейеру).
function violation(now, datetimeStr) {
  const t = parseSlotDatetime(datetimeStr);
  if (!t) return null;
  const floor = minStartMin(now, t.date);
  if (!floor || t.minutes >= floor) return null;
  const sameDay = t.date === now.date;
  return { date: t.date, floor, sameDay, night: sameDay && now.minutes < NIGHT_UNTIL_MIN };
}

// Корректирующее сообщение модели (не пациенту!) для отклонённого datetime.
function violationHint(v) {
  if (v.night) {
    return 'Это время недоступно: ночная заявка — запись на сегодня возможна только с 12:00. ' +
      'Вызови get_available_slots заново и предложи время из свежих slots (они уже учитывают это ' +
      'ограничение) или другой день.';
  }
  if (v.sameDay) {
    if (v.floor >= 24 * 60) {
      return 'Это время недоступно: день в день запись возможна минимум через 2 часа от текущего ' +
        'момента, а до конца дня столько не осталось — на сегодня записи больше нет. ' +
        'Мягко предложи пациенту другой день (get_available_slots на другую дату).';
    }
    return `Это время недоступно: день в день запись возможна минимум через 2 часа от текущего ` +
      `момента, то есть не раньше ${toHHMM(v.floor)}. Вызови get_available_slots заново и предложи ` +
      `время из свежих slots (они уже учитывают это ограничение) или другой день.`;
  }
  return 'Это время недоступно: заявка поздним вечером — запись на завтра возможна только с 12:00. ' +
    'Вызови get_available_slots заново и предложи время из свежих slots (они уже учитывают это ' +
    'ограничение) или другой день.';
}

module.exports = {
  SAME_DAY_LEAD_MIN, EVENING_FROM_MIN, NIGHT_UNTIL_MIN, NEXT_DAY_FLOOR_MIN,
  moscowNow, minStartMin, violation, violationHint, toHHMM,
};
