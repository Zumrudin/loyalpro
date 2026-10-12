'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHash } = require('node:crypto');
const consent = require('./cert-consent');
const salon = { id: 17, cert_request_slug: 'clinic-1' };
const current = consent.publicConfig(salon);
const accepted = { consent: true, consent_version: current.version, consent_sha256: current.sha256 };

test('requires explicit boolean and exact revision; rejects missing, stale and tampered values', () => {
  assert.equal(consent.validate(salon, accepted), null);
  for (const value of [false, undefined, 'false', 'true', 1, {}, []]) assert.equal(consent.validate(salon, { ...accepted, consent: value }), 'consent');
  for (const body of [{ consent: true }, { ...accepted, consent_version: 'old' }, { ...accepted, consent_sha256: 'f'.repeat(64) }]) assert.equal(consent.validate(salon, body), 'consent_version');
});
test('evidence is server-owned and independently reconstructs the accepted document', () => {
  const evidence = consent.evidence(salon);
  assert.equal(evidence.accepted, true);
  assert.equal(createHash('sha256').update(evidence.title + '\n' + evidence.body).digest('hex'), current.sha256);
  assert.match(evidence.body, /подготовки справки/);
});
test('other tenants do not inherit PERI operator or a fabricated historical revision', () => {
  const other = { id: 18, cert_request_slug: 'clinic-2' };
  assert.equal(consent.publicConfig(other), null);
  assert.equal(consent.evidence(other), null);
  assert.equal(consent.validate(other, { consent: true }), null);
});

function harness() {
  const handlers = {};
  const inserts = [];
  let matched = false;
  const router = { get: (p, f) => handlers['GET ' + p] = f, post: (p, f) => handlers['POST ' + p] = f };
  const db = { one: async (sql, params) => { inserts.push({ sql, params }); return { id: 42 }; } };
  const svc = {
    makeRateLimiter: () => () => true, makeTokenStore: () => ({ put: () => 'a'.repeat(48) }),
    resolveSalonBySlug: async () => salon, isAdult: () => true, validateInn: () => true,
    validatePassportSerieNumber: () => true, toRuPhone: () => 'synthetic-test-phone', normalizeInn: v => v,
    matchPatient: async () => { matched = true; return { clientId: null }; }, computeYearAmount: async () => 0,
    RELATIONSHIP_LABELS: {}, DOC_TYPE_PASSPORT: '21',
  };
  const file = path.join(__dirname, '../routes/public-cert-request.js');
  const module = { exports: {} };
  const imports = {
    path, express: { Router: () => router }, '../config': { MEDICAL_CERT_CLINIC: { org_name: 'Synthetic clinic' }, CERT_REQUEST_POLICY_URL: '/politika' },
    '../db': { db }, '../logger': { createLogger: () => ({ error: () => {} }) }, '../services/cert-request': svc, '../services/cert-consent': consent,
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: name => { if (!(name in imports)) throw new Error(name); return imports[name]; }, module, __dirname: path.dirname(file) });
  return { handlers, inserts, matched: () => matched };
}
function response() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; }, setHeader() {} }; }
const valid = () => ({ ...accepted, report_year: new Date().getFullYear(), payer_is_patient: true, payer_last: 'TEST', payer_first: 'TEST', payer_middle: 'TEST', payer_birthdate: '1990-01-01', payer_inn: 'TEST', payer_doc_serie_number: 'TEST', payer_doc_issue_date: '2010-01-01', payer_phone: 'TEST' });
async function submit(h, body) {
  const res = response();
  await h.handlers['POST /api/public/cert-requests/:slug']({ body, params: { slug: 'clinic-1' }, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}
test('API rejects old forms before matching patients or writing requests', async () => {
  const h = harness(); const body = valid(); delete body.consent_version;
  const res = await submit(h, body);
  assert.equal(res.statusCode, 400); assert.ok(res.body.fields.includes('consent_version'));
  assert.equal(h.matched(), false); assert.equal(h.inserts.length, 0);
});
test('API atomically saves server time and canonical document with the tenant-owned request', async () => {
  const h = harness(); const res = await submit(h, { ...valid(), consent_document: { body: 'FORGED' }, consent_at: '1900-01-01' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.ok, true);
  const { sql, params } = h.inserts[0];
  assert.match(sql, /consent_at, ip, user_agent, consent_document/); assert.match(sql, /now\(\)/);
  assert.equal(params.length, 28); assert.equal(params[0], salon.id);
  assert.deepEqual(JSON.parse(params[27]), consent.evidence(salon));
});
test('config publishes the same revision required by POST', async () => {
  const h = harness(); const res = response();
  await h.handlers['GET /api/public/cert-requests/:slug/config']({ params: { slug: 'clinic-1' } }, res);
  assert.deepEqual(res.body.consent, current);
});
