'use strict';

const STAGES = new Set(['before','in_progress','after']);
const VARIANT_SUFFIX = { orig: 'orig', med: 'med', thumb: 'thumb' };

function buildS3Key(salonId, clientId, visitId, photoId, variant) {
  const suffix = VARIANT_SUFFIX[variant];
  if (!suffix) throw new Error(`invalid s3 variant: ${variant}`);
  return `salon_${salonId}/client_${clientId}/visit_${visitId}/${photoId}_${suffix}.jpg`;
}

function parseStage(input) {
  if (typeof input !== 'string') throw new Error('stage must be a string');
  const s = input.trim().toLowerCase();
  if (!STAGES.has(s)) throw new Error(`invalid stage: ${input}`);
  return s;
}

function normalizePhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function pickThumbForCard(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  const by = (stage) => photos.find(p => p.stage === stage);
  return by('after') || by('in_progress') || by('before') || null;
}

class ForbiddenError extends Error {
  constructor(msg = 'Forbidden') { super(msg); this.statusCode = 403; }
}

function assertCanMutate(user, ownerUserId) {
  if (!user) throw new ForbiddenError();
  if (user.role === 'owner' || user.role === 'admin') return;
  if (ownerUserId != null && user.id === ownerUserId) return;
  throw new ForbiddenError('Only the author or admin can modify this');
}

module.exports = {
  buildS3Key,
  parseStage,
  normalizePhone,
  pickThumbForCard,
  assertCanMutate,
  ForbiddenError,
};
