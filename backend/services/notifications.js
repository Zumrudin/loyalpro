// ============================================================
// Автоуведомления по событиям записи YClients — ФАСАД
// ============================================================
//
// Правила живут в notification_rules (условия по специалисту/категории/услугам,
// объединяемые И или ИЛИ). Модуль разобран на папку services/notifications/:
//   events.js   — снимок записи из вебхука, классификация события, моменты отправки;
//   render.js   — renderTemplate (плейсхолдеры шаблона);
//   rules.js    — evaluateRule, resolveRouting, ALLOWED_CHANNELS, splitVisitDatetime,
//                 getServiceCategoryMap (категорий в payload записи нет — только
//                 services[].id, маппинг строится из каталога YClients), lastIncomingChannel,
//                 lastConversation;
//   settings.js — настройки салона (режим off/shadow/live, тихие часы, тексты отбивок);
//   cascade.js  — порядок и адресаты каскада мессенджеров;
//   enroll.js   — handleRecordEvent: на КАЖДОМ record-вебхуке (routes/webhook.js) ведёт
//                 состояние записи и ставит job'ы в notification_jobs;
//   worker.js   — воркер очереди notification_jobs: перепроверка, режим, каскад, сверка доставки.
// Отсюда они ре-экспортируются под ПРЕЖНИМИ именами — на них завязаны «Забота»,
// напоминания, followup Милы, роуты и server.js. Своей логики в фасаде нет.

const enroll = require('./notifications/enroll');
const worker = require('./notifications/worker');
const {
  evaluateRule, resolveRouting, ALLOWED_CHANNELS, getServiceCategoryMap, lastIncomingChannel, splitVisitDatetime,
} = require('./notifications/rules');
const { renderTemplate } = require('./notifications/render');

module.exports = {
  handleRecordEvent: enroll.handleRecordEvent,
  startNotificationWorker: worker.startNotificationWorker,
  ALLOWED_CHANNELS,
  // чистые хелперы — для роутов и тестов
  evaluateRule,
  renderTemplate,
  resolveRouting,
  splitVisitDatetime,
  // переиспользуются «Отделом заботы»
  getServiceCategoryMap,
  lastIncomingChannel,
  _lastIncomingChannel: lastIncomingChannel,
};
