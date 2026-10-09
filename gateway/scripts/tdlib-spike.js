'use strict';
// Разовая проверка: (1) шлёт ли tdl 8 setTdlibParameters сам; (2) какие
// authorizationState приходят; (3) версия TDLib. Запуск: node scripts/tdlib-spike.js
// — ждёт 15 с и выходит, НИЧЕГО не шлёт и не логинится.
const tdl = require('tdl');
const { getTdjson } = require('prebuilt-tdlib');
const config = require('../config');
tdl.configure({ tdjson: getTdjson() });
const client = tdl.createClient({
  apiId: config.TG_API_ID, apiHash: config.TG_API_HASH,
  databaseDirectory: `${config.DATA_DIR}/spike/db`, filesDirectory: `${config.DATA_DIR}/spike/files`,
});
client.on('update', (u) => {
  if (u._ === 'updateAuthorizationState') console.log('AUTH STATE:', u.authorization_state._);
  else if (u._ === 'updateOption') console.log('OPTION', u.name, JSON.stringify(u.value));
});
client.on('error', (e) => console.error('ERR', e));
setTimeout(async () => {
  try { const v = await client.invoke({ _: 'getOption', name: 'version' }); console.log('TDLib version:', v.value); } catch (e) { console.error(e); }
  await client.close(); process.exit(0);
}, 15000);
