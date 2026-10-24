'use strict';
// HTTP-клиент F.Doc OpenAPI 1.2 (спека https://demo.fdoc.ru/spec/). Три вида учётных данных:
//   • Basic логин:пароль ПРИЛОЖЕНИЯ — verifyApiKey, тариф, подписка на вебхуки;
//   • ключ организации apiKey — в параметрах/теле этих же вызовов и при входе сотрудника;
//   • bearer-токен СОТРУДНИКА (accessToken живёт 3 минуты) — всё остальное.
// Токены — только в памяти процесса (рестарт = новый вход паролем), ключ corpId:userId.
// Одновременные запросы одного сотрудника делят один вход (single-flight): refreshToken
// ротируется при каждом входе, параллельные обновления испортили бы друг друга.
// В текст ошибки не попадают параметры запроса (там apiKey) — только метод и путь.
const axios = require('axios');

const TIMEOUT_MS = 30000;
const SEND_TIMEOUT_MS = 120000;        // комплект до 50 МБ в base64
const PDF_TIMEOUT_MS = 60000;
const TOKEN_MARGIN_MS = 20000;         // токен, которому жить меньше 20 с, не используем
const DEFAULT_ACCESS_MS = 3 * 60 * 1000;
const P = {
  verify: '/paperless-gateway/api/v1/verifyApiKey',
  token: '/paperless-gateway/api/v1/operator/accessToken',
  send: '/paperless-gateway/api/v1/document/withSigners',
  workflow: '/paperless-gateway/portal/api/v1/documents/workflow/signing/status',
  employeeUrl: '/paperless-gateway/api/v1/document',
  permalink: '/paperless-gateway/portal/api/v1/permalink/send',
  decline: '/paperless-gateway/api/v1/employee/decline/package',
  pdf: '/paperless-gateway/portal/api/v1/document',
  recognize: '/additional-opengate/api/v1/docs/by/client/recognize',
  tariff: '/paperless-gateway/api/v1/corp/tariff/active/info',
  webhooks: '/paperless-gateway/api/v1/corp/webhooks',
};

class FdocError extends Error {
  constructor(message, { status = null, code = 'fdoc_error' } = {}) {
    super(message); this.name = 'FdocError'; this.status = status; this.code = code;
  }
}

/** Срок жизни JWT (мс): exp числом (секунды) или строкой ISO, как в примере спеки F.Doc. */
function jwtExpMs(token) {
  try {
    const part = String(token).split('.')[1];
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof json.exp === 'number') return json.exp * 1000;
    const t = Date.parse(json.exp);
    return Number.isFinite(t) ? t : null;
  } catch (e) { return null; }
}

function errorText(data) {
  if (data === null || data === undefined) return '';
  let d = data;
  if (Buffer.isBuffer(d) || d instanceof ArrayBuffer) d = Buffer.from(d).toString('utf8');
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { return d.replace(/\s+/g, ' ').trim().slice(0, 300); }
  }
  // Тело ошибки — чужие данные: «null» (JSON.parse('null') === null), message-объект без toString и т.п.
  // не должны подменять настоящую ошибку своим TypeError.
  try {
    return String(d.message || d.error || d.details || JSON.stringify(d)).replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch (e) { return ''; }
}

function toFdocError(e, conf) {
  const status = e && e.response ? e.response.status : null;
  const path = String(conf.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const text = e && e.response ? (errorText(e.response.data) || 'тело ответа пустое или не разобрано') : ((e && (e.code || e.message)) || 'network error');
  const code = status === 401 ? 'fdoc_unauthorized'
    : status === 403 ? 'fdoc_forbidden'
      : status === 404 ? 'fdoc_not_found'
        : status && status < 500 ? 'fdoc_rejected'
          : status ? 'fdoc_server' : 'fdoc_network';
  return new FdocError(`F.Doc ${String(conf.method || 'get').toUpperCase()} ${path} ${status || 'network'}: ${text}`, { status, code });
}

// 429 при входе — лимит запросов F.Doc, а не ответ «данные неверны»: вызывающий код считает неверные пароли
// и после трёх запирает учётку сотрудника, поэтому лимит под видом неверного пароля запер бы её зря.
const rateLimited = () => new FdocError('F.Doc ограничил частоту запросов — повторите через минуту', { status: 429, code: 'fdoc_rate_limited' });

function makeClient({ http = axios, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const tokens = new Map();     // corpId:userId → { access, accessExp, refresh, refreshExp }
  const inflight = new Map();   // corpId:userId → Promise<access>
  const gens = new Map();       // corpId:userId → поколение: forget поднимает его, вход, начатый раньше, токен не кэширует

  // retries — только для идемпотентных чтений: повтор при сетевой ошибке или 5xx.
  async function request(conf, { retries = 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await http.request({ timeout: TIMEOUT_MS, ...conf });
        return res.data;
      } catch (e) {
        const st = e && e.response ? e.response.status : null;
        if ((st !== null && st < 500) || attempt >= retries) throw toFdocError(e, conf);
        await sleep(1000);
      }
    }
  }
  const at = (s, path) => `${s.baseUrl}${path}`;
  const basic = (s) => ({ username: s.appLogin, password: s.appPassword });
  const key = (s, cred) => `${s.corpId}:${cred.userId}`;

  async function login(s, grant, grantType) {
    const data = await request({ method: 'post', url: at(s, P.token), data: { apiKey: s.apiKey, grant, grantType, app: s.appCode, corpId: s.corpId } });
    if (!data || !data.accessToken) throw new FdocError('F.Doc: в ответе на вход сотрудника нет accessToken', { code: 'fdoc_bad_response' });
    const t = now();
    const refresh = (data.refreshToken && data.refreshToken.value) || null;
    const refreshExp = refresh ? (Date.parse(data.refreshToken.exp) || t + 60 * 60 * 1000) : 0;
    // exp из JWT принимаем, только если он в будущем (часы F.Doc могут расходиться с нашими),
    // и не дальше 3 минут: протухший раньше токен поймает повтор по 401 в authed().
    const jwtExp = jwtExpMs(data.accessToken);
    const accessExp = jwtExp && jwtExp > t + TOKEN_MARGIN_MS ? Math.min(jwtExp, t + DEFAULT_ACCESS_MS) : t + DEFAULT_ACCESS_MS;
    return { access: data.accessToken, accessExp, refresh, refreshExp };
  }
  async function passwordLogin(s, cred) {
    try {
      return await login(s, Buffer.from(`${cred.login}:${cred.password}`).toString('base64'), 'password');
    } catch (e) {
      if (e.status === 429) throw rateLimited();
      if (e.status && e.status < 500) {
        throw new FdocError(`F.Doc не принял логин или пароль сотрудника: ${e.message}`, { status: 401, code: 'fdoc_credentials_invalid' });
      }
      throw e;
    }
  }
  async function freshToken(s, cred) {
    const k = key(s, cred);
    const gen = gens.get(k) || 0;   // forget во время входа поднимет поколение — тогда токен этого входа не кэшируем
    const cur = tokens.get(k);
    let t = null;
    if (cur && cur.refresh && cur.refreshExp - TOKEN_MARGIN_MS > now()) {
      try { t = await login(s, cur.refresh, 'refreshToken'); } catch (e) {
        if (e.status === 429) throw rateLimited();   // лимит не обходим входом паролем: это ещё один запрос в тот же лимит
        if (!e.status || e.status >= 500) throw e;
      }
    }
    if (!t) t = await passwordLogin(s, cred);
    if ((gens.get(k) || 0) === gen) tokens.set(k, t);
    return t.access;
  }
  async function token(s, cred, force = false) {
    const k = key(s, cred);
    const cur = tokens.get(k);
    if (!force && cur && cur.accessExp - TOKEN_MARGIN_MS > now()) return cur.access;
    if (inflight.has(k)) return inflight.get(k);
    // forget мог уже заменить этот вход новым — чужую запись в inflight не трогаем.
    const p = freshToken(s, cred).finally(() => { if (inflight.get(k) === p) inflight.delete(k); });
    inflight.set(k, p);
    return p;
  }
  // Вызов под токеном сотрудника. 401 на рабочем вызове — токен отозван: один повтор с новым входом.
  async function authed(s, cred, conf, opts) {
    const run = async (force) => request({ ...conf, headers: { ...(conf.headers || {}), Authorization: `Bearer ${await token(s, cred, force)}` } }, opts);
    try { return await run(false); } catch (e) {
      if (e.status !== 401 || e.code === 'fdoc_credentials_invalid') throw e;
      const cur = tokens.get(key(s, cred));
      if (cur) tokens.set(key(s, cred), { ...cur, accessExp: 0 });
      return run(true);
    }
  }

  return {
    /** corpId организации по ключу API (Basic приложения). */
    async verifyApiKey(s) {
      const data = await request({ method: 'get', url: at(s, P.verify), params: { apiKey: s.apiKey }, auth: basic(s) });
      if (!data || !data.corpId) throw new FdocError('F.Doc: в ответе проверки ключа нет corpId', { code: 'fdoc_bad_response' });
      return String(data.corpId);
    },
    /** Проверка логина и пароля сотрудника: вход паролем мимо кэша, токен кэшируется. */
    async checkCredentials(s, cred) {
      const t = await passwordLogin(s, cred);
      tokens.set(key(s, cred), t);
      return true;
    },
    /** POST document/withSigners — повтор вслепую НЕ делаем: комплект мог быть принят. */
    async sendPackage(s, cred, body) {
      return authed(s, cred, { method: 'post', url: at(s, P.send), data: body, timeout: SEND_TIMEOUT_MS, maxBodyLength: Infinity, maxContentLength: Infinity });
    },
    /** Статусы комплектов по подписантам (до 10 id за запрос). */
    async workflowStatuses(s, cred, ids) {
      const data = await authed(s, cred, { method: 'post', url: at(s, P.workflow), data: { ids, idType: 'package', corpId: s.corpId, app: s.appCode } }, { retries: 2 });
      return { packages: (data && data.packages) || [], failures: (data && data.failures) || [] };
    },
    /** Ссылка на окно сотрудника по комплекту (живёт 30 минут). */
    async employeeUrl(s, cred, packageGuid) {
      const data = await authed(s, cred, { method: 'get', url: at(s, P.employeeUrl), params: { id: packageGuid, idType: 'package' } }, { retries: 2 });
      return (data && data.url) || null;
    },
    async sendPermalink(s, cred, packageGuid, clientIds) {
      await authed(s, cred, { method: 'post', url: at(s, P.permalink), data: { packageGuid, clientExternalIds: clientIds } });
    },
    async declinePackage(s, cred, packageGuid) {
      await authed(s, cred, { method: 'post', url: at(s, P.decline), data: { packageGuid, declineType: 'DECLINE' } });
    },
    /** PDF подписанного документа со штампом. */
    async downloadPdf(s, cred, packageGuid, documentGuid) {
      const data = await authed(s, cred, {
        method: 'get', url: at(s, P.pdf), params: { packageGuid, documentGuid, download: true }, responseType: 'arraybuffer', timeout: PDF_TIMEOUT_MS,
      }, { retries: 2 });
      const buf = Buffer.from(data || []);
      if (buf.slice(0, 4).toString('latin1') !== '%PDF') throw new FdocError('F.Doc вернул не PDF', { code: 'fdoc_bad_response' });
      return buf;
    },
    /** Распознавание паспорта по фото (base64 ≤ 6 МБ): первый результат или null. */
    async recognize(s, cred, base64, ext) {
      const data = await authed(s, cred, { method: 'post', url: at(s, P.recognize), data: { documentsPhoto: base64, fileExtension: ext } });
      return (data && Array.isArray(data.result) && data.result[0]) || null;
    },
    async tariffInfo(s) {
      const data = await request({ method: 'get', url: at(s, P.tariff), params: { apiKey: s.apiKey }, auth: basic(s) }, { retries: 1 });
      return Array.isArray(data) ? data : [];
    },
    async putWebhooks(s, hookUrl) {
      await request({ method: 'put', url: at(s, P.webhooks), auth: basic(s), data: {
        apiKey: s.apiKey, events: [{ url: hookUrl, code: 'SetStatus' }], channelTypeCode: 'API', sendIntermediateStatuses: true,
      } });
    },
    async getWebhooks(s) {
      return request({ method: 'get', url: at(s, P.webhooks), params: { apiKey: s.apiKey }, auth: basic(s) });
    },
    /** Забыть токены сотрудника (сменил пароль, отключился); идущий вход токен уже не закэширует. */
    forget(corpId, userId) {
      const k = `${corpId}:${userId}`;
      gens.set(k, (gens.get(k) || 0) + 1);
      tokens.delete(k);
      inflight.delete(k);   // следующий вызов войдёт заново, а не присоединится к старому входу
    },
  };
}

const client = makeClient();
module.exports = { makeClient, client, FdocError, jwtExpMs, PATHS: P };
