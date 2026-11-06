'use strict';

const { getProvider, listProviders } = require('./providers');

async function runOne(providerId) {
  const provider = getProvider(providerId);
  if (!provider.isConfigured()) throw new Error(`Configure ${provider.label} in Settings before syncing.`);
  return provider.runSync();
}

// Without an explicit provider, every configured source is synced and the
// per-provider results are aggregated for the dashboard.
async function runSync(providerId) {
  if (providerId) return runOne(providerId);
  const targets = listProviders().filter((provider) => provider.configured);
  if (targets.length === 0) throw new Error('Not configured. Open Settings to connect a work source first.');
  const aggregate = { results: {}, errors: [], candidates: 0, upserted: 0, deepScanned: 0, touches: 0 };
  for (const target of targets) {
    try {
      const stats = await runOne(target.id);
      aggregate.results[target.id] = stats;
      for (const key of ['candidates', 'upserted', 'deepScanned', 'touches']) {
        aggregate[key] += stats[key] || 0;
      }
      for (const error of stats.errors || []) aggregate.errors.push(`${target.label}: ${error}`);
    } catch (err) {
      aggregate.errors.push(`${target.label}: ${err.message}`);
    }
  }
  aggregate.completedAt = new Date().toISOString();
  return aggregate;
}

function syncStatus(providerId) {
  if (providerId) return getProvider(providerId).syncStatus();
  const statuses = {};
  let running = false;
  const watermarks = [];
  for (const provider of listProviders()) {
    const status = getProvider(provider.id).syncStatus();
    statuses[provider.id] = status;
    running = running || Boolean(status.running);
    if (status.lastSync) watermarks.push(status.lastSync);
  }
  return { running, lastSync: watermarks.sort().pop() || null, providers: statuses };
}

module.exports = { runSync, syncStatus };
