'use strict';
// Шифрование секретов модуля «Документы» (AES-256-GCM): паспортные данные
// пациентов, пароли F.Doc сотрудников, ключ API и пароль приложения F.Doc.
// Ключ — env EDOCS_ENC_KEY (32 байта в base64). Ключа нет — бросаем
// (fail-closed): открытым текстом эти данные не пишутся никогда.
// Формат: v1:<iv>:<tag>:<данные> (base64) — версия оставляет место для ротации ключа.
// ВНИМАНИЕ: потеря ключа = потеря всех зашифрованных данных; у дева и прода ключи разные.
const crypto = require('crypto');

const VERSION = 'v1';

class SecretBoxError extends Error {
  constructor(code, message) { super(message); this.name = 'SecretBoxError'; this.code = code; }
}

function parseKey(raw) {
  const s = String(raw || '').trim();
  const key = s ? Buffer.from(s, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new SecretBoxError('no_key', 'EDOCS_ENC_KEY не задан или не 32 байта в base64');
  return key;
}

function makeBox(rawKey) {
  const key = parseKey(rawKey);
  function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }
  function decrypt(box) {
    const parts = String(box || '').split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError('bad_box', 'Повреждённый шифротекст');
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
      d.setAuthTag(Buffer.from(parts[2], 'base64'));
      return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
    } catch (e) {
      throw new SecretBoxError('bad_box', 'Шифротекст не прошёл проверку: чужой ключ или подмена');
    }
  }
  return {
    encrypt,
    decrypt,
    encryptJson: (obj) => encrypt(JSON.stringify(obj)),
    decryptJson: (box) => JSON.parse(decrypt(box)),
  };
}

// Ключ читается из config лениво: модуль можно подключить и без ключа, а бросит
// он только при попытке зашифровать или расшифровать.
let cached = null;
function box() {
  if (!cached) cached = makeBox(require('../config').EDOCS_ENC_KEY);
  return cached;
}
function isConfigured() {
  try { parseKey(require('../config').EDOCS_ENC_KEY); return true; } catch { return false; }
}

module.exports = { makeBox, box, isConfigured, SecretBoxError };
