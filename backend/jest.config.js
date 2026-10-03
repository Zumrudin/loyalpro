'use strict';
// TZ тестов = TZ боевого процесса (ecosystem.config.js: Europe/Moscow).
// Внутри песочницы Jest process.env.TZ не действует — только globalSetup.
module.exports = { globalSetup: './jest.global-setup.js' };
