'use strict';
// Защита дева (спека 2026-10-25, решение 17): если задан EDOCS_TEST_PHONES, любые отправки
// пациентам из «Документов» — комплекты F.Doc, повторы ссылок, анкеты в мессенджер, ручные и
// автоматические — уходят только на эти номера. Дев получает реальные вебхуки клиники и держит
// боевые аккаунты мессенджеров. На проде переменная не задаётся — проверка пропускает всех.
const config = require('../../config');
const { normalizePhoneKey } = require('../agent-gate');
const { EdocsError } = require('./errors');

function list() { return Array.isArray(config.EDOCS_TEST_PHONES) ? config.EDOCS_TEST_PHONES : []; }
function isAllowed(phone) {
  const allowed = list();
  if (!allowed.length) return true;
  const key = normalizePhoneKey(String(phone || ''));
  return !!key && allowed.includes(key);
}
function assertAllowed(phone) {
  if (isAllowed(phone)) return;
  throw new EdocsError('test_phone_blocked', `Тестовый режим: отправка только на номера ${list().join(', ')} (EDOCS_TEST_PHONES)`, 409);
}

module.exports = { isAllowed, assertAllowed };
