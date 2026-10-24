'use strict';
const KEY = Buffer.alloc(32, 7).toString('base64');
jest.mock('./config', () => ({ EDOCS_ENC_KEY: Buffer.alloc(32, 7).toString('base64') }));
const { makeBox, box, isConfigured, SecretBoxError } = require('./utils/secret-box');

describe('secret-box', () => {
  const b = makeBox(KEY);

  test('шифрует и расшифровывает строку с кириллицей', () => {
    const enc = b.encrypt('Паспорт 4510 123456, кем выдан: ОВД «Тверской»');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('4510');
    expect(b.decrypt(enc)).toBe('Паспорт 4510 123456, кем выдан: ОВД «Тверской»');
  });

  test('одно и то же значение даёт разный шифротекст (случайный IV)', () => {
    expect(b.encrypt('x')).not.toBe(b.encrypt('x'));
  });

  test('JSON туда и обратно', () => {
    const o = { passport_series: '4510', passport_number: '123456' };
    expect(b.decryptJson(b.encryptJson(o))).toEqual(o);
  });

  test('подмена данных ловится проверкой тега', () => {
    const enc = b.encrypt('секрет');
    const parts = enc.split(':');
    const data = Buffer.from(parts[3], 'base64'); data[0] ^= 1; parts[3] = data.toString('base64');
    expect(() => b.decrypt(parts.join(':'))).toThrow(SecretBoxError);
    try { b.decrypt(parts.join(':')); } catch (e) { expect(e.code).toBe('bad_box'); }
  });

  test('чужой ключ не расшифровывает', () => {
    const other = makeBox(Buffer.alloc(32, 9).toString('base64'));
    expect(() => other.decrypt(b.encrypt('секрет'))).toThrow(/чужой ключ/);
  });

  test('битый формат — bad_box', () => {
    for (const bad of ['', 'v1:abc', 'v2:a:b:c', null, undefined]) {
      expect(() => b.decrypt(bad)).toThrow(SecretBoxError);
    }
  });

  test('нет ключа или ключ не 32 байта — no_key', () => {
    for (const k of ['', null, undefined, Buffer.alloc(16).toString('base64')]) {
      try { makeBox(k); throw new Error('не бросил'); } catch (e) { expect(e.code).toBe('no_key'); }
    }
  });

  test('box() берёт ключ из config, isConfigured() — true', () => {
    expect(isConfigured()).toBe(true);
    expect(box().decrypt(b.encrypt('из config'))).toBe('из config');
  });
});
