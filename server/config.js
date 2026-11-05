'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ENV_PATH = path.join(__dirname, '..', '.env');

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  orgUrl: '',
  pat: '',
  authHeader: '',
  projects: [],
  port: 4073,
  staleDays: 14,
  lookbackDays: 365,

  isConfigured() {
    return Boolean(this.orgUrl && this.pat);
  },

  load() {
    this.orgUrl = (process.env.ADO_ORG_URL || '').trim().replace(/\/+$/, '');
    this.pat = (process.env.ADO_PAT || '').trim();
    this.authHeader = this.pat ? 'Basic ' + Buffer.from(':' + this.pat).toString('base64') : '';
    this.projects = (process.env.PROJECTS || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    this.port = intFromEnv('PORT', 4073);
    this.staleDays = intFromEnv('STALE_DAYS', 14);
    this.lookbackDays = intFromEnv('LOOKBACK_DAYS', 365);
  },

  save({ orgUrl, pat, projects, port, staleDays, lookbackDays }) {
    const oldPort = this.port;
    const values = {
      ADO_ORG_URL: (orgUrl || '').trim().replace(/\/+$/, ''),
      ADO_PAT: (pat || '').trim() || this.pat, // blank PAT keeps the existing one
      PROJECTS: (projects || '').trim(),
      PORT: String(port || 4073),
      STALE_DAYS: String(staleDays || 14),
      LOOKBACK_DAYS: String(lookbackDays || 365),
    };

    const content = Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
    fs.writeFileSync(ENV_PATH, content, 'utf8');

    for (const [k, v] of Object.entries(values)) process.env[k] = v;
    this.load();
    return { portChanged: this.port !== oldPort };
  },
};

config.load();

module.exports = config;
