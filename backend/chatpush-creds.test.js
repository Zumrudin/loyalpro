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

test('sendMessage: хвостовой слэш apiBase срезается', async () => {
  axios.post.mockResolvedValueOnce({ data: { meta: { status: 'success' }, delivery: { id: 'g3' } } });
  await chatpush.sendMessage({ apiBase: 'http://127.0.0.1:3002/', token: 'GW' }, { text: 'hi', phone: '79001112233', dispatchRouting: ['tdlib'] });
  expect(axios.post.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:3002\/api\/v1\/delivery\?/);
});

test('sendFile: объект кредов → Bearer GW', async () => {
  axios.post.mockResolvedValueOnce({ data: { meta: { status: 'success' }, delivery: { id: 'g4' } } });
  await chatpush.sendFile({ apiBase: 'http://127.0.0.1:3002', token: 'GW' },
    { fileName: 'a.jpg', type: 'image', phone: '79001112233', dispatchRouting: ['tdlib'] }, Buffer.from('x'), 'image/jpeg');
  expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer GW');
});

test('getDeliveryStatus: строка-токен → api.chatpush.ru и Bearer TOK', async () => {
  axios.get.mockResolvedValueOnce({ data: { delivery: { id: '5' } } });
  await chatpush.getDeliveryStatus('TOK', '5');
  expect(axios.get.mock.calls[0][0]).toBe('https://api.chatpush.ru/api/v1/delivery/5');
  expect(axios.get.mock.calls[0][1].headers.Authorization).toBe('Bearer TOK');
});

test('битые креды отвергаются до HTTP', async () => {
  const args = { text: 'hi', phone: '79001112233', dispatchRouting: ['tdlib'] };
  await expect(chatpush.sendMessage(null, args)).rejects.toThrow(/нет кредов/);
  await expect(chatpush.sendMessage({}, args)).rejects.toThrow(/без apiBase\/token/);
  await expect(chatpush.sendMessage({ apiBase: 'http://x' }, args)).rejects.toThrow(/без apiBase\/token/);
  expect(axios.post).not.toHaveBeenCalled();
});
