'use strict';

const { randomUUID } = require('node:crypto');
const { createLocalUsage } = require('./local-usage.cjs');

// Bind a standalone desktop operation to its initiating account. Multiple
// provider requests within that operation are separate receipts of one work.
function recorder(app, sourceType, owner) {
  if (!app?.getPath) return;
  try {
    if (!owner) {
      const auth = require('../device-auth');
      const identity = auth.identity(app);
      owner = identity && { hub: identity.hub, clientId: identity.clientId, accountScope: auth.localOwner(app) };
    }
    if (!owner?.accountScope) return;
    const store = createLocalUsage(app);
    const handle = { usageIdentity: owner, sessionId: randomUUID(), usageSourceType: sourceType };
    return (model, raw) => {
      const known = ['total_tokens', 'prompt_tokens', 'completion_tokens'].some(key =>
        Number.isSafeInteger(raw?.[key]) && raw[key] >= 0);
      store.observe(handle, { usageReceipts: [{ localOnly: true, model, agent: 'app-ai', at: Date.now(),
        requestId: randomUUID(), usage: known ? { ...raw, requests: 1 } : { requests: 1, quality: 'unknown' } }] });
    };
  } catch { /* Bookkeeping is best effort when there is no trusted local identity. */ }
}

module.exports = { recorder };
