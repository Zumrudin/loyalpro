'use strict';
// Аккаунт → живой TelegramClient. При старте процесса поднимаем все активные.
const fs = require('fs');
const repo = require('./accounts-repo');
const { TelegramClient } = require('./telegram-client');
const { createLogger } = require('../logger');
const logger = createLogger('Registry');

const clients = new Map();

async function start(id) {
  id = Number(id);
  if (clients.has(id)) return clients.get(id);
  const account = await repo.get(id);
  if (!account) throw Object.assign(new Error('аккаунт не найден'), { status: 404 });
  const c = new TelegramClient(account);
  clients.set(id, c);
  try { await c.start(); }
  catch (e) { clients.delete(id); throw e; }
  return c;
}

function get(id) { return clients.get(Number(id)) || null; }

async function stop(id) {
  const c = clients.get(Number(id));
  if (!c) return;
  await c.close();
  clients.delete(Number(id));
}

// Разлогин: живой клиент — logOut+close+rm данных; мёртвый (не запущен) —
// только удалить каталог данных и записать состояние.
async function logout(id) {
  id = Number(id);
  const c = clients.get(id);
  if (c) { await c.logout(); clients.delete(id); return; }
  const tmp = new TelegramClient({ id, phone: null });
  fs.rmSync(tmp.dirs().base, { recursive: true, force: true });
  await repo.setAuth(id, 'logged_out');
}

async function startAllActive() {
  const rows = await repo.listActive();
  for (const r of rows) {
    try { await start(r.id); logger.info(`аккаунт #${r.id} (${r.phone || 'без номера'}) запущен`); }
    catch (e) { logger.error(`аккаунт #${r.id} не запущен: ${e.message}`); }
  }
}

async function closeAll() { for (const id of [...clients.keys()]) await stop(id); }

module.exports = { start, get, stop, logout, startAllActive, closeAll, _clients: clients };
