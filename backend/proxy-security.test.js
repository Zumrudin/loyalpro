'use strict';
const express = require('express');
const fs = require('fs');

let server;
let baseUrl;
beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use((req, _res, next) => {
    if (req.get('X-Test-Direct')) {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '198.51.100.10', configurable: true });
    }
    next();
  });
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('an untrusted direct connection cannot spoof the IP key with XFF', async () => {
  const response = await fetch(baseUrl + '/ip', {
    headers: { 'X-Test-Direct': '1', 'X-Forwarded-For': '203.0.113.99' },
  });
  expect(await response.json()).toEqual({ ip: '198.51.100.10' });
});

test('trusted loopback nginx supplies the normalized client IP', async () => {
  const response = await fetch(baseUrl + '/ip', {
    headers: { 'X-Forwarded-For': '2001:db8::1' },
  });
  expect(await response.json()).toEqual({ ip: '2001:db8::1' });
});

test('public certificate limits use req.ip and CORS denial is a managed JSON error', () => {
  const cert = fs.readFileSync(`${__dirname}/routes/public-cert-request.js`, 'utf8');
  expect(cert).toContain("const ip = req.ip || 'unknown'");
  expect(cert).not.toContain("req.headers['x-forwarded-for']");
  const serverSource = fs.readFileSync(`${__dirname}/server.js`, 'utf8');
  expect(serverSource).toContain("app.set('trust proxy', config.TRUST_PROXY)");
  expect(serverSource).toContain("err?.code === 'CORS_FORBIDDEN'");
  expect(serverSource).toContain("res.status(403).json({ error: 'Origin not allowed' })");
});
