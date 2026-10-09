'use strict';
// TelegramClient без TDLib: фейковый клиент записывает invoke() и даёт
// эмитить апдейты руками. Проверяем автомат авторизации, фильтры входящих,
// связку «отправка → delivery → эхо с delivery_id», резолв получателя.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { TelegramClient, MAX_MESSAGE_AGE_S } = require('../lib/telegram-client');

function fakeClient(responses = {}) {
  const handlers = {};
  const calls = [];
  return {
    calls,
    on(ev, fn) { handlers[ev] = fn; },
    async emit(u) { await handlers.update(u); },
    async invoke(req) {
      calls.push(req);
      const r = responses[req._];
      if (typeof r === 'function') return r(req);
      if (r instanceof Error) throw r;
      return r === undefined ? {} : r;
    },
    async close() { calls.push({ _: 'close' }); },
  };
}

function setup(responses = {}, overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
  const client = fakeClient(responses);
  const repoCalls = []; const delCalls = []; const hooks = [];
  const deps = {
    createClient: () => client,
    config: { TG_API_ID: 1, TG_API_HASH: 'h', DATA_DIR: tmp, PUBLIC_FILES_DIR: path.join(tmp, 'pub'), PUBLIC_FILES_URL: '/uploads/gateway', TDLIB_VERBOSITY: 0 },
    repo: {
      setAuth: async (...a) => { repoCalls.push(['setAuth', ...a]); },
      contactUserId: async () => null,
      rememberContact: async (...a) => { repoCalls.push(['rememberContact', ...a]); },
    },
    deliveries: {
      STATUS: { ACCEPTED: [1, 'Принято'], SENT: [2, 'Отправлено'], FAILED: [5, 'Невозможно доставить'] },
      create: async (row) => { delCalls.push(['create', row]); return 12; },
      setStatus: async (...a) => { delCalls.push(['setStatus', ...a]); },
      failStale: async () => 0,
    },
    webhook: { sendSafe: async (body) => { hooks.push(body); } },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  const tg = new TelegramClient({ id: 42, phone: null }, deps);
  return { tg, client, repoCalls, delCalls, hooks, tmp };
}

const ready = { _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateReady' } };
const ME = { _: 'user', id: 1000, phone_number: '79250177778', first_name: 'Клиника', last_name: '' };

test('start: каталоги созданы, клиент создан с api_id/hash, auth_state=starting', async () => {
  const { tg, repoCalls, tmp } = setup();
  await tg.start();
  assert.ok(fs.existsSync(path.join(tmp, 'acc-42', 'db')));
  assert.deepEqual(repoCalls[0], ['setAuth', 42, 'starting']);
  assert.equal(tg.authState, 'starting');
});

test('автомат авторизации: wait_phone → шаг phone → wait_code; ошибка кода → в auth_error', async () => {
  const { tg, client, repoCalls } = setup({
    setAuthenticationPhoneNumber: async () => { setTimeout(() => client.emit({ _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateWaitCode' } }), 10); return {}; },
    checkAuthenticationCode: new Error('PHONE_CODE_INVALID'),
  });
  await tg.start();
  await client.emit({ _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateWaitPhoneNumber' } });
  assert.equal(tg.authState, 'wait_phone');
  assert.deepEqual(repoCalls.at(-1), ['setAuth', 42, 'wait_phone']);

  const r1 = await tg.authStep({ phone: '79001112233' });
  assert.equal(client.calls.find(c => c._ === 'setAuthenticationPhoneNumber').phone_number, '+79001112233');
  assert.deepEqual(r1, { authState: 'wait_code', error: null });

  const r2 = await tg.authStep({ code: '12345' });
  assert.equal(r2.authState, 'wait_code');
  assert.match(r2.error, /PHONE_CODE_INVALID/);
  assert.deepEqual(repoCalls.at(-1), ['setAuth', 42, 'wait_code', { error: 'PHONE_CODE_INVALID' }]);
  assert.equal(tg.status().error, 'PHONE_CODE_INVALID');

  assert.deepEqual(await tg.authStep({}), { authState: 'wait_code', error: 'пустой шаг' });
});

test('ready: getMe → свой номер и имя в БД, зависшие доставки закрыты', async () => {
  let stale = 0;
  const { tg, client, repoCalls } = setup({ getMe: ME }, {
    deliveries: { STATUS: {}, failStale: async (id) => { stale = id; return 2; } },
  });
  await tg.start();
  await client.emit(ready);
  assert.equal(tg.authState, 'ready');
  assert.equal(tg.ownPhone, '79250177778');
  assert.deepEqual(repoCalls.at(-1), ['setAuth', 42, 'ready', { error: null, phone: '79250177778', displayName: 'Клиника' }]);
  assert.equal(stale, 42);
  assert.deepEqual(tg.status(), { authState: 'ready', phone: '79250177778', displayName: 'Клиника', error: null });
});

test('входящее: до ready — игнор; sending_state — игнор; старше 6 ч — игнор; обычное → вебхук', async () => {
  const { tg, client, hooks } = setup({
    getMe: ME,
    getChat: { id: 5245186003, type: { _: 'chatTypePrivate', user_id: 5245186003 } },
    getUser: { id: 5245186003, phone_number: '', first_name: 'Дарья' },
  });
  await tg.start();
  const msg = (extra) => ({ _: 'updateNewMessage', message: { id: 7, chat_id: 5245186003, is_outgoing: false, date: 1_700_000_000, content: { _: 'messageText', text: { text: 'hi' } }, ...extra } });
  await client.emit(msg());
  assert.equal(hooks.length, 0, 'до ready не шлём');
  await client.emit(ready);
  await client.emit(msg({ sending_state: { _: 'messageSendingStatePending' } }));
  assert.equal(hooks.length, 0, 'своя отправка в пути — эхо позже');
  await client.emit(msg({ date: 1_700_000_000 - MAX_MESSAGE_AGE_S - 1 }));
  assert.equal(hooks.length, 0, 'старое сообщение не форвардим');
  await client.emit(msg());
  assert.equal(hooks.length, 1);
  const p = hooks[0].payload;
  assert.equal(p.direction, 'incoming'); assert.equal(p.customer_id, 42);
  assert.equal(p.sender_phone_number, null); assert.equal(p.recipient_phone_number, '79250177778');
  assert.equal(p.message.id, '5245186003:7'); assert.equal(p.delivery_id, null);
});

test('sendText по tdlib_user_id: createPrivateChat, delivery, reply только в том же чате; эхо из SendSucceeded с g12', async () => {
  const { tg, client, delCalls, hooks } = setup({
    getMe: ME,
    createPrivateChat: { id: 777 },
    sendMessage: { id: 99001, chat_id: 777 },
    getChat: { id: 777, type: { _: 'chatTypePrivate', user_id: 777 } },
    getUser: { id: 777, phone_number: '79001112233', first_name: 'Иван' },
  });
  await tg.start();
  await assert.rejects(tg.sendText({ text: 'x', tdlibUserId: '777' }), /не авторизован/);
  await client.emit(ready);

  const id = await tg.sendText({ text: 'Здравствуйте', tdlibUserId: '777', replyToMessageId: '777:5' });
  assert.equal(id, 12);
  const send = client.calls.find(c => c._ === 'sendMessage');
  assert.equal(send.chat_id, 777);
  assert.deepEqual(send.reply_to, { _: 'inputMessageReplyToMessage', message_id: 5 });
  assert.equal(send.input_message_content.text.text, 'Здравствуйте');
  assert.deepEqual(delCalls[0], ['create', { accountId: 42, chatId: 777, phone: null, kind: 'text', text: 'Здравствуйте' }]);
  assert.equal(tg.pendingSends.get(99001), 12);

  // reply из другого чата / Chatpush-эпохи — без reply_to
  await tg.sendText({ text: 'ещё', tdlibUserId: '777', replyToMessageId: '398818547' });
  assert.equal(client.calls.filter(c => c._ === 'sendMessage')[1].reply_to, undefined);

  await client.emit({ _: 'updateMessageSendSucceeded', old_message_id: 99001, message: { id: 1048576, chat_id: 777, is_outgoing: true, date: 1_700_000_000, content: { _: 'messageText', text: { text: 'Здравствуйте' } } } });
  assert.deepEqual(delCalls.find(c => c[0] === 'setStatus'), ['setStatus', 12, [2, 'Отправлено'], { tdlibMessageId: 1048576 }]);
  assert.equal(tg.pendingSends.has(99001), false);
  const echo = hooks.at(-1).payload;
  assert.equal(echo.direction, 'outgoing'); assert.equal(echo.delivery_id, 'g12');
  assert.equal(echo.recipient_phone_number, '79001112233'); assert.equal(echo.message.id, '777:1048576');
});

test('sendText: ошибка TDLib → delivery FAILED и 422; SendFailed → FAILED с текстом ошибки', async () => {
  const { tg, client, delCalls } = setup({
    getMe: ME, createPrivateChat: { id: 777 },
    sendMessage: (() => { let n = 0; return async () => { n++; if (n === 1) throw new Error('CHAT_WRITE_FORBIDDEN'); return { id: 5, chat_id: 777 }; }; })(),
  });
  await tg.start(); await client.emit(ready);
  await assert.rejects(tg.sendText({ text: 'x', tdlibUserId: '777' }), (e) => e.status === 422 && /CHAT_WRITE_FORBIDDEN/.test(e.message));
  assert.deepEqual(delCalls.at(-1), ['setStatus', 12, [5, 'Невозможно доставить'], { error: 'CHAT_WRITE_FORBIDDEN' }]);
  await tg.sendText({ text: 'y', tdlibUserId: '777' });
  await client.emit({ _: 'updateMessageSendFailed', old_message_id: 5, error: { code: 400, message: 'USER_IS_BLOCKED' } });
  assert.deepEqual(delCalls.at(-1), ['setStatus', 12, [5, 'Невозможно доставить'], { error: '400 USER_IS_BLOCKED' }]);
});

test('resolveChatId по номеру: кэш → поиск → importContacts → 422; группа по отрицательному id', async () => {
  const { tg, client, repoCalls } = setup({
    getMe: ME,
    searchUserByPhoneNumber: new Error('USER_NOT_FOUND'),
    importContacts: (req) => ({ user_ids: [req.contacts[0].phone_number === '+79001112233' ? 555 : 0] }),
    createPrivateChat: (req) => ({ id: req.user_id }),
  }, { repo: { setAuth: async () => {}, contactUserId: async (acc, p) => (p === '79990001122' ? 333 : null), rememberContact: async (...a) => { repoCallsPush(a); } } });
  function repoCallsPush(a) { repoCalls.push(['rememberContact', ...a]); }
  await tg.start(); await client.emit(ready);

  assert.equal(await tg.resolveChatId({ phone: '+7 999 000-11-22' }), 333);   // из кэша, без поиска
  assert.equal(client.calls.some(c => c._ === 'searchUserByPhoneNumber'), false);

  assert.equal(await tg.resolveChatId({ phone: '89001112233' }), 555);        // поиск упал → importContacts
  const imp = client.calls.find(c => c._ === 'importContacts');
  assert.deepEqual(imp.contacts, [{ _: 'importedContact', phone_number: '+79001112233', first_name: 'Клиент', last_name: '' }]);
  assert.deepEqual(repoCalls.at(-1), ['rememberContact', 42, '79001112233', 555]);

  await assert.rejects(tg.resolveChatId({ phone: '79000000000' }), (e) => e.status === 422 && /не найден в Telegram/.test(e.message));
  await assert.rejects(tg.resolveChatId({}), /нет получателя/);
  assert.equal(await tg.resolveChatId({ tdlibUserId: '-100555' }), -100555);
});

test('sendFile: фото → inputMessagePhoto, документ → inputMessageDocument, delivery kind=file', async () => {
  const { tg, client, delCalls } = setup({ getMe: ME, createPrivateChat: { id: 777 }, sendMessage: { id: 1, chat_id: 777 } });
  await tg.start(); await client.emit(ready);
  await tg.sendFile({ filePath: '/tmp/a.jpg', fileName: 'a.jpg', caption: 'прайс', type: 'image', tdlibUserId: '777' });
  await tg.sendFile({ filePath: '/tmp/b.pdf', fileName: 'b.pdf', caption: '', type: 'document', tdlibUserId: '777' });
  const sends = client.calls.filter(c => c._ === 'sendMessage');
  assert.equal(sends[0].input_message_content._, 'inputMessagePhoto');
  assert.deepEqual(sends[0].input_message_content.photo, { _: 'inputPhoto', photo: { _: 'inputFileLocal', path: '/tmp/a.jpg' } });
  assert.equal(sends[0].input_message_content.caption.text, 'прайс');
  assert.equal(sends[1].input_message_content._, 'inputMessageDocument');
  assert.deepEqual(sends[1].input_message_content.document, { _: 'inputDocument', document: { _: 'inputFileLocal', path: '/tmp/b.pdf' } });
  assert.equal(delCalls[0][1].kind, 'file'); assert.equal(delCalls[1][1].text, 'b.pdf');
});

test('logout: logOut + close, каталог данных удалён, auth_state=logged_out', async () => {
  const { tg, client, repoCalls, tmp } = setup();
  await tg.start();
  assert.ok(fs.existsSync(path.join(tmp, 'acc-42')));
  await tg.logout();
  assert.ok(client.calls.some(c => c._ === 'logOut'));
  assert.ok(client.calls.some(c => c._ === 'close'));
  assert.equal(fs.existsSync(path.join(tmp, 'acc-42')), false);
  assert.deepEqual(repoCalls.at(-1), ['setAuth', 42, 'logged_out']);
  assert.equal(tg.closed, true);
});
