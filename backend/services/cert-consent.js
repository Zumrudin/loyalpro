'use strict';
const { createHash } = require('node:crypto');
const document = require('../data/certificate-consent-2026-09-28.json');
const digest = createHash('sha256').update(document.title + '\n' + document.body).digest('hex');
if (digest !== document.sha256) throw new Error('Certificate consent snapshot checksum mismatch');

// Documents and operator details are tenant-specific. Never apply PERI's consent to another salon.
function forSalon(salon) {
  return salon.cert_request_slug === 'clinic-1' ? document : null;
}
function publicConfig(salon) {
  const doc = forSalon(salon);
  return doc ? { version: doc.version, sha256: doc.sha256, url: doc.url } : null;
}
function validate(salon, body) {
  const doc = forSalon(salon);
  if (doc ? body.consent !== true : !body.consent) return 'consent';
  if (doc && (body.consent_version !== doc.version || body.consent_sha256 !== doc.sha256)) return 'consent_version';
  return null;
}
function evidence(salon) {
  const doc = forSalon(salon);
  // The accepted document comes only from the server snapshot, never from request body.
  return doc ? { ...doc, accepted: true, method: 'separate-checkbox-and-submit', purpose: 'certificate-request' } : null;
}
module.exports = { publicConfig, validate, evidence };
