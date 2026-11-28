'use strict';

// Registry locations are part of the signed distribution. Never put credentials in app metadata.
const sources = {
  SODUWORK_PLANNING_INDEX_URL: 'index',
  SODUWORK_PLANNING_PUBLIC_INDEX_URL: 'dependencies',
};

function indexUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw Error('Planning requires an HTTPS package index without credentials, query or fragment');
  }
  return url.href.replace(/\/?$/, '/');
}

function buildMetadata(env = process.env) {
  const entries = Object.entries(sources).filter(([name]) => env[name])
    .map(([name, key]) => [key, indexUrl(env[name])]);
  return entries.length ? { soduworkPlanningIndexes: Object.fromEntries(entries) } : {};
}

function applyMetadata(env, metadata) {
  for (const [name, key] of Object.entries(sources)) {
    // Remove case aliases too on Windows before restoring the signed value.
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === name) delete env[existing];
    if (metadata?.[key]) env[name] = indexUrl(metadata[key]);
  }
}

module.exports = { buildMetadata, applyMetadata };
