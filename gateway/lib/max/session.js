'use strict';
// Сессия веб-клиента MAX — один JSON в data/acc-<id>/max/session.json:
// {deviceId, loginToken, ownerId, phone, displayName}. deviceId создаётся один
// раз и живёт с токеном (токен привязан к нему — PyMax/max-account-api).
// Запись атомарная (tmp + rename): шлюз может упасть посреди записи при рестарте.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'session.json';

function load(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    if (j && typeof j === 'object' && typeof j.deviceId === 'string' && j.deviceId) return j;
  } catch (_) { /* нет файла или битый — свежая сессия */ }
  return { deviceId: crypto.randomUUID() };
}

function save(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path.join(dir, FILE));
}

function remove(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function hasToken(dir) { return !!load(dir).loginToken; }

module.exports = { load, save, remove, hasToken, FILE };
