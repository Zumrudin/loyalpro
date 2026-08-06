'use strict';
// ============================================================
// Вечерний автосброс пауз «отвечал администратор».
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОХОД, если снятие паузы уже есть в диспетчере: там оно
// ЛЕНИВОЕ — считается в момент прихода ВХОДЯЩЕГО сообщения и только если это
// сообщение попало внутрь окна расписания. У PERI окно ночное (22:00–09:30):
// администратор отвечает днём, клиент пишет тоже днём, а дневное сообщение до
// проверки не доходит вовсе — гейт возвращает `outside-schedule` и диспетчер
// выходит раньше. Результат на проде за трое суток: НОЛЬ снятий, 12 диалогов
// висят красными, а администраторы возвращали их боту руками по одному
// (21 диалог 04.08 в 22:16 и 05.08 в 22:09–22:33 — ровно на открытии окна).
// Проход ничего не ждёт: открылось окно — паузы, поставленные до него, сняты.
//
// Ленивую проверку в диспетчере не убираем: она снимает паузу МГНОВЕННО на
// первом же сообщении, не дожидаясь тика.
// ============================================================
const configDefault = require('../../config');
const agentSettings = require('../agent-settings');
const dialogState = require('./dialog-state');
const { decideGate, minutesSinceWindowStart, nowMskMinutes } = require('../agent-gate');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentPauseSweep');

// Салоны, где вечерний сброс вообще имеет смысл: без расписания у окна нет
// якоря — снимать паузу не от чего (та же готча, что у ленивой проверки).
async function listSalonIdsDefault() {
  const { db } = require('../../db');
  const rows = await db.any(
    `SELECT salon_id FROM agent_settings
      WHERE enabled = TRUE AND schedule_enabled = TRUE ORDER BY salon_id`);
  return rows.map(r => r.salon_id);
}

// Один салон. Возвращает список РЕАЛЬНО снятых ключей диалогов.
// deps — для тестов: { settings, state, nowMinutes }.
async function sweepSalon(salonId, deps = {}) {
  const settings = deps.settings || agentSettings;
  const state = deps.state || dialogState;

  const s = await settings.getSettings(salonId);
  // Агент выключен в салоне — красить диалоги в «бот» нельзя: отвечать некому.
  if (!s.enabled || !s.scheduleEnabled) return [];

  const nowMinutes = typeof deps.nowMinutes === 'number' ? deps.nowMinutes : nowMskMinutes();
  const window = {
    scheduleEnabled: s.scheduleEnabled,
    scheduleStart: s.scheduleStart,
    scheduleEnd: s.scheduleEnd,
    nowMinutes,
  };
  const since = minutesSinceWindowStart(window);
  if (since === null) return [];   // окно закрыто или границы битые

  const stale = await state.listStaleOperatorPauses(salonId, since);
  if (!stale.length) return [];

  // Гейт допуска по КАЖДОМУ кандидату — тем же чистым правилом, что у входящих.
  // Иначе диалог с номером из чёрного списка (или не из белого в режиме
  // whitelist) стал бы зелёным, а отвечать в нём Мила по-прежнему не станет.
  const rules = await settings.listNumberRules(salonId, null);
  const allow = rules.filter(r => r.rule_type === 'allow').map(r => r.phone);
  const block = rules.filter(r => r.rule_type === 'block').map(r => r.phone);
  const keys = stale.filter(k =>
    decideGate({ enabled: true, mode: s.mode, allow, block, phone: k, ...window }).allow);
  if (!keys.length) return [];

  const resumed = await state.resumeOperatorPauses(salonId, keys, since);
  if (resumed.length) {
    logger.info(`salon=${salonId}: паузы оператора сняты по открытию окна (${resumed.length}): ${resumed.join(', ')}`);
  }
  return resumed;
}

// Все салоны. Сбой одного не роняет остальные: это фоновый тик, а не запрос.
async function sweepAll(deps = {}) {
  const config = deps.config || configDefault;
  // Глобальный kill-switch агента: если Мила выключена целиком, возвращать ей
  // диалоги нечестно — в списке чатов они позеленеют, а отвечать будет некому.
  if (!config.CHATPUSH || !config.CHATPUSH.agentEnabled) return [];
  const listSalonIds = deps.listSalonIds || listSalonIdsDefault;

  let salonIds;
  try {
    salonIds = await listSalonIds();
  } catch (e) {
    logger.warn(`не получить список салонов (${e.message})`);
    return [];
  }

  const out = [];
  for (const salonId of salonIds) {
    try {
      const resumed = await sweepSalon(salonId, deps);
      if (resumed.length) out.push({ salonId, resumed });
    } catch (e) {
      logger.warn(`salon=${salonId}: вечерний сброс не прошёл (${e.message})`);
    }
  }
  return out;
}

module.exports = { sweepSalon, sweepAll };
