'use strict';

async function boundedJSON(response) {
  if (Number(response.headers?.get('content-length') || 0) > 1048576) {
    await response.body?.cancel(); throw Error('response too large');
  }
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 1048576) throw Error('response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

module.exports = { boundedJSON };
