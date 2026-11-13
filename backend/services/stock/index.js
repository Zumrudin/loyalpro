'use strict';
// Фасад склада для routes/webhook.js и server.js.
const catalog = require('./catalog-sync');
module.exports = { handleGoodEvent: catalog.handleGoodEvent, syncStorages: catalog.syncStorages, syncCategories: catalog.syncCategories };
