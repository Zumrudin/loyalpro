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
// ============================================================
const chatpush = require('../chatpush');
const accounts = require('./accounts');
const config = require('../../config');

function routingOf(payload) {
  const r = payload && payload.dispatchRouting;
  return Array.isArray(r) ? r : [r].filter(Boolean);
}

async function groupsFor(salonId, routing) {
  const groups = [];
  for (const ch of routing) {
    const creds = await accounts.credentialsFor(salonId, ch);
    if (!creds) continue;
    const last = groups[groups.length - 1];
    if (last && String(last.creds.id) === String(creds.id)) last.channels.push(ch);
    else groups.push({ creds, channels: [ch] });
  }
  return groups;
}

function requireSalon(salonId) {
  if (salonId === undefined || salonId === null) throw new Error('transport: salonId обязателен');
}

async function sendVia(salonId, payload, call) {
  requireSalon(salonId);
  const routing = routingOf(payload);
  const groups = await groupsFor(salonId, routing);
  if (!groups.length) throw new Error(`нет аккаунта мессенджера у салона ${salonId} для каналов [${routing.join(',')}]`);
  let lastErr = null;
  for (const g of groups) {
    try {
      return await call(g.creds, { ...payload, dispatchRouting: g.channels });
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function sendMessage(salonId, payload) {
  return sendVia(salonId, payload, (creds, p) => chatpush.sendMessage(creds, p));
}

function sendFile(salonId, payload, buffer, mimeType) {
  return sendVia(salonId, payload, (creds, p) => chatpush.sendFile(creds, p, buffer, mimeType));
}

// telegram_bot в событиях = routing-канал telegram (как chatpush.replyRoutingFor).
async function getDeliveryStatus(salonId, channel, deliveryId) {
  requireSalon(salonId);
  const creds = await accounts.credentialsFor(salonId, chatpush.replyRoutingFor(channel));
  if (!creds) return null;
  return chatpush.getDeliveryStatus(creds, deliveryId);
}

// Есть ли куда слать вообще (гейт запуска воркеров вместо проверки env-токена).
function configured() {
  return !!((config.CHATPUSH && config.CHATPUSH.instanceToken) || (config.MESSAGING_GATEWAY && config.MESSAGING_GATEWAY.url));
}

module.exports = { sendMessage, sendFile, getDeliveryStatus, configured };
