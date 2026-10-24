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
// Ответ входа с различимым accessToken: по нему видно, чей именно токен лежит в кэше.
const taggedResponse = (tag) => ({ data: { accessToken: `h.${Buffer.from(JSON.stringify({ exp: 1000 + 180, tag })).toString('base64')}.s`, refreshToken: { value: `R-${tag}`, exp: new Date(1_000_000 + 3600_000).toISOString() } } });
const accessOf = (tag) => taggedResponse(tag).data.accessToken;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise((r) => setImmediate(r));

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
  // Три «неверных пароля» запирают учётку сотрудника, поэтому лимит запросов F.Doc нельзя выдавать за неверный пароль.
  test('429 при входе паролем — fdoc_rate_limited, а не неверный пароль', async () => {
    const { c } = setup(() => { throw httpErr(429, { message: 'Too Many Requests' }); });
    const limited = { code: 'fdoc_rate_limited', status: 429, message: 'F.Doc ограничил частоту запросов — повторите через минуту' };
    await expect(c.checkCredentials(S, CRED)).rejects.toMatchObject(limited);
    await expect(c.employeeUrl(S, CRED, 'p')).rejects.toMatchObject(limited);
  });
  test('429 на refreshToken — fdoc_rate_limited сразу, вход паролем не вызывался', async () => {
    const { c, calls, tick } = setup((conf) => {
      if (!conf.url.endsWith(PATHS.token)) return { data: {} };
      if (conf.data.grantType === 'refreshToken') throw httpErr(429, { message: 'Too Many Requests' });
      return tokenResponse(1);
    });
    await c.employeeUrl(S, CRED, 'p');     // вход паролем, refreshToken сохранён
    tick(200_000);                         // accessToken протух, refreshToken ещё жив
    await expect(c.employeeUrl(S, CRED, 'p')).rejects.toMatchObject({ code: 'fdoc_rate_limited', status: 429, message: 'F.Doc ограничил частоту запросов — повторите через минуту' });
    expect(calls.filter((x) => x.url.endsWith(PATHS.token)).map((x) => x.data.grantType)).toEqual(['password', 'refreshToken']);
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

describe('forget', () => {
  const CRED_NEW = { userId: 7, login: 'ivanova', password: 'new-pw' };   // тот же сотрудник, другая учётная запись
  // Входы стоят на затворах: тест сам решает, когда и в каком порядке они завершаются.
  // Рабочий вызов отвечает заголовком Authorization — по нему видно, под каким токеном он ушёл.
  function gated() {
    const gates = [];
    const ctx = setup((conf) => {
      if (!conf.url.endsWith(PATHS.token)) return { data: { url: conf.headers.Authorization } };
      const g = deferred();
      gates.push(g);
      return g.promise;
    });
    return { ...ctx, gates, logins: () => ctx.calls.filter((x) => x.url.endsWith(PATHS.token)) };
  }

  test('без входа в полёте: следующий вызов входит заново', async () => {
    const { c, calls } = setup((conf) => (conf.url.endsWith(PATHS.token) ? tokenResponse(1) : { data: { url: 'u' } }));
    await c.employeeUrl(S, CRED, 'a');
    c.forget('C1', 7);
    await c.employeeUrl(S, CRED, 'b');
    expect(calls.filter((x) => x.url.endsWith(PATHS.token))).toHaveLength(2);
  });
  test('во время входа: следующий вызов входит заново, токен старого входа не кэшируется', async () => {
    const { c, gates, logins } = gated();
    const p1 = c.employeeUrl(S, CRED, 'a');          // вход №1 старой учётной записью завис
    await flush();
    c.forget('C1', 7);
    const p2 = c.employeeUrl(S, CRED_NEW, 'b');      // после forget — свой вход, а не присоединение к зависшему
    await flush();
    expect(logins()).toHaveLength(2);
    expect(logins()[1].data.grant).toBe(Buffer.from('ivanova:new-pw').toString('base64'));
    gates[1].resolve(taggedResponse('NEW'));
    expect(await p2).toBe(`Bearer ${accessOf('NEW')}`);
    gates[0].resolve(taggedResponse('OLD'));         // старый вход заканчивается последним
    expect(await p1).toBe(`Bearer ${accessOf('OLD')}`);   // своему вызывающему токен достаётся как обычно
    expect(await c.employeeUrl(S, CRED_NEW, 'c')).toBe(`Bearer ${accessOf('NEW')}`);   // а в кэше — токен нового входа
    expect(logins()).toHaveLength(2);
  });
  test('во время входа: завершение старого входа не сбрасывает вход, начатый после forget', async () => {
    const { c, gates, logins } = gated();
    const p1 = c.employeeUrl(S, CRED, 'a');
    await flush();
    c.forget('C1', 7);
    const p2 = c.employeeUrl(S, CRED_NEW, 'b');
    await flush();
    gates[0].resolve(taggedResponse('OLD'));         // старый вход заканчивается, пока новый ещё идёт
    await p1;
    const p3 = c.employeeUrl(S, CRED_NEW, 'c');      // третий вызов присоединяется к новому входу
    await flush();
    expect(logins()).toHaveLength(2);
    gates[1].resolve(taggedResponse('NEW'));
    expect(await Promise.all([p2, p3])).toEqual([`Bearer ${accessOf('NEW')}`, `Bearer ${accessOf('NEW')}`]);
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
  // PDF качается arraybuffer'ом, поэтому «null» от F.Doc приходит байтами и JSON.parse даёт null; тело-объект без toString — тоже нечитаемое.
  test('downloadPdf: тело ошибки «null» или нечитаемое — FdocError со статусом ответа, а не TypeError', async () => {
    const bodies = [Buffer.from('null'), null, Buffer.from('{"message":{"toString":1}}')];
    for (const body of bodies) {
      const { c } = setup((conf) => { if (conf.url.endsWith(PATHS.token)) return tokenResponse(1); throw httpErr(404, body); });
      const err = await c.downloadPdf(S, CRED, 'p', 'd').catch((e) => e);
      expect(err).toBeInstanceOf(FdocError);
      expect(err).toMatchObject({ status: 404, code: 'fdoc_not_found' });
      expect(err.message).toBe('F.Doc GET /paperless-gateway/portal/api/v1/document 404: тело ответа пустое или не разобрано');
    }
  });
  test('recognize: первый результат или null', async () => {
    const { c } = setup((conf) => (conf.url.endsWith(PATHS.token) ? tokenResponse(1) : { data: { result: [{ confidence: true }] } }));
    expect(await c.recognize(S, CRED, 'AAA', 'jpg')).toEqual({ confidence: true });
  });
  test('FdocError экспортируется', () => expect(new FdocError('x')).toBeInstanceOf(Error));
});
