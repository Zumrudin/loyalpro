'use strict';

// ── Запрос номера телефона для записи — детерминированно, а не промптом ──
//
// Чистый модуль (без БД/HTTP), тесты — agent-phone-request.test.js.
//
// ЗАЧЕМ. Инцидент 2026-09-18 (tdlib 5245186003): Telegram скрыл номер, пациентка
// согласилась на время, модель позвала create_booking БЕЗ client_phone (правило
// промпта «номер запроси на этапе оформления» не сработало — 2 из 2 попыток
// записи без номера за 45 дней, вторая — 05.09 в диалоге 1666686332). Инструмент
// честно ответил «нет номера, запроси у клиента» — и это ЗАДУМАННЫЙ путь, но
// оркестратор считал любой error create_booking провалом записи (bookingFailed),
// а «переигровкой» диспетчер признаёт только реплику со временем HH:MM или
// повторный запрос слотов (эвристика под инцидент 2026-07-28 «время занято»).
// Вопрос «подскажите номер» времени не содержит → реплика погашена, диалог
// уведён к администратору с текстом «передаю администратору». 05.09 тот же путь
// прошёл ТОЛЬКО потому, что реплика случайно содержала «20:00».
//
// РЕШЕНИЕ. Отсутствие номера — не провал записи, а предрешённый ход: единственно
// верный ответ — попросить номер. Поэтому (1) create_booking помечает такой
// возврат флагом needs_phone, (2) оркестратор на нём НЕ ставит bookingErrored и
// НЕ ходит к провайдеру второй раз (тот же класс, что closing.js/visit-rating:
// платить за проход по ~39k-промпту, когда ответ известен, не за что), а отдаёт
// текст отсюда, (3) промпт-правило «тогда и запроси» переформулировано в «просто
// вызывай create_booking — система сама попросит номер», то есть модель больше не
// обязана помнить про этот шаг вовсе.
//
// Время в тексте — ТОЛЬКО если оно уже в allowedTimes хода (то есть прозвучало в
// переписке или в выдаче инструментов): datetime пришёл из аргументов МОДЕЛИ и
// мог быть выдуман, а reply-guard наш детерминированный текст не линтует.
// Формулировка — по образцу промпта (Шаг 6): закрепить время + забота о карте.
// «ваш» намеренно нет: на канале без номера то же сообщение уходит и при записи
// гостя (client_name чужой, client_phone пуст), и там номер — не собеседника.

const NEEDS_PHONE_ERROR =
  'Нет номера телефона клиента. Система САМА попросила номер у пациента этим сообщением — ' +
  'ничего не отвечай. Когда пациент пришлёт номер, повтори вызов create_booking с client_phone.';

// Маркер связи промпт-правила с этим модулем: тест agent-system-prompt.test.js
// проверяет, что ветка «канал без номера» ссылается на детерминированный запрос.
const PROMPT_RULE_MARKER = 'система САМА попросит номер';

function isNeedsPhone(result) {
  return !!(result && typeof result === 'object' && result.needs_phone === true);
}

function formatSlotMoscow(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const date = new Intl.DateTimeFormat('ru-RU',
    { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' }).format(d);
  const time = new Intl.DateTimeFormat('ru-RU',
    { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return { date, time };
}

// datetime — из аргументов create_booking; allowedTimes — Set «HH:MM» хода
// (может отсутствовать → время не называем).
function buildPhoneRequest({ datetime, allowedTimes } = {}) {
  const slot = datetime ? formatSlotMoscow(datetime) : null;
  const timeOk = slot && allowedTimes && typeof allowedTimes.has === 'function' && allowedTimes.has(slot.time);
  const what = timeOk ? `${slot.date} в ${slot.time}` : 'это время';
  return `Чтобы закрепить за вами ${what}, подскажите, пожалуйста, контактный номер телефона 🤍`;
}

module.exports = { NEEDS_PHONE_ERROR, PROMPT_RULE_MARKER, isNeedsPhone, buildPhoneRequest };
