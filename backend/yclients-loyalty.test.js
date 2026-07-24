'use strict';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('./logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));
const axios = require('axios');
const { ycGetClientAbonements } = require('./services/yclients');

describe('ycGetClientAbonements', () => {
  beforeEach(() => jest.clearAllMocks());
  const salon = { yclients_company_id: '668791',
    yclients_partner_token: 'pt', yclients_user_token: 'ut' };

  test('зовёт /loyalty/abonements/ с company_id и phone', async () => {
    axios.get.mockResolvedValue({ data: { success: true, data: [{ id: 1 }] } });
    const out = await ycGetClientAbonements(salon, '79200255591');
    expect(out).toEqual([{ id: 1 }]);
    const url = axios.get.mock.calls[0][0];
    expect(url).toContain('/loyalty/abonements/');
    expect(url).toContain('company_id=668791');
    expect(url).toContain('phone=79200255591');
  });

  test('ошибка YClients разворачивается в message (ycError)', async () => {
    axios.get.mockRejectedValue({ response: { status: 400,
      data: { meta: { message: 'Не указан номер телефона' } } } });
    await expect(ycGetClientAbonements(salon, ''))
      .rejects.toThrow('Не указан номер телефона');
  });
});
