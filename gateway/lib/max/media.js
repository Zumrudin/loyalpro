'use strict';
// HTTP-часть медиа MAX (сами URL выдают опкоды 80/87/88 по WebSocket):
//  • скачивание по подписанному URL (фото baseUrl, файл — url из FILE_DOWNLOAD);
//  • фото — multipart POST поле `file` на iu.oneme.ru/uploadImage → {photos:{id:{token}}};
//  • файл — сырые байты POST на fu.oneme.ru с content-disposition и content-range
//    (формат с проверенного трафика max-account-api media.ts; кириллица в имени —
//    percent-encoded, сервер декодирует).
// http — axios-подобная функция (инжектится в тестах).
const { WEB_ORIGIN, HEADER_USER_AGENT } = require('./protocol');

const BASE_HEADERS = { Origin: WEB_ORIGIN, Referer: WEB_ORIGIN + '/', 'User-Agent': HEADER_USER_AGENT };

async function download(url, { http, maxBytes, timeoutMs }) {
  const res = await http({ method: 'get', url, responseType: 'arraybuffer', timeout: timeoutMs, maxContentLength: maxBytes, maxBodyLength: maxBytes, headers: BASE_HEADERS, validateStatus: null });
  if (res.status !== 200) throw new Error(`скачивание: HTTP ${res.status}`);
  const buf = Buffer.from(res.data || '');
  if (!buf.length) throw new Error('пустой файл');
  if (buf.length > maxBytes) throw new Error(`файл ${buf.length} байт больше лимита ${maxBytes}`);
  const ct = res.headers && (res.headers['content-type'] || res.headers['Content-Type']);
  const mimeType = String(ct || '').split(';')[0].trim() || null;
  return { buf, mimeType };
}

async function uploadPhoto(url, buf, fileName, mimeType, { http }) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mimeType || 'application/octet-stream' }), fileName || 'photo.jpg');
  const res = await http({ method: 'post', url, data: form, headers: BASE_HEADERS, timeout: 60000, maxBodyLength: Infinity, validateStatus: null });
  if (res.status !== 200) throw new Error(`загрузка фото: HTTP ${res.status}`);
  const photos = (res.data && res.data.photos) || {};
  const first = Object.values(photos)[0];
  if (!first || !first.token) throw new Error('загрузка фото: в ответе нет токена');
  return String(first.token);
}

function contentDisposition(fileName) {
  const n = String(fileName || 'file');
  const ascii = /^[\x20-\x7e]*$/.test(n);
  return `attachment; filename=${ascii ? n : encodeURIComponent(n)}`;
}

async function uploadFile(url, buf, fileName, { http }) {
  const res = await http({
    method: 'post', url, data: buf, timeout: 120000, maxBodyLength: Infinity, validateStatus: null,
    headers: { ...BASE_HEADERS, 'content-disposition': contentDisposition(fileName), 'content-range': `0-${buf.length - 1}/${buf.length}`, 'content-type': 'application/octet-stream' },
  });
  if (res.status !== 200) throw new Error(`загрузка файла: HTTP ${res.status}`);
}

module.exports = { download, uploadPhoto, uploadFile, contentDisposition, BASE_HEADERS };
