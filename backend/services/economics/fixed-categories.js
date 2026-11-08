'use strict';
// Статьи постоянных расходов. Фронт (ECO_FIXED_CATS в economics-table.js) сверяется с этим списком тестом.
// Файл без зависимостей: фронтовый node --test грузит его, не трогая db.js.
const FIXED_CATEGORIES = ['rent', 'admin', 'cleaning', 'utilities', 'software', 'marketing', 'accounting', 'medwaste', 'other'];
module.exports = { FIXED_CATEGORIES };
