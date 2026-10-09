'use strict';
// ============================================================
// Transport — единая отправка в мессенджеры по салону и каналу.
// ------------------------------------------------------------
// Раньше 9 мест звали chatpush.sendMessage(config.CHATPUSH.instanceToken, …):
// один токен на весь процесс. Теперь аккаунт выбирается через
// messaging/accounts.credentialsFor(salonId, channel). dispatchRouting — это
// порядок фолбэка по каналам; соседние каналы ОДНОГО аккаунта уходят одним
// вызовом (Chatpush умеет фолбэк сам, прежнее поведение сохранено), каналы
// разных аккаунтов — отдельными вызовами по порядку, побеждает первый успешный.
// Канал без аккаунта (credentialsFor → null: выключен в админке или чужой
// салон) просто пропускается; ни одного аккаунта → ошибка с перечислением.
//
// AT-MOST-ONCE: к следующему аккаунту переходим ТОЛЬКО при однозначном отказе
// (4xx или наша собственная проверка). Таймаут, обрыв сети, 5xx бросаются
// сразу — сообщение могло уже встать в очередь, второй аккаунт дал бы дубль.
// Отказ каждой группы пишется в лог; наружу бросается ТОТ ЖЕ объект последней
// ошибки (вызывающие смотрят на его message/status) с transportErrors — списком
// отказов всех групп. Успех несёт accountId/channels: по accountId потом
// проверяется судьба доставки (getDeliveryStatus(..., { accountId })).
// ============================================================
const chatpush = require('../chatpush');
const accounts = require('./accounts');
const config = require('../../config');
const { createLogger } = require('../../logger');
const logger = createLogger('Transport');

function routingOf(payload) {
  const r = payload && payload.dispatchRouting;
  return Array.isArray(r) ? r : [r].filter(Boolean);
}

function accountKey(creds) {
  return `${creds.provider}|${String(creds.apiBase || '').replace(/\/+$/, '')}|${creds.token}`;
}

async function groupsFor(salonId, routing) {
  const groups = [];
  const skipped = [];
  for (const ch of routing) {
    const creds = await accounts.credentialsFor(salonId, ch);
    if (!creds) { skipped.push(ch); continue; }
    // Один и тот же АККАУНТ ПРОВАЙДЕРА, а не одна строка: сид Chatpush заводит
    // шесть строк (по каналу) с одним токеном — иначе ['telegram','whatsapp']
    // уходили бы двумя вызовами и фолбэк Chatpush между каналами терялся.
    const last = groups[groups.length - 1];
    if (last && accountKey(last.creds) === accountKey(creds)) last.channels.push(ch);
    else groups.push({ creds, channels: [ch] });
  }
  if (skipped.length) logger.debug(`salon ${salonId}: нет аккаунта для каналов [${skipped.join(',')}] — пропущены`);
  return groups;
}

function requireSalon(salonId) {
  if (salonId === undefined || salonId === null) throw new Error('transport: salonId обязателен');
}

// Переход к следующему аккаунту — ТОЛЬКО когда первый точно ничего не отправил:
// 4xx от API (apiError кладёт status) или наша собственная проверка (meta.status
// != success, «нет кредов» — обычный Error без status и без code). Таймаут,
// обрыв сети (axios: e.code) и 5xx — НЕОДНОЗНАЧНЫ: сообщение могло уже встать
// в очередь, и второй аккаунт дал бы пациенту дубль. Правило проекта —
// at-most-once (пропущенное сообщение дешевле дубля), поэтому такие ошибки
// бросаются сразу.
function isDefiniteRejection(e) {
  const st = e && Number(e.status);
  if (st >= 400 && st < 500) return true;
  return !!e && !e.status && !e.code;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

async function sendVia(salonId, payload, call) {
  requireSalon(salonId);
  const routing = routingOf(payload);
  if (!routing.length) throw new Error('transport: dispatchRouting пуст');
  const groups = await groupsFor(salonId, routing);
  if (!groups.length) throw new Error(`нет аккаунта мессенджера у салона ${salonId} для каналов [${routing.join(',')}]`);
  const errors = [];
  let lastErr = null;
  for (const g of groups) {
    try {
      const delivery = await call(g.creds, { ...payload, dispatchRouting: g.channels });
      return isPlainObject(delivery) ? { ...delivery, accountId: g.creds.id, channels: g.channels } : delivery;
    } catch (e) {
      const message = e && e.message;
      logger.warn(`salon ${salonId}: аккаунт #${g.creds.id} [${g.channels.join(',')}] отказал — ${message}`);
      errors.push({ accountId: g.creds.id, channels: g.channels, message, status: e && e.status });
      lastErr = e;
      if (!isDefiniteRejection(e)) {
        if (e && typeof e === 'object') e.transportErrors = errors;
        throw e;
      }
    }
  }
  if (lastErr && typeof lastErr === 'object') lastErr.transportErrors = errors;
  throw lastErr;
}

function sendMessage(salonId, payload) {
  return sendVia(salonId, payload, (creds, p) => chatpush.sendMessage(creds, p));
}

function sendFile(salonId, payload, buffer, mimeType) {
  return sendVia(salonId, payload, (creds, p) => chatpush.sendFile(creds, p, buffer, mimeType));
}

// telegram_bot в событиях = routing-канал telegram (как chatpush.replyRoutingFor).
// opts.accountId — аккаунт, которым сообщение ушло (из результата sendMessage):
// проверяем через него, даже если канал с тех пор переключили; строки нет →
// прежний поиск по каналу.
async function getDeliveryStatus(salonId, channel, deliveryId, opts = {}) {
  requireSalon(salonId);
  let creds = null;
  if (opts && opts.accountId !== undefined && opts.accountId !== null) {
    creds = await accounts.credentialsById(salonId, opts.accountId);
  }
  if (!creds) creds = await accounts.credentialsFor(salonId, chatpush.replyRoutingFor(channel));
  if (!creds) return null;
  return chatpush.getDeliveryStatus(creds, deliveryId);
}

// Гейт запуска воркеров (вместо проверки env-токена): нужен env-токен ИЛИ url
// шлюза. Салон, у которого аккаунты только в БД без одного из этих env, воркеры
// не запустит — осознанно, пока таких салонов нет.
function configured() {
  return !!((config.CHATPUSH && config.CHATPUSH.instanceToken) || (config.MESSAGING_GATEWAY && config.MESSAGING_GATEWAY.url));
}

module.exports = { sendMessage, sendFile, getDeliveryStatus, configured };
