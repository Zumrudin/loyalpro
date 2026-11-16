'use strict';

function safeErrorCode(error) {
  const code = String(error?.code || '');
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : 'error';
}

module.exports = { safeErrorCode };
