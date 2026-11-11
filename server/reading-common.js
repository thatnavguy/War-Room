'use strict';

const crypto = require('crypto');
const posix = require('path').posix;

const LIMITS = { page: 2 * 1024 * 1024, image: 8 * 1024 * 1024, response: 64 * 1024 * 1024, files: 4000, searchPages: 500 };

class ReadingError extends Error {
  constructor(message, status = 502, staleAllowed = false) {
    super(message);
    this.status = status;
    this.staleAllowed = staleAllowed;
  }
}

function text(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ReadingError(`Invalid ${name}.`, 400);
  }
  return value.trim();
}

function canonical(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\\\u0000-\u001f\u007f?#]/.test(value) || /%(?:2f|5c|2e|00)/i.test(value)) {
    throw new ReadingError('Invalid wiki path.', 400);
  }
  const parts = value.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) throw new ReadingError('Wiki path traversal is not allowed.', 400);
  return '/' + parts.join('/');
}

function resolveRelative(current, href) {
  let decoded;
  try { decoded = decodeURIComponent(href); } catch { throw new ReadingError('Invalid link encoding.', 400); }
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) throw new ReadingError('Invalid wiki link.', 400);
  const parts = decoded.startsWith('/') ? [] : posix.dirname(current).split('/').filter(Boolean);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new ReadingError('Wiki link escapes the root.', 400);
      parts.pop();
    } else parts.push(part);
  }
  return canonical('/' + parts.join('/'));
}

function context(config, provider) {
  if (!['azure-devops', 'github'].includes(provider)) throw new ReadingError('Unknown provider.', 400);
  let scope;
  if (provider === 'azure-devops') {
    if (!config.orgUrl || !config.authHeader) throw new ReadingError('Configure Azure DevOps credentials with Wiki (Read), Code (Read), and Project and Team (Read) access.', 409);
    let url;
    try { url = new URL(config.orgUrl); } catch { throw new ReadingError('Invalid configured Azure DevOps organization URL.', 409); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /%|\\/.test(url.pathname)) {
      throw new ReadingError('Use an HTTPS Azure DevOps organization URL without credentials or query parameters.', 409);
    }
    scope = url.href.replace(/\/+$/, '');
  } else {
    if (!config.ghToken) throw new ReadingError('Configure a GitHub token with repository read access (classic PAT repo scope for private wikis; fine-grained tokens may not support wiki Git access). Authorize organization SSO when required.', 409);
    const host = config.ghHost || 'github.com';
    if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw new ReadingError('Invalid configured GitHub host.', 409);
    scope = `https://${host.toLowerCase()}`;
  }
  const fingerprint = crypto.createHash('sha256').update(`${scope}\0${provider === 'github' ? config.ghToken : config.authHeader}`).digest('hex');
  return { scope, fingerprint };
}

function sourceError(provider, status) {
  const help = provider === 'github'
    ? 'GitHub requires repository read access (classic PAT repo scope for private wikis) and organization SSO authorization when required. Enable the wiki and publish its first page in GitHub. Fine-grained tokens may not support wiki Git access.'
    : 'Azure DevOps requires Wiki (Read), Code (Read), Project and Team (Read), and access to this project/wiki.';
  if ([401, 403, 404].includes(status)) return new ReadingError(`Source returned ${status}. ${help}`, status);
  return new ReadingError(`Source returned ${status}. ${help}`, status === 429 ? 429 : 502, status === 429 || status >= 500);
}

async function boundedResponse(response, max) {
  if (Number(response.headers.get('content-length')) > max) throw new ReadingError('Source response exceeds the Reading Room size limit.', 413);
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > max) {
        await response.body.cancel?.().catch(() => {});
        throw new ReadingError('Source response exceeds the Reading Room size limit.', 413);
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}

function createRequest(config, fetchImpl = global.fetch) {
  return async function request(provider, address, { max = LIMITS.response, method = 'GET', body, git = false, accept } = {}) {
    const { scope } = context(config, provider);
    const url = new URL(address);
    const base = new URL(scope);
    const expectedOrigin = provider === 'github' && !git && base.hostname === 'github.com' ? 'https://api.github.com' : base.origin;
    if (url.origin !== expectedOrigin || url.username || url.password || url.hash ||
        (provider === 'azure-devops' && !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/'))) {
      throw new ReadingError('Refused a source URL outside the configured host/organization.', 400);
    }
    if (method !== 'GET' && !(git && method === 'POST' && url.pathname.endsWith('/git-upload-pack'))) {
      throw new ReadingError('Only read-only source requests are permitted.', 400);
    }
    if (git && !/^\/[^/]+\/[^/]+\.wiki\.git\/(?:info\/refs|git-upload-pack)$/.test(url.pathname)) {
      throw new ReadingError('Invalid wiki Git endpoint.', 400);
    }
    const headers = {
      Authorization: provider === 'azure-devops' ? config.authHeader : git
        ? 'Basic ' + Buffer.from('x-access-token:' + config.ghToken).toString('base64')
        : 'Bearer ' + config.ghToken,
      Accept: accept || (git ? '*/*' : 'application/json'),
    };
    if (git && method === 'POST') headers['Content-Type'] = 'application/x-git-upload-pack-request';
    try {
      const response = await fetchImpl(url.href, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
      if (response.status >= 300 && response.status < 400) throw new ReadingError('Source redirected the request. Redirects are blocked to protect credentials; check the configured host.', 502);
      if (!response.ok) throw sourceError(provider, response.status);
      return { bytes: await boundedResponse(response, max), headers: response.headers };
    } catch (error) {
      if (error instanceof ReadingError) throw error;
      throw new ReadingError('The source could not be reached. Check the network and configured host.', 502, true);
    }
  };
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new ReadingError('Only PNG, JPEG, GIF, and WebP wiki images are supported. SVG and HTML are blocked.', 415);
}

module.exports = { ReadingError, LIMITS, text, canonical, resolveRelative, context, sourceError, createRequest, imageType };
