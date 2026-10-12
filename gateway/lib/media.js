'use strict';
// Общее для всех клиентов шлюза: расширение файла — ТОЛЬКО из белого списка
// по MIME (имя задаёт собеседник, а каталог отдаётся статикой в origin админки —
// .html/.svg были бы stored XSS), кап размера, имя в публичном каталоге.
const crypto = require('crypto');

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'application/pdf': '.pdf',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  'video/mp4': '.mp4', 'video/quicktime': '.mov',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
};

function safeExt(mimeType) {
  return EXT_BY_MIME[String(mimeType || '').toLowerCase().split(';')[0].trim()] || '.bin';
}

function publicFileName(mimeType, now = Date.now()) {
  return `${now}_${crypto.randomBytes(8).toString('hex')}${safeExt(mimeType)}`;
}

module.exports = { MAX_MEDIA_BYTES, EXT_BY_MIME, safeExt, publicFileName };
