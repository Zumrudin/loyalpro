'use strict';
// node --test: файл подключается обычным <script>, поэтому грузим его в vm
// с пустыми window/document — проверяем только чистые помощники.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const ctx = { window: {}, document: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/messaging-accounts.js', 'utf8'), ctx);

test('msgAccStateLabel', () => {
  assert.equal(ctx.msgAccStateLabel({ provider: 'chatpush', status: 'active' }), 'Chatpush · активен');
  assert.equal(ctx.msgAccStateLabel({ provider: 'chatpush', status: 'disabled' }), 'Chatpush · отключён');
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'active', auth_state: 'ready', phone: '79250177778' }), 'Свой шлюз · подключён · +79250177778');
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'active', auth_state: 'wait_code' }), 'Свой шлюз · ждёт код');
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'active', auth_state: 'error', auth_error: 'PHONE_CODE_INVALID' }), 'Свой шлюз · ошибка · PHONE_CODE_INVALID');
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'disabled', auth_state: 'logged_out' }), 'Свой шлюз · отключён');
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'pending', auth_state: 'wait_code' }), 'Свой шлюз · подключается · ждёт код');
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'pending', auth_state: 'starting' }), 'Свой шлюз · подключается · запускается');
});

test('msgAccNextStep — какой ввод показывать по состоянию', () => {
  assert.equal(ctx.msgAccNextStep('wait_phone'), 'phone');
  assert.equal(ctx.msgAccNextStep('wait_code'), 'code');
  assert.equal(ctx.msgAccNextStep('wait_password'), 'password');
  assert.equal(ctx.msgAccNextStep('ready'), null);
  assert.equal(ctx.msgAccNextStep('logged_out'), null);
  assert.equal(ctx.msgAccNextStep('error'), null);
  assert.equal(ctx.msgAccNextStep('starting'), 'wait');
  assert.equal(ctx.msgAccNextStep(undefined), 'wait');
});

test('MSG_ACC_CHANNEL покрывает все каналы Chatpush', () => {
  assert.deepEqual(Object.keys(vm.runInContext('MSG_ACC_CHANNEL', ctx)).sort(), ['max', 'max_bot', 'notify', 'tdlib', 'telegram', 'whatsapp']);
});

test('msgAccNextStep: wait_qr → qr', () => {
  assert.equal(ctx.msgAccNextStep('wait_qr'), 'qr');
});
test('msgAccStateLabel: wait_qr и WhatsApp', () => {
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'pending', auth_state: 'wait_qr', channel: 'whatsapp' }), 'Свой шлюз · подключается · ждёт сканирования QR');
});
test('msgAccGatewayBusy: занят только свой канал', () => {
  const rows = [{ provider: 'gateway', channel: 'tdlib', status: 'active' }, { provider: 'chatpush', channel: 'whatsapp', status: 'active' }];
  assert.equal(ctx.msgAccGatewayBusy(rows, 'tdlib'), true);
  assert.equal(ctx.msgAccGatewayBusy(rows, 'whatsapp'), false);
});
test('msgAccQrSrc: только PNG data-URL', () => {
  assert.equal(ctx.msgAccQrSrc('data:image/png;base64,iVBOR+/=='), 'data:image/png;base64,iVBOR+/==');
  assert.equal(ctx.msgAccQrSrc(null), null);
  assert.equal(ctx.msgAccQrSrc('javascript:alert(1)'), null);
  assert.equal(ctx.msgAccQrSrc('data:image/svg+xml;base64,AAAA'), null);
  assert.equal(ctx.msgAccQrSrc('data:image/png;base64,AA" onerror="x'), null);
});

test('msgAccRestartPlan: без logout у WhatsApp, Telegram только pending', () => {
  assert.deepEqual({ ...ctx.msgAccRestartPlan('whatsapp', 'active') }, { show: true, logout: false });
  assert.deepEqual({ ...ctx.msgAccRestartPlan('whatsapp', 'pending') }, { show: true, logout: false });
  assert.deepEqual({ ...ctx.msgAccRestartPlan('tdlib', 'pending') }, { show: true, logout: true });
  assert.equal(ctx.msgAccRestartPlan('tdlib', 'active').show, false);
  assert.equal(ctx.msgAccRestartPlan('tdlib', null).show, false);
});

test('msgAccRestartPlan: MAX — как WhatsApp (повторный start без logout)', () => {
  assert.deepEqual({ ...ctx.msgAccRestartPlan('max', 'pending') }, { show: true, logout: false });
  assert.deepEqual({ ...ctx.msgAccRestartPlan('max', 'active') }, { show: true, logout: false });
});
test('msgAccGatewayPath / msgAccConnectLabel: канал → путь ручки и подпись', () => {
  assert.equal(ctx.msgAccGatewayPath('tdlib'), 'telegram');
  assert.equal(ctx.msgAccGatewayPath('whatsapp'), 'whatsapp');
  assert.equal(ctx.msgAccGatewayPath('max'), 'max');
  assert.equal(ctx.msgAccConnectLabel('max'), 'MAX');
  assert.equal(ctx.msgAccConnectLabel('tdlib'), 'Telegram');
});
test('msgAccQrHint: подсказка QR зависит от канала', () => {
  assert.match(ctx.msgAccQrHint('max'), /Устройства/);
  assert.match(ctx.msgAccQrHint('whatsapp'), /Связанные устройства/);
});
test('MSG_ACC_CONNECT_BUTTONS: три кнопки — tdlib, whatsapp, max', () => {
  // spread: массив из vm-realm имеет чужой Array.prototype, strict deepEqual его отверг бы
  assert.deepEqual([...vm.runInContext('MSG_ACC_CONNECT_BUTTONS', ctx)].map(b => b[1]), ['tdlib', 'whatsapp', 'max']);
});
