'use strict';

const { getProvider } = require('./providers');

async function runSync(providerId = 'azure-devops') {
  const provider = getProvider(providerId);
  if (!provider.isConfigured()) throw new Error(`Configure ${provider.label} in Settings before syncing.`);
  return provider.runSync();
}

function syncStatus(providerId = 'azure-devops') {
  return getProvider(providerId).syncStatus();
}

module.exports = { runSync, syncStatus };
