'use strict';
// Константы веб-протокола MAX (то, чем говорит web.max.ru). Источники: типы
// max-account-api и payloads PyMax (оба MIT, реверс декомпилированного клиента),
// живая проверка HELLO/QR_START с дев-бокса 13.10.2026. Спека
// docs/superpowers/specs/2026-10-13-max-gateway-design.md, §2.1.
const PROTOCOL_VERSION = 11;
const CMD = { REQUEST: 0, RESPONSE: 1, ERROR: 3 };
const Op = {
  PING: 1, HELLO: 6, AUTH_REQUEST: 17, AUTH: 18, LOGIN: 19, LOGOUT: 20,
  CONTACT_INFO: 32, CONTACT_INFO_BY_PHONE: 46, CHAT_INFO: 48, CHAT_HISTORY: 49, MSG_SEND: 64,
  PHOTO_UPLOAD: 80, FILE_UPLOAD: 87, FILE_DOWNLOAD: 88, AUTH_CHECK_PASSWORD: 115,
  NOTIF_MESSAGE: 128, NOTIF_CHAT: 135, NOTIF_ATTACH: 136, NOTIF_PROFILE: 159,
  QR_START: 288, QR_POLL: 289, QR_LOGIN: 291,
};
const DEFAULT_WS_URL = 'wss://ws-api.oneme.ru/websocket';
const WEB_ORIGIN = 'https://web.max.ru';
const HEADER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const DEFAULT_APP_VERSION = '26.5.5';
// LOGIN отвечает этим, когда токен отозван (разлогин с телефона / «завершить все
// сеансы») — PyMax app._is_invalid_login_token_error.
const TOKEN_REVOKED = ['FAIL_LOGIN_TOKEN', 'FAIL_LOGOUT_ALL'];

// Профиль ПРОВЕРЕННЫЙ живьём 13.10.2026 (HELLO принят): менять только вместе с
// живой проверкой — сервер сверяет связку deviceType/appVersion.
function webUserAgent(appVersion) {
  return {
    deviceType: 'WEB', locale: 'ru', deviceLocale: 'ru', osVersion: 'macOS', deviceName: 'Chrome',
    headerUserAgent: HEADER_USER_AGENT, appVersion: appVersion || DEFAULT_APP_VERSION,
    screen: '720x1280 1.0x', timezone: 'Europe/Moscow',
  };
}

function isTokenRevoked(e) {
  if (!e) return false;
  return TOKEN_REVOKED.includes(String(e.code || '')) || TOKEN_REVOKED.includes(String(e.serverMessage || ''));
}

module.exports = { PROTOCOL_VERSION, CMD, Op, DEFAULT_WS_URL, WEB_ORIGIN, HEADER_USER_AGENT, DEFAULT_APP_VERSION, TOKEN_REVOKED, webUserAgent, isTokenRevoked };
