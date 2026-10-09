'use strict';
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
const axios = require('axios');
const chatpush = require('./services/chatpush');

beforeEach(() => jest.clearAllMocks());

test('sendMessage: строка-токен → apiBase из config, Bearer = строка', async () => {
  axios.post.mockResolvedValueOnce({ data: { meta: { status: 'success' }, delivery: { id: 1 } } });
  await chatpush.sendMessage('TOK', { text: 'hi', phone: '79001112233', dispatchRouting: ['tdlib'] });
  const [url, , opts] = axios.post.mock.calls[0];
  expect(url).toMatch(/^https:\/\/api\.chatpush\.ru\/api\/v1\/delivery\?/);
  expect(opts.headers.Authorization).toBe('Bearer TOK');
});

test('sendMessage: объект {apiBase, token} → свой base и свой Bearer', async () => {
  axios.post.mockResolvedValueOnce({ data: { meta: { status: 'success' }, delivery: { id: 'g1' } } });
  const d = await chatpush.sendMessage({ apiBase: 'http://127.0.0.1:3002', token: 'GW' }, { text: 'hi', phone: '79001112233', dispatchRouting: ['tdlib'] });
  const [url, , opts] = axios.post.mock.calls[0];
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:3002\/api\/v1\/delivery\?/);
  expect(opts.headers.Authorization).toBe('Bearer GW');
  expect(d).toEqual({ id: 'g1' });
});

test('getDeliveryStatus: объект кредов', async () => {
  axios.get.mockResolvedValueOnce({ data: { delivery: { id: 'g1', status: { status_id: 2 } } } });
  await chatpush.getDeliveryStatus({ apiBase: 'http://127.0.0.1:3002', token: 'GW' }, 'g1');
  expect(axios.get.mock.calls[0][0]).toBe('http://127.0.0.1:3002/api/v1/delivery/g1');
});

test('sendFile: объект кредов', async () => {
  axios.post.mockResolvedValueOnce({ data: { meta: { status: 'success' }, delivery: { id: 'g2' } } });
  await chatpush.sendFile({ apiBase: 'http://127.0.0.1:3002', token: 'GW' },
    { fileName: 'a.jpg', type: 'image', phone: '79001112233', dispatchRouting: ['tdlib'] }, Buffer.from('x'), 'image/jpeg');
  expect(axios.post.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:3002\/api\/v1\/send_file\?/);
});
