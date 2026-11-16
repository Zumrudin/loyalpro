'use strict';
const express = require('express');
const http = require('http');

jest.mock('./db', () => ({
  db: { oneOrNone: jest.fn(), one: jest.fn(), any: jest.fn(), query: jest.fn() },
}));
jest.mock('./config', () => ({ S3_BUCKET: 'synthetic', S3_URL_TTL_SECONDS: 60 }));
jest.mock('./services/s3', () => ({ presignGet: jest.fn(), deleteObjects: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }) }));

const { db } = require('./db');
const s3 = require('./services/s3');
const router = require('./routes/patient-portfolio');

let server;
let baseUrl;
let salonId;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { salonId, userId: 7, role: 'owner' }; next(); });
  app.use(router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  salonId = 1;
  db.oneOrNone.mockImplementation(async (sql, params) => {
    if (sql.includes('SELECT id FROM clients')) return params[0] == 10 && params[1] === 1 ? { id: 10 } : null;
    if (sql.includes('SELECT id, client_id FROM case_courses')) return params[0] == 30 && params[1] === 1 && params[2] == 10 ? { id: 30, client_id: 10 } : null;
    if (sql.includes('FROM records WHERE id=')) return params[0] == 20 && params[1] === 1 ? { id: 20, client_id: 10, visit_date: '2030-01-02' } : null;
    if (sql.includes('SELECT id FROM users')) return params[0] === 7 && params[1] === 1 ? { id: 7 } : null;
    if (sql.includes('SELECT v.* FROM case_visits')) return params[0] == 40 && params[1] === 1
      ? { id: 40, salon_id: 1, client_id: 10, specialist_user_id: 7, course_id: null } : null;
    return null;
  });
  db.any.mockResolvedValue([]);
  db.query.mockResolvedValue({ rows: [] });
  db.one.mockImplementation(async sql => sql.includes('INSERT INTO') ? { id: 50 } : null);
});
function request(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(baseUrl + path, {
      method,
      headers: { Connection: 'close', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
function writes() {
  return [...db.one.mock.calls, ...db.query.mock.calls].filter(([sql]) => /INSERT INTO|UPDATE |DELETE FROM/.test(sql));
}

test('foreign client courses are rejected before reads or writes', async () => {
  const response = await request('/clients/11/courses');
  expect(response.status).toBe(404);
  expect(writes()).toHaveLength(0);
  expect(s3.presignGet).not.toHaveBeenCalled();
});

test('foreign client cases are rejected before reads or writes', async () => {
  const response = await request('/clients/11/cases');
  expect(response.status).toBe(404);
  expect(writes()).toHaveLength(0);
  expect(s3.presignGet).not.toHaveBeenCalled();
});

test.each([
  ['POST', '/courses', { client_id: 11, title: 'Synthetic' }],
  ['POST', '/visits', { client_id: 10, record_id: 21 }],
  ['POST', '/visits', { client_id: 10, course_id: 31 }],
])('foreign or missing resource is rejected before writes: %s %s', async (method, path, body) => {
  const response = await request(path, method, body);
  expect(response.status).toBe(404);
  expect(writes()).toHaveLength(0);
  expect(s3.presignGet).not.toHaveBeenCalled();
});

test('another tenant client gets the same 404 without a read of its cases', async () => {
  salonId = 2;
  expect((await request('/clients/10/cases')).status).toBe(404);
  expect(db.any).not.toHaveBeenCalled();
  expect(db.oneOrNone).toHaveBeenCalledWith('SELECT id FROM clients WHERE id=$1 AND salon_id=$2', ['10', 2]);
});

test('a record belonging to a different client cannot be attached', async () => {
  db.oneOrNone.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM records WHERE id=')) return { id: 20, client_id: 999, visit_date: '2030-01-02' };
    if (sql.includes('SELECT id FROM clients')) return { id: 10 };
    return null;
  });
  expect((await request('/visits', 'POST', { client_id: 10, record_id: 20 })).status).toBe(409);
  expect(writes()).toHaveLength(0);
});

test('record idempotency cannot disclose another client case', async () => {
  db.oneOrNone.mockImplementation(async (sql, params) => {
    if (sql.includes('SELECT * FROM case_visits WHERE salon_id=')) return { id: 40, client_id: 999, record_id: 20 };
    if (sql.includes('FROM records WHERE id=')) return { id: 20, client_id: 10, visit_date: '2030-01-02' };
    if (sql.includes('SELECT id FROM clients') || sql.includes('SELECT id FROM users')) return { id: params[0] };
    return null;
  });
  const response = await request('/visits', 'POST', { client_id: 10, record_id: 20 });
  expect(response.status).toBe(409);
  expect(response.body).not.toHaveProperty('client_id');
  expect(writes()).toHaveLength(0);
});

test('valid own-tenant visit still works and reuses record date', async () => {
  const response = await request('/visits', 'POST', { client_id: 10, record_id: 20, course_id: 30 });
  expect(response.status).toBe(201);
  expect(db.one).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO case_visits'),
    [1, 10, 20, 30, 7, '2030-01-02', null]);
});

test('new course is revalidated against the visit client before update', async () => {
  const response = await request('/visits/40', 'PUT', { course_id: 31 });
  expect(response.status).toBe(404);
  expect(writes()).toHaveLength(0);
  const valid = await request('/visits/40', 'PUT', { course_id: 30, notes: 'Synthetic' });
  expect(valid.status).toBe(200);
  expect(db.one).toHaveBeenCalledWith(expect.stringContaining('WHERE id=$3 AND salon_id=$4'), ['Synthetic', 30, 40, 1]);
});

test('recent/cases/photo batch and detail queries preserve tenant joins', async () => {
  await request('/visits/recent');
  const recent = db.any.mock.calls[0][0];
  for (const fragment of ['cl.salon_id=v.salon_id', 'u.salon_id=v.salon_id', 'crs.salon_id=v.salon_id',
    'p.salon_id=v.salon_id', 'cm.salon_id=v.salon_id']) expect(recent).toContain(fragment);

  await request('/clients/10/cases');
  const cases = db.any.mock.calls.at(-1)[0];
  for (const fragment of ['cl.salon_id=v.salon_id', 'u.salon_id=v.salon_id', 'c.salon_id=v.salon_id']) expect(cases).toContain(fragment);
  db.any.mockResolvedValueOnce([{ id: 40, salon_id: 1 }]);
  await request('/visits/recent');
  expect(db.any).toHaveBeenCalledWith(expect.stringContaining('case_visit_id = ANY($1::int[]) AND salon_id=$2'), [[40], 1]);

  await request('/visits/40');
  for (const [sql, params] of db.any.mock.calls.slice(-2)) {
    expect(sql).toContain('salon_id=$2');
    expect(params).toEqual([40, 1]);
  }
});

test('deactivation of current specialist cannot create a visit', async () => {
  db.oneOrNone.mockImplementation(async sql => {
    if (sql.includes('SELECT id FROM clients')) return { id: 10 };
    return null;
  });
  expect((await request('/visits', 'POST', { client_id: 10 })).status).toBe(404);
  expect(writes()).toHaveLength(0);
});
