'use strict';

const path = require('path');

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const MAGIC = [
  { ext: '.png',  prefix: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) },
  { ext: '.jpg',  prefix: Buffer.from([0xFF, 0xD8, 0xFF]) },
  { ext: '.jpeg', prefix: Buffer.from([0xFF, 0xD8, 0xFF]) },
  { ext: '.gif',  prefix: Buffer.from('GIF87a', 'ascii') },
  { ext: '.gif',  prefix: Buffer.from('GIF89a', 'ascii') },
];

function isWebpBuffer(buf) {
  return buf.length >= 12
    && buf.slice(0, 4).toString('ascii') === 'RIFF'
    && buf.slice(8, 12).toString('ascii') === 'WEBP';
}

function getExt(originalName) {
  return (path.extname(originalName || '').toLowerCase()) || '.jpg';
}

function isExtAllowed(originalName) {
  return ALLOWED_EXT.has(getExt(originalName));
}

/**
 * Validate that the buffer actually starts with image magic bytes matching the extension.
 * Defense against attackers spoofing Content-Type to upload .html/.svg/.js disguised as image.
 * @returns {{ ok: boolean, ext?: string, error?: string }}
 */
function validateImageBuffer(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return { ok: false, error: 'Файл пустой или повреждён' };
  }
  const ext = getExt(originalName);
  if (!ALLOWED_EXT.has(ext)) {
    return { ok: false, error: 'Разрешены только .jpg, .jpeg, .png, .gif, .webp' };
  }
  if (ext === '.webp') {
    if (!isWebpBuffer(buffer)) return { ok: false, error: 'Содержимое не WebP' };
    return { ok: true, ext };
  }
  const matched = MAGIC.some(m => m.ext === ext && buffer.slice(0, m.prefix.length).equals(m.prefix));
  if (!matched) return { ok: false, error: 'Содержимое не соответствует расширению' };
  return { ok: true, ext };
}

/**
 * multer fileFilter: pre-screens by client-supplied mimetype + extension whitelist.
 * Real content check happens after upload via validateImageBuffer().
 */
function imageFileFilter(req, file, cb) {
  if (!/^image\/(jpeg|jpg|png|gif|webp)$/i.test(file.mimetype)) {
    return cb(new Error('Разрешены только изображения (jpg, png, gif, webp)'));
  }
  if (!isExtAllowed(file.originalname)) {
    return cb(new Error('Недопустимое расширение файла'));
  }
  cb(null, true);
}

module.exports = {
  ALLOWED_EXT,
  getExt,
  isExtAllowed,
  validateImageBuffer,
  imageFileFilter,
};
