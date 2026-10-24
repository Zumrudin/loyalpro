'use strict';
const { makeClient, FdocError, jwtExpMs, PATHS } = require('./services/fdoc/client');

const S = { baseUrl: 'https://demo.fdoc.ru', apiKey: 'KEY-SECRET', appLogin: 'app', appPassword: 'apppw', appCode: 'crm', corpId: 'C1' };
const CRED = { userId: 7, login: 'ivanova', password: 'pw' };
const jwt = (expSec) => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64')}.s`;
const httpErr = (status, data) => Object.assign(new Error('x'), { response: { status, data } });

function setup(handler) {
  let t = 1_000_000;
  const calls = [];
  const http = { request: jest.fn(async (conf) => { calls.push(conf); return handler(conf, calls.length); }) };
  const c = makeClient({ http, now: () => t, sleep: async () => {} });
  return { c, http, calls, tick: (ms) => { t += ms; } };
}
const tokenResponse = (n) => ({ data: { accessToken: jwt(1000 + 180), refreshToken: { value: `R${n}`, exp: new Date(1_000_000 + 3600_000).toISOString() } } });

describe('jwtExpMs', () => {
  test('exp числом и строкой ISO; мусор — null', () => {
    expect(jwtExpMs(jwt(1700000000))).toBe(1700000000000);
    expect(jwtExpMs(`h.${Buffer.from(JSON.stringify({ exp: '2021-09-30T14:07:53+07:00' })).toString('base64')}.s`)).toBe(Date.parse('2021-09-30T14:07:53+07:00'));
    expect(jwtExpMs('garbage')).toBeNull();
  });
});

describe('verifyApiKey и Basic-вызовы', () => {
  test('Basic приложения + apiKey в параметрах; corpId строкой', async () => {
    const { c, calls } = setup(() => ({ data: { corpId: 12345 } }));
    expect(await c.verifyApiKey(S)).toBe('12345');
    expect(calls[0]).toMatchObject({ method: 'get', url: 'https://demo.fdoc.ru' + PATHS.verify, params: { apiKey: 'KEY-SECRET' }, auth: { username: 'app', password: 'apppw' } });
  });
  test('текст ошибки — метод, путь, статус, сообщение F.Doc, но без ключа', async () => {
    const { c } = setup(() => { throw httpErr(401, { message: 'Неверный ключ' }); });
    await expect(c.verifyApiKey(S)).rejects.toMatchObject({ status: 401, code: 'fdoc_unauthorized' });
    try { await c.verifyApiKey(S); } catch (e) {
      expect(e.message).toBe('F.Doc GET /paperless-gateway/api/v1/verifyApiKey 401: Неверный ключ');
      expect(e.message).not.toContain('KEY-SECRET');
    }
  });
  test('putWebhooks: событие SetStatus, канал API, промежуточные статусы', async () => {
    const { c, calls } = setup(() => ({ data: {} }));
    await c.putWebhooks(S, 'https://h/fdoc/webhook/abc');
    expect(calls[0]).toMatchObject({ method: 'put', auth: { username: 'app' }, data: { apiKey: 'KEY-SECRET', events: [{ url: 'https://h/fdoc/webhook/abc', code: 'SetStatus' }], channelTypeCode: 'API', sendIntermediateStatuses: true } });
  });
});

describe('токен сотрудника', () => {
  test('вход паролем: grant = base64(login:password), app и corpId; токен переиспользуется', async () => {
    const { c, calls } = setup((conf) => (conf.url.endsWith(PATHS.token) ? tokenResponse(1) : { data: { packages: [], failures: [] } }));
    await c.workflowStatuses(S, CRED, ['p1']);
    await c.workflowStatuses(S, CRED, ['p2']);
    const logins = calls.filter((x) => x.url.endsWith(PATHS.token));
    expect(logins).toHaveLength(1);
    expect(logins[0].data).toEqual({ apiKey: 'KEY-SECRET', grant: Buffer.from('ivanova:pw').toString('base64'), grantType: 'password', app: 'crm', corpId: 'C1' });
    expect(calls[1].headers.Authorization).toBe(`Bearer ${jwt(1180)}`);
    expect(calls[1].data).toEqual({ ids: ['p1'], idType: 'package', corpId: 'C1', app: 'crm' });
  });
  test('протух accessToken — вход по refreshToken; refresh отвергнут — паролем', async () => {
    let n = 0;
    const { c, calls, tick } = setup((conf) => {
      if (!conf.url.endsWith(PATHS.token)) return { data: {} };
      n++;
      if (conf.data.grantType === 'refreshToken' && n === 3) throw httpErr(400, { message: 'refresh expired' });
      return tokenResponse(n);
    });
    await c.employeeUrl(S, CRED, 'p1');
    tick(200_000);
    await c.employeeUrl(S, CRED, 'p1');
    expect(calls.filter((x) => x.url.endsWith(PATHS.token)).map((x) => x.data.grantType)).toEqual(['password', 'refreshToken']);
    tick(200_000);
    await c.employeeUrl(S, CRED, 'p1');
    expect(calls.filter((x) => x.url.endsWith(PATHS.token)).map((x) => x.data.grantType)).toEqual(['password', 'refreshToken', 'refreshToken', 'password']);
  });
  test('неверный пароль — fdoc_credentials_invalid', async () => {
    const { c } = setup(() => { throw httpErr(401, { message: 'bad credentials' }); });
    await expect(c.checkCredentials(S, CRED)).rejects.toMatchObject({ code: 'fdoc_credentials_invalid', status: 401 });
  });
  test('два параллельных вызова делят один вход', async () => {
    const { c, calls } = setup(async (conf) => (conf.url.endsWith(PATHS.token) ? tokenResponse(1) : { data: { url: 'u' } }));
    await Promise.all([c.employeeUrl(S, CRED, 'a'), c.employeeUrl(S, CRED, 'b')]);
    expect(calls.filter((x) => x.url.endsWith(PATHS.token))).toHaveLength(1);
  });
  test('401 на рабочем вызове — новый вход и один повтор', async () => {
    let work = 0;
    const { c, calls } = setup((conf) => {
      if (conf.url.endsWith(PATHS.token)) return tokenResponse(calls.length);
      work++;
      if (work === 1) throw httpErr(401, { message: 'token revoked' });
      return { data: { url: 'ok' } };
    });
    expect(await c.employeeUrl(S, CRED, 'p')).toBe('ok');
    expect(work).toBe(2);
  });
});

describe('повторы и ответы', () => {
  test('чтение статусов повторяется на 5xx, отправка комплекта — нет', async () => {
    let wf = 0, send = 0;
    const { c } = setup((conf) => {
      if (conf.url.endsWith(PATHS.token)) return tokenResponse(1);
      if (conf.url.endsWith(PATHS.workflow)) { wf++; if (wf < 3) throw httpErr(502, 'Bad Gateway'); return { data: { packages: [{ id: 'p' }] } }; }
      send++; throw httpErr(503, 'down');
    });
    expect((await c.workflowStatuses(S, CRED, ['p'])).packages).toEqual([{ id: 'p' }]);
    expect(wf).toBe(3);
    await expect(c.sendPackage(S, CRED, {})).rejects.toMatchObject({ code: 'fdoc_server', status: 503 });
    expect(send).toBe(1);
  });
  test('сетевой сбой — fdoc_network', async () => {
    const { c } = setup(() => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); });
    await expect(c.verifyApiKey(S)).rejects.toMatchObject({ code: 'fdoc_network', status: null });
  });
  test('downloadPdf: Buffer с %PDF; иначе ошибка; тело ошибки из arraybuffer читается', async () => {
    let n = 0;
    const { c } = setup((conf) => {
      if (conf.url.endsWith(PATHS.token)) return tokenResponse(1);
      n++;
      if (n === 1) return { data: Buffer.from('%PDF-1.7 ...') };
      if (n === 2) return { data: Buffer.from('<html>') };
      throw httpErr(404, Buffer.from(JSON.stringify({ message: 'Документ не найден' })));
    });
    expect((await c.downloadPdf(S, CRED, 'p', 'd')).slice(0, 4).toString()).toBe('%PDF');
    await expect(c.downloadPdf(S, CRED, 'p', 'd')).rejects.toThrow(/не PDF/);
    await expect(c.downloadPdf(S, CRED, 'p', 'd')).rejects.toThrow(/404: Документ не найден/);
  });
  test('recognize: первый результат или null', async () => {
    const { c } = setup((conf) => (conf.url.endsWith(PATHS.token) ? tokenResponse(1) : { data: { result: [{ confidence: true }] } }));
    expect(await c.recognize(S, CRED, 'AAA', 'jpg')).toEqual({ confidence: true });
  });
  test('FdocError экспортируется', () => expect(new FdocError('x')).toBeInstanceOf(Error));
});
