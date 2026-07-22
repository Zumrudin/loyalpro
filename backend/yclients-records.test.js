'use strict';

jest.mock('axios');
jest.mock('./services/yclients', () => ({
  ycHeaders: jest.fn(() => ({ Authorization: 'Bearer p, User u' })),
  ycGet: jest.fn(),
}));

const axios = require('axios');
const { ycGet } = require('./services/yclients');
const {
  ycGetRecord, ycGetClientRecords, ycUpdateRecord,
} = require('./services/yclients-records');

const salon = { id: 1, yclients_company_id: 100, yclients_partner_token: 'p', yclients_user_token: 'u' };

beforeEach(() => jest.clearAllMocks());

describe('ycGetRecord', () => {
  test('GET /record/{cid}/{id} через ycGet', async () => {
    ycGet.mockResolvedValue({ id: 555, attendance: 0 });
    const rec = await ycGetRecord(salon, 555);
    expect(ycGet).toHaveBeenCalledWith(salon, '/record/100/555', {});
    expect(rec.id).toBe(555);
  });
});

describe('ycGetClientRecords', () => {
  test('GET /records/{cid} с client_id и start_date', async () => {
    ycGet.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const recs = await ycGetClientRecords(salon, 777, { startDate: '2026-07-22' });
    expect(ycGet).toHaveBeenCalledWith(salon, '/records/100',
      { client_id: 777, count: 300, start_date: '2026-07-22' });
    expect(recs).toHaveLength(2);
  });
  test('не массив → []', async () => {
    ycGet.mockResolvedValue(null);
    const recs = await ycGetClientRecords(salon, 777, {});
    expect(recs).toEqual([]);
  });
});

describe('ycUpdateRecord', () => {
  test('PUT /record/{cid}/{id} с телом, возвращает data.data', async () => {
    axios.put.mockResolvedValue({ data: { success: true, data: { id: 555 } } });
    const out = await ycUpdateRecord(salon, 555, { attendance: -1 });
    expect(axios.put).toHaveBeenCalledWith(
      expect.stringContaining('/record/100/555'),
      { attendance: -1 },
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(out.id).toBe(555);
  });
  test('success:false → бросает', async () => {
    axios.put.mockResolvedValue({ data: { success: false, meta: { message: 'нет' } } });
    await expect(ycUpdateRecord(salon, 555, {})).rejects.toThrow('нет');
  });
});
