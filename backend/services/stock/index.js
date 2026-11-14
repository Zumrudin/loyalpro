'use strict';
// Фасад склада для routes/webhook.js и server.js.
const catalog = require('./catalog-sync');
module.exports = { handleGoodEvent: catalog.handleGoodEvent, syncStorages: catalog.syncStorages, syncCategories: catalog.syncCategories };

const logger = require('../../logger').createLogger('StockNightly');
async function nightly(salon) {
  if (require('../../config').STOCK_LEDGER === 'false') return {skipped:'disabled',errors:{}};
  const out={steps:{},errors:{}};
  for(const [name,fn] of [['storages',()=>catalog.syncStorages(salon)],['categories',()=>catalog.syncCategories(salon)],['pending',()=>require('./ledger').drainIngestPending(salon.id)]]) {
    try { out.steps[name]=await fn(); } catch (_) { out.errors[name]='unavailable'; }
  }
  if(out.steps.pending?.failed)out.errors.pending='ingest_failed';
  logger.info(`stock nightly salon=${salon.id}: pending=${out.steps.pending?.pending??'?'} storages=${out.steps.storages?.count??out.steps.storages?.storages??'?'} categories=${out.steps.categories?.skipped?'skipped':'synced'} errors=${Object.keys(out.errors).join(',')||'none'}`);
  return out;
}
module.exports.nightly=nightly;
