'use strict';
require('dotenv').config();
const path = require('path');
const must = (k) => { const v = process.env[k]; if (!v) throw new Error(`gateway: не задан ${k}`); return v; };
module.exports = {
  PORT: parseInt(process.env.PORT || '3002', 10),
  DATABASE_URL: must('DATABASE_URL'),
  DB_SSL: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  TG_API_ID: parseInt(must('TG_API_ID'), 10),
  TG_API_HASH: must('TG_API_HASH'),
  INTERNAL_SECRET: must('GATEWAY_INTERNAL_SECRET'),
  BACKEND_WEBHOOK_URL: must('BACKEND_WEBHOOK_URL'),
  DATA_DIR: process.env.GATEWAY_DATA_DIR || path.join(__dirname, 'data'),
  // Куда класть скачанные медиа, чтобы бэкенд отдавал их статикой (express.static ../frontend).
  PUBLIC_FILES_DIR: process.env.GATEWAY_PUBLIC_FILES_DIR || path.join(__dirname, '../frontend/uploads/gateway'),
  PUBLIC_FILES_URL: process.env.GATEWAY_PUBLIC_FILES_URL || '/uploads/gateway',
  TDLIB_VERBOSITY: parseInt(process.env.TDLIB_VERBOSITY || '1', 10),
  // MAX (веб-протокол). appVersion веб-клиента — единственный «фингерпринт», который
  // сервер может объявить устаревшим; меняется env без правки кода.
  MAX_WS_URL: process.env.MAX_WS_URL || 'wss://ws-api.oneme.ru/websocket',
  MAX_WEB_APP_VERSION: process.env.MAX_WEB_APP_VERSION || '26.5.5',
  MAX_REQUEST_TIMEOUT_MS: parseInt(process.env.MAX_REQUEST_TIMEOUT_MS || '20000', 10),
};
