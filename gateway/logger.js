'use strict';
function ts() { return new Date().toISOString(); }
function createLogger(name) {
  const line = (lvl, msg) => `${ts()} [${lvl}] [${name}] ${msg}`;
  return {
    info:  (m) => console.log(line('INFO', m)),
    warn:  (m) => console.warn(line('WARN', m)),
    error: (m) => console.error(line('ERROR', m)),
    debug: (m) => { if (process.env.GATEWAY_DEBUG === 'true') console.log(line('DEBUG', m)); },
  };
}
module.exports = { createLogger };
