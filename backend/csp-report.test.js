'use strict';
const express = require('express');
const fs = require('fs');
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('./logger', () => ({ createLogger: () => mockLogger }));
const router = require('./routes/csp-report');

let server;
let baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => jest.clearAllMocks());

test('CSP reports expose only allowlisted technical categories in logs', async () => {
  const response = await fetch(baseUrl + '/api/csp-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/csp-report' },
    body: JSON.stringify({ 'csp-report': {
      'effective-directive': 'script-src-attr',
      'blocked-uri': 'inline',
      'document-uri': 'https://example.invalid/private-path',
      'script-sample': 'synthetic-private-content',
    } }),
  });
  expect(response.status).toBe(204);
  expect(mockLogger.info).toHaveBeenCalledWith('violation directive=script-src-attr blocked=inline');
  expect(JSON.stringify(mockLogger)).not.toContain('private');
});

test('malformed and oversized reports are rejected without logging their content', async () => {
  const invalid = await fetch(baseUrl + '/api/csp-report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"unexpected":true}',
  });
  expect(invalid.status).toBe(400);
  const oversized = await fetch(baseUrl + '/api/csp-report', {
    method: 'POST', headers: { 'Content-Type': 'application/csp-report' },
    body: JSON.stringify({ 'csp-report': { sample: 'x'.repeat(5000) } }),
  });
  expect(oversized.status).toBe(413);
  expect(mockLogger.info).not.toHaveBeenCalled();
});

test('strict script policy is enforced and reported; cert iframe policy stays separate', () => {
  const source = fs.readFileSync(`${__dirname}/server.js`, 'utf8');
  expect(source).toContain("scriptSrc: [\"'self'\", \"cdn.jsdelivr.net\"]");
  expect(source).toContain("res.setHeader('Content-Security-Policy-Report-Only', REPORT_ONLY_CSP)");
  expect(router.REPORT_ONLY_CSP).toBe("script-src 'self' cdn.jsdelivr.net; report-uri /api/csp-report");
  expect(router.REPORT_ONLY_CSP).not.toContain('unsafe-inline');
  const cert = fs.readFileSync(`${__dirname}/routes/public-cert-request.js`, 'utf8');
  expect(cert).toContain("res.setHeader('Content-Security-Policy'");
  expect(cert).toContain('frame-ancestors ${ancestors}');
  expect(cert).not.toContain("script-src 'self' 'unsafe-inline'");
});
