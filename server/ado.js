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
  const fields = [...FIELDS, 'Microsoft.VSTS.Common.Priority'];
  if (priorityField) fields.push(priorityField.referenceName);
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
      return { ...item, priority_level: value != null && String(value).trim() !== ''
        ? String(value) : (standard == null ? null : String(standard)) };
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

module.exports = {
  imageAttachmentUrl,
  getImageAttachment,
  getMyIdentity,
  queryEverAssigned,
  queryCreatedByMe,
  queryChangedByMe,
  queryChangedSince,
  getWorkItems,
  getUpdates,
};
