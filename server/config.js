'use strict';

const fs = require('fs');
const path = require('path');
const ENV_PATH = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: ENV_PATH, override: true });

function mergeEnv(content, values) {
  const remaining = new Map(Object.entries(values));
  const lines = content.split(/\r?\n/).filter((line, i, all) => i !== all.length - 1 || line !== '');
  const result = lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    if (!match || !Object.hasOwn(values, match[1])) return line;
    remaining.delete(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });
  for (const [key, value] of remaining) result.push(`${key}=${value}`);
  return result.join('\n') + '\n';
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHost(host) {
  return (host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

const config = {
  orgUrl: '',
  pat: '',
  authHeader: '',
  projects: [],
  ghToken: '',
  ghRepos: [],
  ghHost: 'github.com',
  port: 4073,
  staleDays: 14,
  lookbackDays: 365,
  discoveryDays: 30,
  adoAutoSyncMinutes: 0,
  ghAutoSyncMinutes: 0,

  isConfigured() {
    return Boolean(this.orgUrl && this.pat);
  },

  isGitHubConfigured() {
    return Boolean(this.ghToken);
  },

  isAnyConfigured() {
    return this.isConfigured() || this.isGitHubConfigured();
  },

  load() {
    this.orgUrl = (process.env.ADO_ORG_URL || '').trim().replace(/\/+$/, '');
    this.pat = (process.env.ADO_PAT || '').trim();
    this.authHeader = this.pat ? 'Basic ' + Buffer.from(':' + this.pat).toString('base64') : '';
    this.projects = (process.env.PROJECTS || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    this.ghToken = (process.env.GH_TOKEN || '').trim();
    this.ghRepos = (process.env.GH_REPOS || '')
      .split(',')
      .map((r) => r.trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/\/+$/, ''))
      .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
    this.ghHost = normalizeHost(process.env.GH_HOST) || 'github.com';
    this.port = intFromEnv('PORT', 4073);
    this.staleDays = intFromEnv('STALE_DAYS', 14);
    this.lookbackDays = intFromEnv('LOOKBACK_DAYS', 365);
    this.discoveryDays = Number(process.env.DISCOVERY_DAYS || 30);
    if (!Number.isInteger(this.discoveryDays) || this.discoveryDays < 1 || this.discoveryDays > 3650) {
      throw new Error('DISCOVERY_DAYS must be a whole number from 1 to 3650 days.');
    }
    for (const [property, name] of [['adoAutoSyncMinutes', 'ADO_AUTO_SYNC_MINUTES'], ['ghAutoSyncMinutes', 'GH_AUTO_SYNC_MINUTES']]) {
      const minutes = Number(process.env[name] || 0);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
        throw new Error(`${name} must be a whole number from 0 to 1440 minutes (0 turns it off).`);
      }
      this[property] = minutes;
    }
  },

  // Only keys present in the argument are written; other settings are preserved.
  // Blank tokens keep the existing one.
  save({ orgUrl, pat, projects, port, staleDays, lookbackDays, discoveryDays, ghToken, ghRepos, ghHost, adoAutoSyncMinutes, ghAutoSyncMinutes }) {
    const oldPort = this.port;
    const values = {};
    if (orgUrl !== undefined) values.ADO_ORG_URL = (orgUrl || '').trim().replace(/\/+$/, '');
    if (pat !== undefined) values.ADO_PAT = (pat || '').trim() || this.pat;
    if (projects !== undefined) values.PROJECTS = (projects || '').trim();
    if (ghToken !== undefined) values.GH_TOKEN = (ghToken || '').trim() || this.ghToken;
    if (ghRepos !== undefined) values.GH_REPOS = (ghRepos || '').trim();
    if (ghHost !== undefined) values.GH_HOST = normalizeHost(ghHost) || 'github.com';
    if (port !== undefined) values.PORT = String(port || 4073);
    if (staleDays !== undefined) values.STALE_DAYS = String(staleDays || 14);
    if (lookbackDays !== undefined) values.LOOKBACK_DAYS = String(lookbackDays || 365);
    if (discoveryDays !== undefined) {
      if (!Number.isInteger(discoveryDays) || discoveryDays < 1 || discoveryDays > 3650) {
        throw new Error('DISCOVERY_DAYS must be a whole number from 1 to 3650 days.');
      }
      values.DISCOVERY_DAYS = String(discoveryDays);
    }
    for (const [name, minutes] of [['ADO_AUTO_SYNC_MINUTES', adoAutoSyncMinutes], ['GH_AUTO_SYNC_MINUTES', ghAutoSyncMinutes]]) {
      if (minutes === undefined) continue;
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
        throw new Error(`${name} must be a whole number from 0 to 1440 minutes (0 turns it off).`);
      }
      values[name] = String(minutes);
    }

    const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    const content = mergeEnv(existing, values);
    fs.writeFileSync(ENV_PATH, content, 'utf8');

    for (const [k, v] of Object.entries(values)) process.env[k] = v;
    this.load();
    return { portChanged: this.port !== oldPort };
  },
};

config.load();

module.exports = config;
module.exports.mergeEnv = mergeEnv;
