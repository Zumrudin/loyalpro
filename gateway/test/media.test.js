'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeExt, publicFileName, EXT_BY_MIME, MAX_MEDIA_BYTES } = require('../lib/media');
const tg = require('../lib/telegram-client');

test('safeExt: только белый список по MIME, неизвестное → .bin', () => {
  assert.equal(safeExt('image/jpeg'), '.jpg');
  assert.equal(safeExt('IMAGE/PNG; charset=x'), '.png');
  assert.equal(safeExt('text/html'), '.bin');
  assert.equal(safeExt(undefined), '.bin');
});
test('publicFileName: <ts>_<16hex><ext>', () => {
  assert.match(publicFileName('audio/ogg', 1700000000000), /^1700000000000_[0-9a-f]{16}\.ogg$/);
});
test('telegram-client реэкспортирует те же объекты', () => {
  assert.equal(tg.safeExt, safeExt);
  assert.equal(tg.EXT_BY_MIME, EXT_BY_MIME);
  assert.equal(tg.MAX_MEDIA_BYTES, MAX_MEDIA_BYTES);
});
