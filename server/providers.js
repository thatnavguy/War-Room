'use strict';

const config = require('./config');
const ado = require('./ado');
const { sanitizeHtml, summarizeUpdates } = require('./sanitize');
const { mapRelatedLinks } = require('./related-links');

function requireAzureScope(item) {
  if (!config.isConfigured()) throw new Error('Configure Azure DevOps in Settings before loading live work-item activity.');
  if (item.source_scope !== config.orgUrl) {
    throw new Error('This item belongs to a different Azure DevOps organization. Connect that organization in Settings to load its activity.');
  }
}

const azureDevOps = {
  id: 'azure-devops',
  label: 'Azure DevOps',
  isConfigured: () => config.isConfigured(),
  scope: () => config.orgUrl,
  runSync: () => require('./azure-sync').runSync(),
  syncStatus: () => require('./azure-sync').syncStatus(),
  async getHistory(item) {
    requireAzureScope(item);
    return summarizeUpdates(await ado.getUpdates(item.external_id));
  },
  async getRelatedLinks(item) {
    requireAzureScope(item);
    return mapRelatedLinks(await ado.getRelations(item.external_id), item);
  },
  sanitizeRichText: sanitizeHtml,
};

const providers = new Map([[azureDevOps.id, azureDevOps]]);

function getProvider(id) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unsupported provider: ${id}`);
  return provider;
}

function listProviders() {
  return [...providers.values()].map((provider) => ({
    id: provider.id, label: provider.label, configured: provider.isConfigured(),
  }));
}

function describeItem(item) {
  return { ...item, provider_label: getProvider(item.provider).label };
}

module.exports = { getProvider, listProviders, describeItem };
