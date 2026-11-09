'use strict';

function createAutoSync({ config, sync, setIntervalFn = setInterval, clearIntervalFn = clearInterval, logError = console.error }) {
  const timers = new Map();
  const running = new Set();
  const sources = [
    { id: 'azure-devops', minutes: () => config.adoAutoSyncMinutes, configured: () => config.isConfigured() },
    { id: 'github', minutes: () => config.ghAutoSyncMinutes, configured: () => config.isGitHubConfigured() },
  ];

  async function tick(source) {
    if (running.has(source.id) || !source.configured() || sync.syncStatus(source.id).running) return;
    running.add(source.id);
    try {
      const stats = await sync.runSync(source.id);
      for (const error of stats.errors || []) logError(`[auto-sync:${source.id}] ${error}`);
    } catch (err) {
      logError(`[auto-sync:${source.id}] ${err.message}`);
    } finally {
      running.delete(source.id);
    }
  }

  function stop() {
    for (const timer of timers.values()) clearIntervalFn(timer);
    timers.clear();
  }

  function start(providerId) {
    for (const source of sources) {
      if (providerId && source.id !== providerId) continue;
      if (timers.has(source.id)) clearIntervalFn(timers.get(source.id));
      timers.delete(source.id);
      if (source.minutes() > 0) {
        timers.set(source.id, setIntervalFn(() => tick(source), source.minutes() * 60000));
      }
    }
  }

  return { start, stop };
}

module.exports = createAutoSync({ config: require('./config'), sync: require('./sync') });
module.exports.createAutoSync = createAutoSync;
