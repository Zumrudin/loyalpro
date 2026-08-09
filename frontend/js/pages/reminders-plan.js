// Чистые помощники блока «План отправок» (вкладка «История напоминаний»).
// Вынесены отдельным модулем ради node --test, как chat-dialog-sort.js: тут
// арифметика времени, где ошибка на шаг незаметна глазом, а цена ей — обещание
// администратору, во сколько уйдёт последнее сообщение дня.

const REM_PLAN_DAY_END_MIN = 21 * 60;   // конец дневного окна темпа (paceDeferMinutes), ИСКЛЮЧАЮЩИЙ

/** 'YYYY-MM-DD' → 'дд.мм'. Строку намеренно НЕ гоняем через Date. */
function remPlanDayLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? `${m[3]}.${m[2]}` : '—';
}

/**
 * Во сколько уйдёт последнее сообщение дня и сколько их вообще влезет.
 * Воркер отдаёт по одному сообщению в паузу, поэтому n-я строка уходит через
 * (n-1) пауз после первой. Всё, что попадает на 21:00 и позже, переносится на
 * следующий день (дневной потолок темпа) — это и есть overflow.
 * @returns {{text:string, overflow:boolean, fits:number}|null} null — считать нечего.
 */
function remPlanDayFinish(firstTime, count, intervalMin) {
  const iv = Number(intervalMin);
  const n = Number(count);
  const m = /^(\d{2}):(\d{2})$/.exec(String(firstTime || ''));
  if (!m || !Number.isFinite(iv) || iv <= 0 || !Number.isFinite(n) || n <= 1) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const fits = Math.max(1, Math.min(n, Math.floor((REM_PLAN_DAY_END_MIN - 1 - start) / iv) + 1));
  const end = start + (Math.min(n, fits) - 1) * iv;
  return {
    text: `${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`,
    overflow: fits < n,
    fits,
  };
}

if (typeof window !== 'undefined') {
  window.remPlanDayLabel = remPlanDayLabel;
  window.remPlanDayFinish = remPlanDayFinish;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { remPlanDayLabel, remPlanDayFinish };
}
