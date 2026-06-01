'use strict';

const sharp = require('sharp');
const s3 = require('./s3');

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

// Флаги для бейджа «До·После» в ленте/карточке. photos: [{stage}].
function stageFlags(photos) {
  const arr = Array.isArray(photos) ? photos : [];
  return {
    has_before: arr.some(p => p.stage === 'before'),
    has_after:  arr.some(p => p.stage === 'after'),
  };
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

// Полный пайплайн обработки одного фото:
//   1) sharp.rotate() — выровнять по EXIF Orientation, метаданные не сохраняем
//   2) 3 варианта (original re-encode, medium 1200, thumb 300)
//   3) 3× PutObject в S3 параллельно
//   4) на ошибке — DeleteObjects уже залитых
async function processAndUpload({ salonId, clientId, visitId, photoId, buffer, mimeType }) {
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'truncated' }).metadata();
    if (!meta || !meta.width || !meta.height) throw new Error('not an image');
  } catch (e) {
    const err = new Error(`Invalid image: ${e.message}`);
    err.statusCode = 400;
    throw err;
  }

  const img = sharp(buffer).rotate();
  const [originalBuf, mediumBuf, thumbBuf] = await Promise.all([
    img.clone().jpeg({ quality: 92, mozjpeg: true }).toBuffer(),
    img.clone().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
               .jpeg({ quality: 85, mozjpeg: true }).toBuffer(),
    img.clone().resize({ width: 300, height: 300, fit: 'cover' })
               .jpeg({ quality: 80, mozjpeg: true }).toBuffer(),
  ]);

  const keys = {
    original: buildS3Key(salonId, clientId, visitId, photoId, 'orig'),
    medium:   buildS3Key(salonId, clientId, visitId, photoId, 'med'),
    thumb:    buildS3Key(salonId, clientId, visitId, photoId, 'thumb'),
  };

  const uploaded = [];
  try {
    await Promise.all([
      s3.putObject(keys.original, originalBuf).then(() => uploaded.push(keys.original)),
      s3.putObject(keys.medium,   mediumBuf  ).then(() => uploaded.push(keys.medium)),
      s3.putObject(keys.thumb,    thumbBuf   ).then(() => uploaded.push(keys.thumb)),
    ]);
  } catch (e) {
    try { await s3.deleteObjects(uploaded); } catch (_) { /* swallowed: cron подберёт orphans */ }
    const err = new Error(`S3 upload failed: ${e.message}`);
    err.statusCode = 502;
    throw err;
  }

  return {
    s3_key_original: keys.original,
    s3_key_medium:   keys.medium,
    s3_key_thumb:    keys.thumb,
    mime_type: 'image/jpeg',
    size_bytes: originalBuf.length,
    width:  meta.width,
    height: meta.height,
  };
}

// Cron-handler: чистит таблицу s3_orphans — добивает удаления, которые
// не дошли из основного потока (S3 был недоступен, vpn-блип, etc).
// До 200 ключей за запуск, retries-cap 5.
async function processS3Orphans(dbIn, s3In) {
  const rows = await dbIn.any(`SELECT id, s3_key FROM s3_orphans WHERE attempts < 5 ORDER BY created_at LIMIT 200`);
  if (rows.length === 0) return { processed: 0, ok: 0, fail: 0 };
  let ok = 0, fail = 0;
  for (const r of rows) {
    try {
      await s3In.deleteObjects([r.s3_key]);
      await dbIn.query(`DELETE FROM s3_orphans WHERE id=$1`, [r.id]);
      ok++;
    } catch (e) {
      await dbIn.query(`UPDATE s3_orphans SET attempts = attempts + 1, last_error = $1 WHERE id=$2`, [e.message, r.id]);
      fail++;
    }
  }
  return { processed: rows.length, ok, fail };
}

module.exports = {
  buildS3Key,
  parseStage,
  normalizePhone,
  pickThumbForCard,
  stageFlags,
  assertCanMutate,
  ForbiddenError,
  processAndUpload,
  processS3Orphans,
};
