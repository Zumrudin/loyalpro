'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
const m = require('./services/journal/model');
const operationId = '12345678-1234-4123-8123-123456789012';
const base = { operationId, date: '2030-04-01', time: '10:00', staffId: 1, serviceIds: [7], clientName: 'Тест', clientPhone: '70000000000' };
const record = { id: 8, staff_id: 1, datetime: '2030-04-01T10:00:00+03:00', seance_length: 3600, services: [{ id: 7 }], client: { name: 'Тест' }, attendance: 0 };
const context = { date: '2030-04-01', staffId: 1, duration: 60, schedule: [{ date: '2030-04-01', is_working: true, slots: [{ from: '09:00', to: '12:00' }] }], records: [], resources: [], resourceIds: [], now: 0 };
test('real calendar dates, IDs and request validation', () => {
  expect(() => m.dateKey('2030-02-30')).toThrow();
  expect(() => m.positiveId('1 OR 1=1')).toThrow();
  expect(() => m.parseDraft({ ...base, operationId: 'wrong' }, 'create')).toThrow();
  expect(() => m.parseDraft({ ...base, time: '24:01' }, 'create')).toThrow();
  expect(() => m.parseDraft({ ...base, serviceIds: [] }, 'create')).toThrow();
  expect(() => m.parseDraft({ ...base, clientPhone: 'invalid' }, 'create')).toThrow();
  expect(m.parseDraft({ ...base, salonId: 99, services: 'ignored' }, 'create')).not.toHaveProperty('salonId');
});
test('timezone conversion and revisions detect client/service changes', () => {
  expect(m.moscowParts('2030-03-31T22:30:00Z')).toMatchObject({ date: '2030-04-01', time: '01:30' });
  expect(m.moscowParts('2030-04-01 10:00:00')).toMatchObject({ date: '2030-04-01', time: '10:00' });
  expect(m.revision(record)).not.toBe(m.revision({ ...record, client: { name: 'Другой' } }));
  expect(m.normalizeRecord(record)).not.toHaveProperty('clientPhone');
});
test('whole visit fits shift; breaks and staff conflicts excluded, endpoints allowed', () => {
  const slots = m.slotsFor({ ...context, records: [record] });
  expect(slots).toContain('09:00'); expect(slots).toContain('11:00');
  expect(slots).not.toContain('09:05'); expect(slots).not.toContain('10:00');
  expect(slots).not.toContain('11:05');
  expect(m.slotsFor({ ...context, records: [record], excludeId: 8 })).toContain('10:00');
  expect(m.slotsFor({ ...context, schedule: [] })).toEqual([]);
});
test('equipment occupied by another staff; second instance allows booking', () => {
  const ctx = { ...context, records: [{ ...record, staff_id: 2, resource_instance_ids: [50] }], resourceIds: ['5'], resources: [{ id: 5, instances: [{ id: 50 }] }] };
  expect(m.slotsFor(ctx)).not.toContain('10:00');
  expect(m.slotsFor({ ...ctx, resources: [{ id: 5, instances: [{ id: 50 }, { id: 51 }] }] })).toContain('10:00');
  expect(() => m.slotsFor({ ...ctx, resources: [] })).toThrow(/оборудование/);
});
test('missing resource assignment conservatively reserves shared equipment', () => {
  const ctx = { ...context, records: [{ ...record, staff_id: 2, _journalResourceIds: [5] }], resourceIds: ['5'], resources: [{ id: 5, instances: [{ id: 50 }] }] };
  expect(m.slotsFor(ctx)).not.toContain('10:00');
});
test('midnight crossing from preceding day blocks interval', () => {
  const ctx = { ...context, schedule: [{ date: context.date, is_working: true, slots: [{ from: '00:00', to: '03:00' }] }], records: [{ ...record, datetime: '2030-03-31T23:30:00+03:00', seance_length: 7200 }] };
  expect(m.slotsFor(ctx)).not.toContain('01:00');
  expect(m.slotsFor(ctx)).toContain('01:30');
});
test('unknown durations fail closed and past slots disappear', () => {
  expect(() => m.slotsFor({ ...context, records: [{ ...record, seance_length: 0 }] })).toThrow();
  expect(m.slotsFor({ ...context, now: Date.parse('2030-04-01T11:00:00+03:00') })).toEqual([]);
});

test('calendar filters neighbouring company dates by Moscow time and clips overnight visits', () => {
  const rows = m.recordsForDay([
    { ...record, id: 1, datetime: '2030-04-02T00:30:00+04:00' },
    { ...record, id: 2, datetime: '2030-03-31T23:30:00+03:00', seance_length: 7200 },
    { ...record, id: 3, datetime: '2030-04-02T02:00:00+03:00' },
  ], '2030-04-01');
  expect(rows.map(r => r.id)).toEqual([1,2]);
  expect(rows[0].time).toBe('23:30');
  expect(rows[1]).toMatchObject({ time: '00:00', duration: 90, continued: true });
});

test('calendar does not silently omit a malformed appointment', () => {
  expect(() => m.recordsForDay([{ ...record, datetime: 'invalid' }], '2030-04-01')).toThrow(/времени/);
});
test('administrator is identified from role metadata, not online visibility or name', () => {
  expect(m.isAdministrator({ position: { title: 'Администратор-регистратор' } })).toBe(true);
  expect(m.isAdministrator({ specialization: 'Старший администратор' })).toBe(true);
  expect(m.isAdministrator({ name: 'Administrator', specialization: 'Врач', hidden: 1, bookable: false })).toBe(false);
});
test('working-day metadata includes split shifts and excludes off days', () => {
  expect(m.staffSchedule([{ date: '2030-04-01', is_working: 1, slots: [{ from: '09:00', to: '12:00' }, { from: '13:00', to: '18:00' }] }], '2030-04-01')).toEqual({ working: true, workRanges: [{ start: 540, end: 720 }, { start: 780, end: 1080 }] });
  expect(m.staffSchedule([{ date: '2030-04-01', is_working: '0', slots: [] }], '2030-04-01')).toEqual({ working: false, workRanges: [] });
  expect(m.staffSchedule([], '2030-04-01').working).toBe(false);
});

test('creation recalculates editable quote and rejects mismatched totals/services', () => {
 const m=require('./services/journal/model');
 const body={operationId:'12345678-1234-4123-8123-123456789012',staffId:1,date:'2030-04-01',time:'10:00',clientName:'Synthetic',clientPhone:'70000000000',serviceIds:[70],serviceSource:'internal',lines:[{serviceId:70,quantity:2,unitPrice:100,discount:10,total:999,mode:'discount'}]};
 expect(m.parseDraft(body,'create').lines[0]).toMatchObject({total:180,gross:200});
 expect(()=>m.parseDraft({...body,lines:[{...body.lines[0],serviceId:71}]},'create')).toThrow();
});
