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
  },

  // Only keys present in the argument are written; other settings are preserved.
  // Blank tokens keep the existing one.
  save({ orgUrl, pat, projects, port, staleDays, lookbackDays, ghToken, ghRepos, ghHost }) {
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
