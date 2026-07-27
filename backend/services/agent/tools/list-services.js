'use strict';

const { loadCatalogServices } = require('../catalog-data');

const schema = {
  name: 'list_services',
  description: 'Список услуг салона: актуальная цена из YClients и мастера, которые эту услугу выполняют. ' +
    'Использовать, когда клиент спрашивает «что делаете / сколько стоит / кто делает такую-то услугу / что делает мастер».',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input) {
  return { services: await loadCatalogServices(salonId) };
}

module.exports = { schema, run };
