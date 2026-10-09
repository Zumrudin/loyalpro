'use strict';
// Аккаунт → живой TelegramClient. При старте процесса поднимаем все активные.
const fs = require('fs');
const repo = require('./accounts-repo');
const { TelegramClient } = require('./telegram-client');
const { createLogger } = require('../logger');
const logger = createLogger('Registry');

const clients = new Map();
const starting = new Map();   // id → промис запуска: параллельный start не создаёт второй TDLib на тот же каталог

async function doStart(id) {
  const account = await repo.get(id);
  if (!account) throw Object.assign(new Error('аккаунт не найден'), { status: 404 });
  const c = new TelegramClient(account);
  clients.set(id, c);
  try { await c.start(); }
  catch (e) { clients.delete(id); throw e; }
  return c;
}

function start(id) {
  id = Number(id);
  if (clients.has(id) && !starting.has(id)) return Promise.resolve(clients.get(id));
  if (starting.has(id)) return starting.get(id);
  const p = doStart(id).finally(() => starting.delete(id));
  starting.set(id, p);
  return p;
}

function get(id) { return clients.get(Number(id)) || null; }

function list() { return [...clients.values()].map(c => ({ id: c.id, authState: c.authState })); }

async function stop(id) {
  id = Number(id);
  const c = clients.get(id);
  if (!c) return;
  try { await c.close(); } finally { clients.delete(id); }
}

// Разлогин. Живой клиент — logOut+close+rm данных. Не запущенный, но с
// сохранённой сессией (каталог db есть) — поднимаем и разлогиниваем по-настоящему:
// простое удаление каталога оставило бы сессию живой на стороне Telegram.
// Сессии нет — только записать состояние.
async function logout(id) {
  id = Number(id);
  let c = clients.get(id);
  if (!c) {
    const config = require('../config');
    const dirs = TelegramClient.dirsFor(config, id);
    if (fs.existsSync(dirs.db)) {
      c = await start(id);
    } else {
      fs.rmSync(dirs.base, { recursive: true, force: true });
      await repo.setAuth(id, 'logged_out');
      return;
    }
  }
  try { await c.logout(); } finally { clients.delete(id); }
}

async function startAllActive() {
  const rows = await repo.listActive();
  for (const r of rows) {
    try { await start(r.id); logger.info(`аккаунт #${r.id} (${r.phone || 'без номера'}) запущен`); }
    catch (e) { logger.error(`аккаунт #${r.id} не запущен: ${e.message}`); }
  }
}

// Параллельно: kill_timeout pm2 ограничен, последовательное закрытие N клиентов
// TDLib могло бы не уложиться и закончиться SIGKILL посреди записи БД TDLib.
async function closeAll() {
  const results = await Promise.allSettled([...clients.keys()].map(id => stop(id)));
  for (const r of results) if (r.status === 'rejected') logger.warn(`закрытие клиента: ${r.reason && r.reason.message}`);
}

module.exports = { start, get, list, stop, logout, startAllActive, closeAll, _clients: clients };
