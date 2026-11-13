'use strict';
// Хук «не ронять основной путь»: сбой логируется (с троттлингом 60 с на метку) и глотается.
// note — что именно не случилось (по умолчанию — текст finance-ops; склад передаёт свой).
const { createLogger } = require('../logger');
const logger = createLogger('Safely');

const _warned = new Map();
async function safely(label, fn, note = 'не записано в finance_operations') {
  try { return await fn(); } catch (e) {
    try {
      const now = Date.now();
      if (!_warned.has(label) || now - _warned.get(label) > 60000) {
        _warned.set(label, now);
        logger.warn(`${label}: ${note} (${e && (e.code || e.name) || 'error'}: ${String(e && e.message || e).slice(0, 160)})`);
      }
    } catch (_) { /* логирование не должно менять путь денег */ }
    return null;
  }
}

module.exports = { safely };
