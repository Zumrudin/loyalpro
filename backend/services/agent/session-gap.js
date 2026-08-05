'use strict';

// Граница «новой переписки» — разрыв между текущей серией сообщений пациента и
// предыдущим сообщением диалога.
//
// ЗАЧЕМ: транскрипт грузится с LIMIT 20 и БЕЗ окна по времени, поэтому диалог,
// возобновлённый через неделю, для модели неотличим от продолжающегося, и
// правило промпта «здоровайся один раз за диалог» срабатывает на ложной посылке.
// Инцидент 2026-08-05 (79299761316): пациентка написала «Доброе утро», Мила
// ответила без приветствия — в окне лежала переписка от 29.07, где с пациенткой
// здоровался живой администратор.
const DEFAULT_GAP_HOURS = 6;

// Русское склонение: 1 час / 2 часа / 5 часов.
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

// Разрыв словами: до 48 часов — в часах, дальше — в сутках (вниз).
// Часы округляем до БЛИЖАЙШЕГО, а не вниз: разрыв меряется до начала серии
// сообщений клиента, поэтому «неделя молчания» на деле выходит 6 д 23:59:40 —
// с округлением вниз это «6 дней». Идёт прямо в промпт, поэтому формулировка
// человеческая, а не «604780 сек».
function formatGap(sec) {
  const hours = Math.round(sec / 3600);
  if (hours < 48) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

// msg_ts приходит из PG строкой (bigint), из pending — числом. Number(null) === 0,
// поэтому проверять одним Number.isFinite нельзя: битый ts дал бы разрыв «с 1970».
function toTs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// rows — сырые строки транскрипта в ХРОНОЛОГИЧЕСКОМ порядке (до склейки серий и
// до переноса хвостового assistant-блока: обе операции теряют границы сообщений).
// → { newSession, gapText }, gapText непуст только при newSession.
function detectSession(rows, opts) {
  // opts=null проходит мимо дефолта параметра (тот ловит только undefined) —
  // без этого исключение улетело бы наверх и уронило бы ход диалога.
  const o = opts || {};
  const gapHours = Number(o.gapHours) > 0 ? Number(o.gapHours) : DEFAULT_GAP_HOURS;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { newSession: true, gapText: null };

  // Последнее входящее, а не последняя строка: задержанное эхо Chatpush получает
  // msg_ts ПОЗЖЕ нового входящего и стоит в хвосте (см. history.js).
  let last = -1;
  for (let k = list.length - 1; k >= 0; k--) {
    if (list[k].direction === 'incoming') { last = k; break; }
  }
  // Входящих в окне нет вовсе — сюда попадает и «только исходящие» из нескольких
  // строк, и единственное исходящее сообщение (history.js фильтрует пустой текст,
  // так что входящее-картинка без подписи из окна выпадает — тот же случай).
  if (last < 0) return { newSession: false, gapText: null };

  // Начало ХВОСТОВОЙ СЕРИИ сообщений пациента. Сравнивать два последних сообщения
  // нельзя: после долгого молчания клиент часто пишет 2-3 сообщения подряд, и
  // разрыв между ними — секунды, то есть ровно наш случай был бы не виден.
  let start = last;
  while (start > 0 && list[start - 1].direction === 'incoming') start--;
  if (start === 0) return { newSession: true, gapText: null };   // в окне только клиент

  const prev = toTs(list[start - 1].msg_ts);
  const burstStart = toTs(list[start].msg_ts);
  // Битый ts → молчим: лишнее приветствие заметнее пациенту, чем его отсутствие.
  if (prev === null || burstStart === null) return { newSession: false, gapText: null };

  const gapSec = burstStart - prev;
  if (gapSec < gapHours * 3600) return { newSession: false, gapText: null };
  return { newSession: true, gapText: formatGap(gapSec) };
}

module.exports = { detectSession, DEFAULT_GAP_HOURS };
