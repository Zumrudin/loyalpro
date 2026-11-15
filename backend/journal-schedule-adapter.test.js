'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic', YC: 'https://yclients.test/api/v1' }));
jest.mock('axios', () => jest.fn());
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycHeaders: () => ({}) }));
const axios = require('axios');
const { ycGet } = require('./services/yclients');
const yc = require('./services/journal/yclients');
const salon = { id: 3, yclients_company_id: 77 }, date = '2030-04-01';
beforeEach(() => jest.resetAllMocks());
test('official schedule GET uses array query parameters and scopes returned rows', async () => {
  const row = { staff_id: 5, date, slots: [] };
  ycGet.mockResolvedValue([row, { ...row, staff_id: 9 }, { ...row, date: '2030-04-02' }]);
  expect(await yc.getStaffSchedule(salon, 5, date)).toEqual([row]);
  expect(ycGet).toHaveBeenCalledWith(salon, '/company/77/staff/schedule', { start_date: date, end_date: date, 'staff_ids[]': 5, 'include[]': 'busy_intervals' });
});
test.each([{ slots: [] }, { slots: [{ from: '09:00', to: '12:00' }, { from: '13:00', to: '18:00' }] }])('PUT uses set/delete contracts for %j', async ({ slots }) => {
  axios.mockResolvedValue({ data: { success: true, data: [] } });
  await yc.setStaffSchedule(salon, { staffId: 5, date, slots });
  const data = slots.length ? { schedules_to_set: [{ staff_id: 5, dates: [date], slots }] } : { schedules_to_delete: [{ staff_id: 5, dates: [date] }] };
  expect(axios).toHaveBeenCalledWith(expect.objectContaining({ method: 'put', url: 'https://yclients.test/api/v1/company/77/staff/schedule', data }));
});
test('malformed success is not confirmed', async () => {
  ycGet.mockResolvedValue({});
  await expect(yc.getStaffSchedule(salon, 5, date)).rejects.toMatchObject({ status: 502 });
  axios.mockResolvedValue({ data: { success: true, data: {} } });
  await expect(yc.setStaffSchedule(salon, { staffId: 5, date, slots: [] })).rejects.toThrow('schedule_write_unconfirmed');
});
