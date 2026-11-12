'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret', YC: 'https://api.yclients.test/api/v1' }));
jest.mock('axios', () => jest.fn());
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycHeaders: () => ({ Authorization: 'synthetic' }) }));
const axios = require('axios');
const yc = require('./services/journal/yclients');
const salon = { id: 3, yclients_company_id: 77 };
beforeEach(() => axios.mockReset());
test('DELETE /record/{cid}/{id}', async () => {
  axios.mockResolvedValue({ status: 204, data: '' });
  expect(await yc.remove(salon, 500)).toEqual({ recordId: 500 });
  expect(axios).toHaveBeenCalledWith(expect.objectContaining({ method: 'delete', url: 'https://api.yclients.test/api/v1/record/77/500', timeout: 30000 }));
});
test.each([404, 409])('%s from YClients = already deleted', async status => {
  axios.mockRejectedValue(Object.assign(new Error('x'), { response: { status } }));
  expect(await yc.remove(salon, 500)).toEqual({ recordId: 500, alreadyDeleted: true });
});
test('success:false and other statuses are errors', async () => {
  axios.mockResolvedValue({ status: 200, data: { success: false } });
  await expect(yc.remove(salon, 500)).rejects.toThrow('upstream_delete_failed');
  axios.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 422 } }));
  await expect(yc.remove(salon, 500)).rejects.toMatchObject({ response: { status: 422 } });
});
