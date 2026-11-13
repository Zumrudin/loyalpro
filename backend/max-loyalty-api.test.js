'use strict';
jest.mock('./config', () => ({ MAX_LOYALTY_BOT: {} }));
jest.mock('./services/yclients', () => ({ ycPost: jest.fn(), ycGet: jest.fn(), ycAccrueCard: jest.fn() }));
const express = require('express');
const { createRouter } = require('./routes/max-loyalty-webhook');
const { createApi, API_BASE } = require('./services/max-loyalty/api');
const { createYclients } = require('./services/max-loyalty/yclients');
const yc = require('./services/yclients');
const config = { enabled: true, salonId: 8, token: 'synthetic-token', webhookSecret: 'x'.repeat(32) };
const started = { update_type: 'bot_started', timestamp: 123, user: { user_id: 42 }, salon_id: 999, payload: 'salon=999' };

describe('MAX webhook', () => {
  let server, url, enqueue, cfg;
  beforeEach(async () => {
    cfg = { ...config };
    enqueue = jest.fn(async () => {});
    const app = express();
    app.use(express.json());
    app.use('/max-loyalty', createRouter({ config: cfg, enqueue }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${server.address().port}/max-loyalty/webhook`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = (url, secret, body = started) => fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(secret ? { 'X-Max-Bot-Api-Secret': secret } : {}),
  }, body: JSON.stringify(body) });
  test('disabled/incomplete configuration fails closed', async () => {
    cfg.enabled = false;
    expect((await post(url, config.webhookSecret)).status).toBe(503);
    cfg.enabled = true; cfg.salonId = 0;
    expect((await post(url, config.webhookSecret)).status).toBe(503);
    expect(enqueue).not.toHaveBeenCalled();
  });
  test('missing/wrong secret cannot enqueue', async () => {
    expect((await post(url)).status).toBe(403);
    expect((await post(url, 'wrong')).status).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });
  test('tenant only from configuration; ACK after persistence', async () => {
    expect((await post(url, config.webhookSecret)).status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(8, expect.objectContaining({ userId: '42' }));
    expect(enqueue.mock.calls[0][1]).not.toHaveProperty('salon_id');
    enqueue.mockRejectedValue(new Error('database offline'));
    expect((await post(url, config.webhookSecret)).status).toBe(503);
  });
  test('ignored group/unsupported events never stored', async () => {
    expect((await post(url, config.webhookSecret, { update_type: 'message_created', message: { recipient: { chat_type: 'chat' } } })).status).toBe(200);
    expect((await post(url, config.webhookSecret, { update_type: 'message_edited' })).status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('MAX API adapter', () => {
  test('documented URL, header auth, message keyboard, commands and subscription', async () => {
    const http = { request: jest.fn(async () => ({ data: { success: true } })) };
    const api = createApi(config.token, http);
    await api.send('42', { text: 'synthetic' });
    expect(http.request.mock.calls[0][0]).toMatchObject({ method: 'POST', url: `${API_BASE}/messages`,
      params: { user_id: '42' }, headers: { Authorization: config.token }, maxRedirects: 0 });
    await api.commands();
    expect(http.request.mock.calls[1][0].url).toBe(`${API_BASE}/me/commands`);
    await api.subscribe('https://example.invalid/max-loyalty/webhook', config.webhookSecret);
    expect(http.request.mock.calls[2][0].data.update_types).toEqual(['bot_started', 'bot_stopped', 'message_created']);
  });
  test('errors never leak upstream body, headers, URL or token; no automatic POST retries', async () => {
    const http = { request: jest.fn(async () => { throw { response: { status: 429, data: 'private-body' }, config: { headers: { Authorization: config.token } } }; }) };
    const err = await createApi(config.token, http).send('42', {}).catch(e => e);
    expect(err.message).toBe('MAX API request failed');
    expect(err.status).toBe(429);
    expect(err.response).toBeUndefined();
    expect(err.config).toBeUndefined();
    expect(http.request).toHaveBeenCalledTimes(1);
  });
});

describe('YClients adapter uses exact matches and strict responses', () => {
  const salon = { id: 8, yclients_company_id: '18', yclients_partner_token: 'test', yclients_user_token: 'test', yclients_card_type_id: 3 };
  beforeEach(() => jest.clearAllMocks());
  test('quick search ignores unrelated first result; ambiguous exact matches rejected', async () => {
    const crm = createYclients(salon);
    yc.ycPost.mockResolvedValue([{ id: 9, phone: '70000000002' }, { id: 7, phone: '+70000000001' }]);
    expect((await crm.search('70000000001')).id).toBe(7);
    expect(yc.ycPost).toHaveBeenCalledWith(salon, '/company/18/clients/search', expect.objectContaining({ fields: ['id', 'phone'] }));
    yc.ycPost.mockResolvedValue([{ id: 7, phone: '70000000001' }, { id: 8, phone: '70000000001' }]);
    await expect(crm.search('70000000001')).rejects.toThrow('Ambiguous');
    yc.ycPost.mockResolvedValue({});
    await expect(crm.search('70000000001')).rejects.toThrow('Invalid');
  });
  test('id-only search response fails closed instead of attempting duplicate client creation', async () => {
    const crm = createYclients(salon);
    yc.ycPost.mockResolvedValue([{ id: 7 }]);
    await expect(crm.search('70000000001')).rejects.toThrow('Incomplete YClients identity');
  });
  test('invalid card response is an error, not empty cards; card type is salon-specific', async () => {
    const crm = createYclients(salon);
    yc.ycGet.mockResolvedValue({});
    await expect(crm.cards('7')).rejects.toThrow('Invalid');
    yc.ycGet.mockResolvedValue([{ id: 2, title: 'samosale' }, { id: 3, title: 'clinic card' }]);
    expect(await crm.cardType()).toBe('3');
  });
});
