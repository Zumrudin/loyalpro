'use strict';
// Smoke-тест полного REST-цикла модуля «Фото-кейсы пациентов»:
//   create visit → upload 1 photo → verify thumb URL reachable → delete photo → delete visit
// Использование:
//   cd backend
//   SMOKE_BASE=http://localhost:3001 SMOKE_TOKEN=<admin-jwt> SMOKE_CLIENT_ID=<id> node scripts/patient-cases-smoke.js
require('dotenv').config();
const sharp = require('sharp');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3001';
const TOKEN = process.env.SMOKE_TOKEN;
const CLIENT_ID = parseInt(process.env.SMOKE_CLIENT_ID, 10);

if (!TOKEN || !CLIENT_ID) {
  console.error('SMOKE_TOKEN and SMOKE_CLIENT_ID are required env vars');
  process.exit(1);
}
const H = { Authorization: `Bearer ${TOKEN}` };

async function req(method, path, body, isForm = false) {
  const opts = { method, headers: { ...H } };
  if (body) {
    if (isForm) { opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const r = await fetch(`${BASE}${path}`, opts);
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${t}`);
  return t ? JSON.parse(t) : null;
}

(async () => {
  console.log('1) create visit');
  const v = await req('POST', '/api/patient-portfolio/visits', { client_id: CLIENT_ID });
  console.log('   visit id', v.id);

  console.log('2) upload 1 photo');
  const buf = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#cba' } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append('stage', 'before');
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), 'smoke.jpg');
  const u = await req('POST', `/api/patient-portfolio/visits/${v.id}/photos`, fd, true);
  if (!u.uploaded?.[0]?.ok) throw new Error('upload returned no ok=true');
  console.log('   uploaded photo id', u.uploaded[0].id);

  console.log('3) GET visit detail');
  const det = await req('GET', `/api/patient-portfolio/visits/${v.id}`);
  if (det.photos.length !== 1) throw new Error(`expected 1 photo in detail, got ${det.photos.length}`);
  const url = det.photos[0].url_thumb;
  const probe = await fetch(url);
  if (!probe.ok) throw new Error(`thumb URL not reachable: ${probe.status}`);
  console.log('   thumb 200 OK');

  console.log('4) delete photo');
  await req('DELETE', `/api/patient-portfolio/photos/${u.uploaded[0].id}`);

  console.log('5) delete visit');
  await req('DELETE', `/api/patient-portfolio/visits/${v.id}`);

  console.log('✅ smoke ok');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
