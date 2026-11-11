'use strict';

const config = require('./config');

const API_VERSION = '7.1';
const BATCH_SIZE = 200;

function imageAttachmentUrl(source) {
  if (typeof source !== 'string' || !config.orgUrl) return null;
  let url;
  let org;
  try {
    url = new URL(source);
    org = new URL(config.orgUrl);
  } catch {
    return null;
  }
  const root = org.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || url.origin !== org.origin || url.username || url.password ||
      !url.pathname.startsWith(root + '/')) return null;
  const path = url.pathname.slice(root.length);
  if (!/^\/(?:[a-z0-9._~%-]+\/)?_apis\/wit\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path) ||
      /%2f|%5c|%2e/i.test(path)) return null;
  return `${org.origin}${root}${path}?api-version=${API_VERSION}`;
}

async function getImageAttachment(source) {
  const url = imageAttachmentUrl(source);
  if (!url) throw new Error('Only image attachments from the configured Azure DevOps organization are supported.');
  const res = await fetch(url, {
    headers: { Authorization: config.authHeader, Accept: 'image/*' },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Could not load the Azure DevOps screenshot (${res.status}).`);
  const declaredType = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(declaredType)) {
    await res.body?.cancel();
    throw new Error('The attachment is not a supported screenshot image.');
  }
  const limit = 20 * 1024 * 1024;
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('The screenshot exceeds the 20 MB preview limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  const data = Buffer.concat(chunks);
  let contentType;
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) contentType = 'image/png';
  else if (data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) contentType = 'image/jpeg';
  else if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) contentType = 'image/gif';
  else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') contentType = 'image/webp';
  else if (data.subarray(0, 2).toString('ascii') === 'BM') contentType = 'image/bmp';
  if (!contentType) throw new Error('The attachment is not a supported screenshot image.');
  return { contentType, data };
}

async function adoFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${config.orgUrl}/${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: config.authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ADO request failed ${res.status} ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function getMyIdentity() {
  const data = await adoFetch(`_apis/connectionData?api-version=${API_VERSION}-preview.1`);
  const user = data.authenticatedUser || {};
  return {
    id: user.id,
    displayName: user.providerDisplayName || user.customDisplayName || '',
  };
}

async function runWiql(wiql) {
  const scope = config.projects.length === 1 ? `${encodeURIComponent(config.projects[0])}/` : '';
  const data = await adoFetch(`${scope}_apis/wit/wiql?api-version=${API_VERSION}&$top=10000`, {
    method: 'POST',
    body: { query: wiql },
  });
  return (data.workItems || []).map((w) => w.id);
}

function projectClause() {
  if (config.projects.length === 0) return '';
  const list = config.projects.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
  return ` AND [System.TeamProject] IN (${list})`;
}

async function queryEverAssigned() {
  return runWiql(
    `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] EVER @Me${projectClause()}`
  );
}

async function queryCreatedByMe() {
  return runWiql(
    `SELECT [System.Id] FROM WorkItems WHERE [System.CreatedBy] = @Me${projectClause()}`
  );
}

async function queryChangedByMe() {
  return runWiql(
    `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedBy] = @Me${projectClause()}`
  );
}

async function queryChangedSince(isoDate) {
  return runWiql(
    `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= '${isoDate}'${projectClause()}`
  );
}

async function getGitRepositories() {
  const projectScopes = config.projects.length > 0 ? config.projects : [null];
  const repositories = await Promise.all(projectScopes.map(async (project) => {
    const scope = project ? `${encodeURIComponent(project)}/` : '';
    const data = await adoFetch(`${scope}_apis/git/repositories?api-version=${API_VERSION}`);
    return data.value || [];
  }));
  return [...new Map(repositories.flat().filter((repository) => repository.id).map((repository) =>
    [repository.id.toLowerCase(), repository])).values()];
}

async function getPullRequests(repositoryId, identityId, role) {
  if (!['creatorId', 'reviewerId'].includes(role)) throw new Error('Unsupported pull request search role.');
  const pageSize = 1000;
  const results = [];
  for (let skip = 0; ; skip += pageSize) {
    const params = new URLSearchParams({
      'searchCriteria.status': 'all',
      [`searchCriteria.${role}`]: identityId,
      '$top': String(pageSize),
      '$skip': String(skip),
      'api-version': API_VERSION,
    });
    const data = await adoFetch(
      `_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests?${params}`
    );
    const page = data.value || [];
    results.push(...page);
    if (page.length < pageSize) break;
  }
  return results;
}

async function getPullRequest(repositoryId, pullRequestId) {
  return adoFetch(
    `_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${encodeURIComponent(pullRequestId)}?api-version=${API_VERSION}`
  );
}

async function getPullRequestThreads(repositoryId, pullRequestId) {
  const data = await adoFetch(
    `_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${encodeURIComponent(pullRequestId)}/threads?api-version=${API_VERSION}`
  );
  return data.value || [];
}

const FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.AssignedTo',
  'System.CreatedBy',
  'System.CreatedDate',
  'System.ChangedBy',
  'System.ChangedDate',
  'System.Tags',
  'System.AreaPath',
  'System.IterationPath',
  'System.TeamProject',
  'System.Description',
  'System.History',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
  'Microsoft.VSTS.TCM.ReproSteps',
];

async function getWorkItems(ids) {
  if (ids.length === 0) return [];
  const metadata = await adoFetch(`_apis/wit/fields?api-version=${API_VERSION}`);
  const priorityField = (metadata.value || []).find((field) => field.name === 'Priority Level');
  const dueDateField = (metadata.value || []).find((field) =>
    field.referenceName === 'Microsoft.VSTS.Scheduling.DueDate') ||
    (metadata.value || []).find((field) => field.type === 'dateTime' && field.name.toLowerCase() === 'due date');
  const fields = [...FIELDS, 'Microsoft.VSTS.Common.Priority'];
  if (priorityField) fields.push(priorityField.referenceName);
  if (dueDateField) fields.push(dueDateField.referenceName);
  const results = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const data = await adoFetch(
      `_apis/wit/workitemsbatch?api-version=${API_VERSION}&$expand=relations`,
      { method: 'POST', body: { ids: batch, fields } }
    );
    results.push(...(data.value || []).map((item) => {
      const value = priorityField && item.fields?.[priorityField.referenceName];
      const standard = item.fields?.['Microsoft.VSTS.Common.Priority'];
      return {
        ...item,
        due_date: (dueDateField && item.fields?.[dueDateField.referenceName]) || null,
        priority_level: value != null && String(value).trim() !== ''
          ? String(value) : (standard == null ? null : String(standard)),
      };
    }));
  }
  return results;
}

async function getUpdates(workItemId) {
  const data = await adoFetch(
    `_apis/wit/workItems/${workItemId}/updates?api-version=${API_VERSION}`
  );
  return data.value || [];
}

async function getRelations(workItemId) {
  const item = await adoFetch(
    `_apis/wit/workitems/${encodeURIComponent(workItemId)}?$expand=relations&api-version=${API_VERSION}`
  );
  return item.relations || [];
}

async function getAttachments(workItemId) {
  return (await getRelations(workItemId))
    .filter((relation) => relation.rel === 'AttachedFile')
    .map((relation) => {
      const name = relation.attributes?.name || 'Attachment';
      const url = imageAttachmentUrl(relation.url);
      const size = relation.attributes?.resourceSize;
      return {
        name,
        url: url ? `${url}&fileName=${encodeURIComponent(name)}&download=true` : null,
        preview_url: url && /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)
          ? `/api/attachments/image?url=${encodeURIComponent(url)}` : null,
        size: Number.isFinite(size) && size >= 0 ? size : null,
      };
    });
}

module.exports = {
  imageAttachmentUrl,
  getImageAttachment,
  getMyIdentity,
  queryEverAssigned,
  queryCreatedByMe,
  queryChangedByMe,
  queryChangedSince,
  getGitRepositories,
  getPullRequests,
  getPullRequest,
  getPullRequestThreads,
  getWorkItems,
  getUpdates,
  getRelations,
  getAttachments,
};
