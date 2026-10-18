'use strict';
// Адрес Telegram Bot API — один источник: config.TELEGRAM_API_BASE (18.10.2026).
// ЗАЧЕМ: канал прод (РФ) → api.telegram.org теряет пакеты, поэтому прод шлёт через релей
// на деве (TELEGRAM_API_BASE=http://127.0.0.1:8095). Отправитель с зашитым адресом молча
// пошёл бы мимо релея — отсюда структурная проверка по исходникам.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SKIP_DIRS = new Set(['node_modules', 'uploads', 'data', 'logs', '.git']);
const ENV_KEYS = ['TELEGRAM_API_BASE', 'TELEGRAM_BOT_TOKEN', 'OPS_ALERT_TELEGRAM_TOKEN', 'OPS_ALERT_TELEGRAM_CHAT_ID', 'JWT_SECRET'];

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...sourceFiles(p)); }
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

describe('TELEGRAM_API_BASE', () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    jest.resetModules();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    jest.resetModules();
  });

  // .env стенда не должен влиять на тест: dotenv заглушён, обязательный JWT_SECRET — фиктивный.
  function isolatedEnv(env) {
    jest.doMock('dotenv', () => ({ config: () => ({}) }));
    process.env.JWT_SECRET = 'x'.repeat(40);
    Object.assign(process.env, env);
  }

  function loadWith(env) {
    isolatedEnv(env);
    const post = jest.fn(async () => ({ data: { ok: true, result: {} } }));
    jest.doMock('axios', () => ({ post }));
    jest.doMock('./db', () => ({ db: {}, botDb: {}, pool: {}, withTransaction: async () => {} }));
    jest.doMock('./logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
    return post;
  }

  test('хост api.telegram.org назван только в config.js', () => {
    const offenders = sourceFiles(ROOT)
      .filter(f => f !== path.join(ROOT, 'config.js'))
      .filter(f => fs.readFileSync(f, 'utf8').includes('api.telegram.org'))
      .map(f => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  test('без env — прямой https://api.telegram.org', () => {
    delete process.env.TELEGRAM_API_BASE;
    isolatedEnv({});
    expect(require('./config').TELEGRAM_API_BASE).toBe('https://api.telegram.org');
  });

  test('рассылка, OTP и алерт идут по TELEGRAM_API_BASE', async () => {
    const post = loadWith({
      TELEGRAM_API_BASE: 'http://127.0.0.1:8095/', // хвостовой «/» срезается
      TELEGRAM_BOT_TOKEN: 'BOT',
      OPS_ALERT_TELEGRAM_TOKEN: 'MILA',
      OPS_ALERT_TELEGRAM_CHAT_ID: '1',
    });
    await require('./services/broadcast')._sendOne(1, 'x');
    await require('./services/telegram-otp').sendMessage(1, 'x');
    expect(await require('./services/ops-alert').notify('k', 't')).toBe(true);
    expect(post.mock.calls.map(c => c[0])).toEqual([
      'http://127.0.0.1:8095/botBOT/sendMessage',
      'http://127.0.0.1:8095/botBOT/sendMessage',
      'http://127.0.0.1:8095/botMILA/sendMessage',
    ]);
  });
});
