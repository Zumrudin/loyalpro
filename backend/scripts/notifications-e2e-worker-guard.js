'use strict';

const { execFileSync } = require('child_process');

// E2E writes fixtures and may create YClients records. An unreadable process list
// is not evidence that the competing webhook worker has stopped.
function assertWorkerStopped(name) {
  let list;
  try {
    list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 10000 }));
  } catch (_) {
    throw new Error('ОТКАЗ: не удалось проверить PM2; E2E не запущен.');
  }
  if (!Array.isArray(list)) throw new Error('ОТКАЗ: некорректный список процессов PM2.');
  const matches = list.filter((p) => p && p.name === name);
  if (!matches.length || matches.some((p) => !['stopped', 'errored'].includes(p.pm2_env && p.pm2_env.status))) {
    throw new Error(`ОТКАЗ: остановка PM2-процесса «${name}» не подтверждена. E2E не запущен.`);
  }
}

module.exports = { assertWorkerStopped };
