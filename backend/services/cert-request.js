// backend/services/cert-request.js
'use strict';

const crypto = require('crypto');

// Телефон → только цифры (нормализация для хранения и сравнения).
function normalizePhone(raw) {
  return (raw == null ? '' : String(raw)).replace(/\D/g, '');
}

// Контрольные цифры ИНН: 10 знаков (юрлицо) или 12 (физлицо).
function validateInn(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!/^\d{10}$/.test(s) && !/^\d{12}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const csum = (coeffs) => coeffs.reduce((a, c, i) => a + c * d[i], 0) % 11 % 10;
  if (s.length === 10) {
    return csum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  }
  const n11 = csum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  const n12 = csum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return n11 === d[10] && n12 === d[11];
}

// In-memory rate-limit по ключу (IP). now() инъектируется для тестов.
// Истёкшие записи периодически вычищаются, чтобы Map не рос неограниченно
// от разовых IP на долгоживущем сервере.
function makeRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key -> { count, resetAt }
  function prune(t) {
    for (const [k, rec] of hits) if (t >= rec.resetAt) hits.delete(k);
  }
  return function allow(key) {
    const t = now();
    if (hits.size > 1000) prune(t); // дешёвая защита от роста, только при разрастании
    const rec = hits.get(key);
    if (!rec || t >= rec.resetAt) { hits.set(key, { count: 1, resetAt: t + windowMs }); return true; }
    if (rec.count >= max) return false;
    rec.count += 1;
    return true;
  };
}

// In-memory короткоживущие токены (для скачивания «Заявления»).
function makeTokenStore({ ttlMs, now = () => Date.now() }) {
  const m = new Map(); // token -> { value, expiresAt }
  return {
    put(value) {
      const token = crypto.randomBytes(24).toString('hex');
      m.set(token, { value, expiresAt: now() + ttlMs });
      return token;
    },
    // Возвращает значение, пока токен жив. Намеренно МНОГОРАЗОВЫЙ в пределах TTL
    // (клиент может скачать «Заявление» несколько раз за 30 минут).
    get(token) {
      const rec = m.get(token);
      if (!rec) return null;
      if (now() >= rec.expiresAt) { m.delete(token); return null; }
      return rec.value;
    },
  };
}

module.exports = { normalizePhone, validateInn, makeRateLimiter, makeTokenStore };
