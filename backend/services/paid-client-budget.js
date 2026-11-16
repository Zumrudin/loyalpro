'use strict';
const limits = require('./resource-limits');

// SDK retries must not bypass accounting. Provider adapters keep their explicit
// retries; every SDK invocation reserves quota before touching the network.
module.exports = function guardPaidClient(client) {
  for (const resource of [client.chat?.completions, client.embeddings]) {
    if (!resource?.create) continue;
    const create = resource.create.bind(resource);
    resource.create = async (params, options = {}) => {
      await limits.attempt({ paid: true });
      return create(params, { ...options, maxRetries: 0 });
    };
  }
  return client;
};
