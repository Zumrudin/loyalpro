'use strict';

// ── Окно присутствия живого администратора (мск, AGENT_ADMIN_HOURS). ──
// Аудит 2026-08-01: Мила работает и ночью (окно расписания «для всех» пускает
// диалоги круглосуточно), когда живого администратора в чате нет — обещание
// «подключится с минуты на минуту» в 3 часа ночи было ложью. Фразы эскалации
// (в промпте через adminOffHours и детерминированные страховки диспетчера)
// обязаны быть честными по времени суток.
// Битые вход/окно → fail-open (false, «администратор на месте»): лучше дневная
// фраза из-за кривого env, чем вечное «ответит утром».

function parseWindow(win) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(win || '').trim());
  if (!m) return null;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  if (start === end || start > 1439 || end > 1439) return null; // пустое/битое окно
  return { start, end };
}

// hhmm — «14:35» (мск). Начало окна включительно, конец исключительно;
// окно через полночь поддержано (start > end) — как в расписании агента.
function isAdminOffHours(hhmm, window) {
  const w = parseWindow(window);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!w || !m) return false;
  const t = +m[1] * 60 + +m[2];
  const inside = w.start < w.end ? (t >= w.start && t < w.end) : (t >= w.start || t < w.end);
  return !inside;
}

function nowHHMMMoscow(nowMs) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(nowMs != null ? new Date(nowMs) : new Date());
}

// «Перевод на администратора в этой реплике УЖЕ объявлен» — по этому признаку
// диспетчер решает, дошлать ли handoverText отдельным сообщением.
// Живёт рядом с самими фразами перевода намеренно: признак сверяют ДВЕ стороны —
// dispatcher.js (ветка res.escalated) и авторы детерминированных реплик
// (visit-rating.buildApology). Своя копия регулярки на каждой стороне молча
// разъехалась бы с текстом, и пациент получил бы объявление о переводе либо
// ДВАЖДЫ, либо (при переписанном тексте) ни одного.
const HANDOVER_ANNOUNCED_RE = /администратор/i;

// Детерминированная страховка диспетчера: модель эскалировала, не объявив перевод.
// Стиль администраторов (27.10.2026): коротко, «Вы» с заглавной, 🤍.
function handoverText(offHours) {
  return offHours
    ? 'Передаю Ваш вопрос администратору. Сейчас нерабочее время, он ответит Вам с утра 🤍'
    : 'Передаю Ваш вопрос администратору, он подключится с минуты на минуту 🤍';
}

// Страховка инварианта «агент никогда не молчит» (ход без реплик / сбой).
// Диалог тут уже переведён на человека, поэтому не «уточню и вернусь»:
// отвечает администратор.
function silentFallbackText(offHours) {
  return offHours
    ? 'Передаю Ваш вопрос администратору, он ответит Вам с утра 🤍'
    : 'Секунду, передаю Ваш вопрос администратору, он ответит Вам с минуты на минуту 🤍';
}

module.exports = {
  parseWindow, isAdminOffHours, nowHHMMMoscow, handoverText, silentFallbackText,
  HANDOVER_ANNOUNCED_RE,
};
