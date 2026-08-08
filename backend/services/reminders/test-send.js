'use strict';
// Тестовая отправка напоминания на свой номер: чистая часть.
//
// ЗАЧЕМ вообще отдельный путь. Планирование чисто событийное, и до включения
// правила «в массы» проверить нечего: догон показывает только ВЫБОРКУ визитов,
// а текст (особенно в режиме free, где его пишет Мила) и ступень бонусов
// считаются лишь в момент отправки. Тестовая отправка гоняет ту же строку
// очереди через ТОТ ЖЕ воркер — расхождение теста с боевым путём было бы багом.
//
// ГЛАВНОЕ свойство тестовой строки — она ставится в БУДУЩЕЕ. Боевой тик
// арендует только `scheduled_at <= NOW()`, поэтому забрать её может лишь
// адресная аренда по id (worker.processTestRow) со своими deps. Иначе строку
// между вставкой и запуском теста перехватил бы боевой воркер: реальное
// начисление бонусов, реальный анти-повтор — ровно то, чего в тесте не надо.

const { parseVisitAt } = require('../care/schedule');
const { evaluateRule } = require('../notifications');
const { recordContext } = require('./eligibility');

// Час запаса: тестовый прогон стартует сразу после вставки, а строка должна
// быть недосягаема для боевого тика (раз в минуту) весь этот прогон, включая
// LLM-проход в режиме free (до 60с) и ретрай аренды (120с).
const TEST_LEAD_MS = 3600000;

const DAY_MS = 86400000;

/**
 * Самый свежий СОСТОЯВШИЙСЯ визит клиента ПОД УСЛОВИЯ ПРАВИЛА — якорь для теста.
 * Признаки «состоялся» те же, что у visitReallyHappened (eligibility.js):
 * attendance=1, запись не удалена, дата в прошлом. Иначе {дней} и {услуга}
 * отрендерились бы по визиту, которого не было.
 *
 * УСЛОВИЯ ПРАВИЛА обязательны, и это не украшение. В бою якорь по определению
 * прошёл evaluateRule (планирует его enroll.js), а тест без этого фильтра брал
 * ЛЮБОЙ последний визит — и подсовывал модели противоречивое задание вида
 * «напоминание про лазерную эпиляцию, последний визит: филлер Stylage».
 * Прогон 08.08.2026 (правило «Лазерная эпиляция», номер 79200255591) дал ровно
 * такие отказы: «целевая услуга не совпадает с историей визитов». Тест обязан
 * гонять то же, что бой, иначе он ничего не доказывает.
 *
 * Подходящего визита нет → null: вызывающий (routes/reminders.js) сообщает об
 * этом администратору, а строка теста берёт дату из delay_days с пустыми
 * {услуга}/{мастер}. Откат на «любой последний визит» вернул бы то самое
 * противоречие в промпт.
 *
 * @param {object[]} records сырые записи YClients
 * @param {number}   nowMs
 * @param {object}   [opts]
 * @param {object}   [opts.conditions] условия правила ({logic, items}); без них
 *                   фильтр не применяется (совместимость со старым вызовом)
 * @param {Map}      [opts.catMap]     карта service_id → category_id
 * @returns {{recordId:number|null, visitAt:Date, staffName:string|null, services:object[]}|null}
 */
function pickAnchorVisit(records, nowMs = Date.now(), { conditions = null, catMap = new Map() } = {}) {
  const matches = (r) => {
    if (!conditions) return true;
    try { return evaluateRule(conditions, recordContext(r, catMap)); } catch { return false; }
  };
  let best = null;
  for (const r of (records || [])) {
    if (!r || r.deleted) continue;
    if (Number(r.attendance) !== 1) continue;
    const d = parseVisitAt(r.datetime || r.date);
    if (!d || d.getTime() > nowMs) continue;
    if (best && d.getTime() <= best.visitAt.getTime()) continue;
    if (!matches(r)) continue;
    best = {
      recordId: r.id != null ? r.id : null,
      visitAt: d,
      staffName: (r.staff && r.staff.name) || r.staff_name || null,
      services: Array.isArray(r.services) ? r.services : [],
    };
  }
  return best;
}

/**
 * Значения колонок тестовой строки reminder_queue.
 *
 * anchor_record_id — ВСЕГДА null: реальный id визита упёрся бы в
 * UNIQUE (rule_id, anchor_record_id) с уже запланированной боевой строкой того
 * же визита (INSERT упал бы) и запутал бы атрибуцию. NULL в UNIQUE PostgreSQL
 * не конфликтует ни с чем.
 */
function buildTestRow({ rule, client, phone, anchor, ycClientId = null, nowMs = Date.now() }) {
  const delay = Number(rule.delay_days) || 0;
  // Без id клиента YClients applyBonus детерминированно вернёт no_bonus —
  // ступень в тесте не проверить. Поле карточки заполнено не всегда, поэтому
  // резолвер (по истории записей) перекрывает пустое значение.
  const ycId = (client && client.yclients_client_id) != null
    ? client.yclients_client_id
    : (ycClientId != null ? ycClientId : null);
  return {
    salon_id: rule.salon_id,
    rule_id: rule.id,
    rule_title: rule.title,
    client_id: (client && client.id) != null ? client.id : null,
    phone,
    yclients_client_id: ycId,
    anchor_record_id: null,
    anchor_visit_at: anchor ? anchor.visitAt : new Date(nowMs - delay * DAY_MS),
    anchor_staff_name: anchor ? anchor.staffName : null,
    anchor_services: anchor ? anchor.services : [],
    scheduled_at: new Date(nowMs + TEST_LEAD_MS),
    source: 'test',
  };
}

module.exports = { pickAnchorVisit, buildTestRow, TEST_LEAD_MS };
