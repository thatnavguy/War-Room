'use strict';

const config = require('./config');
const ado = require('./ado');
const { sanitizeHtml, summarizeUpdates } = require('./sanitize');
const { mapRelatedLinks } = require('./related-links');
const { renderMarkdown } = require('./markdown');

function parsePullRequestId(externalId) {
  const match = String(externalId).match(/^pr:([0-9a-f-]{36}):(\d+)$/i);
  return match ? { repositoryId: match[1], pullRequestId: match[2] } : null;
}

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
    const pullRequest = parsePullRequestId(item.external_id);
    if (pullRequest) {
      const threads = await ado.getPullRequestThreads(pullRequest.repositoryId, pullRequest.pullRequestId);
      return threads.flatMap((thread) => (thread.comments || [])
        .filter((comment) => !comment.isDeleted && (!comment.commentType || comment.commentType === 'text'))
        .map((comment) => ({
          rev: comment.id || thread.id,
          date: comment.publishedDate || comment.lastUpdatedDate || null,
          by: comment.author?.displayName || '',
          comment: renderMarkdown(comment.content || ''),
          changes: [],
        })))
        .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    }
    const meId = require('./db').getSyncState('meId', 'azure-devops', item.source_scope);
    return summarizeUpdates(await ado.getUpdates(item.external_id), meId || '');
  },
  async getRelatedLinks(item) {
    requireAzureScope(item);
    if (parsePullRequestId(item.external_id)) return [];
    return mapRelatedLinks(await ado.getRelations(item.external_id), item);
  },
  async getAttachments(item) {
    requireAzureScope(item);
    if (parsePullRequestId(item.external_id)) return [];
    return ado.getAttachments(item.external_id);
  },
  sanitizeRichText(html, item) {
    const meId = item ? require('./db').getSyncState('meId', 'azure-devops', item.source_scope) : '';
    if (item && parsePullRequestId(item.external_id)) return renderMarkdown(html, meId || '');
    return sanitizeHtml(html, meId || '');
  },
};

function requireGitHubScope(item) {
  if (!config.isGitHubConfigured()) throw new Error('Connect GitHub in Settings before loading live issue activity.');
  if (!item.source_scope.startsWith(`${config.ghHost}/`)) {
    throw new Error('This item belongs to a different GitHub host. Connect that host in Settings to load its activity.');
  }
}

const githubProvider = {
  id: 'github',
  label: 'GitHub',
  isConfigured: () => config.isGitHubConfigured(),
  scope: () => config.ghHost,
  runSync: () => require('./github-sync').runSync(),
  syncStatus: () => require('./github-sync').syncStatus(),
  async getHistory(item) {
    requireGitHubScope(item);
    const meLogin = require('./db').getSyncState('meDisplayName', 'github', item.source_scope) || '';
    return require('./github-sync').getHistory(item, meLogin);
  },
  async getRelatedLinks(item) {
    requireGitHubScope(item);
    return [];
  },
  async getAttachments(item) {
    requireGitHubScope(item);
    return [];
  },
  sanitizeRichText(markdown, item) {
    const meLogin = item ? require('./db').getSyncState('meDisplayName', 'github', item.source_scope) : '';
    return require('./markdown').renderMarkdown(markdown, meLogin || '', {
      githubImages: true, githubHost: config.ghHost,
    });
  },
};

const providers = new Map([[azureDevOps.id, azureDevOps], [githubProvider.id, githubProvider]]);

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
  const pullRequest = item.provider === 'azure-devops' ? parsePullRequestId(item.external_id) : null;
  return {
    ...item,
    ...(pullRequest ? { external_id: item.external_id.match(/:(\d+)$/)[1] } : {}),
    provider_label: getProvider(item.provider).label,
    my_display_name: require('./db').getSyncState('meDisplayName', item.provider, item.source_scope) || '',
  };
}

module.exports = { getProvider, listProviders, describeItem };
