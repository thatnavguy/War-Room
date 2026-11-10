'use strict';

const { imageAttachmentUrl } = require('./ado');
const { mentionId } = require('./mentions');

// Minimal HTML allowlist sanitizer for ADO rich-text fields.
// Keeps basic formatting + links, drops scripts, handlers, iframes, styles.

const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'a', 'hr', 'img',
]);

const ALLOWED_ATTRS = { a: new Set(['href']) };

function sanitizeHtml(html, identityId = '') {
  if (!html) return '';
  let out = String(html);

  // Drop dangerous containers entirely (content included)
  out = out.replace(/<(script|style|iframe|object|embed|form|svg|math)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<(script|style|iframe|object|embed|form|svg|math)[^>]*\/?>/gi, '');

  // Rebuild every tag, keeping only allowlisted tags/attributes
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*\/?>/g, (match, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    const closing = match.startsWith('</');
    if (closing) return `</${t}>`;

    if (t === 'br' || t === 'hr') return `<${t}>`;

    if (t === 'img') {
      const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const source = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '') : '';
      const url = imageAttachmentUrl(source);
      if (!url) return '<span>Screenshot unavailable: unsupported image source.</span>';
      return `<img src="/api/attachments/image?url=${encodeURIComponent(url)}" alt="Work-item screenshot" loading="lazy">`;
    }

    if (t === 'a' && attrs) {
      const hrefMatch = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const href = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '') : '';
      if (/^\s*javascript:/i.test(href)) return '<a>';
      const safe = href.replace(/"/g, '&quot;');
      const ownMention = identityId && mentionId(attrs) === identityId.toLowerCase();
      return `<a href="${safe}"${ownMention ? ' class="my-name"' : ''} target="_blank" rel="noopener noreferrer">`;
    }
    return `<${t}>`;
  });

  return out;
}

// Field ref name -> short human label
function friendlyFieldName(refName) {
  const map = {
    'System.State': 'State',
    'System.AssignedTo': 'Assigned to',
    'System.Title': 'Title',
    'System.Tags': 'Tags',
    'System.IterationPath': 'Iteration',
    'System.AreaPath': 'Area',
    'System.History': 'Comment added',
    'System.Description': 'Description',
    'Microsoft.VSTS.Common.Priority': 'Priority',
    'Microsoft.VSTS.Common.AcceptanceCriteria': 'Acceptance criteria',
    'Microsoft.VSTS.TCM.ReproSteps': 'Repro steps',
    'Microsoft.VSTS.Common.StateChangeDate': 'State changed',
    'Microsoft.VSTS.Common.ActivatedDate': 'Activated',
    'Microsoft.VSTS.Common.ActivatedBy': 'Activated by',
    'Microsoft.VSTS.Common.ResolvedDate': 'Resolved',
    'Microsoft.VSTS.Common.ResolvedBy': 'Resolved by',
    'Microsoft.VSTS.Common.ClosedDate': 'Closed',
    'Microsoft.VSTS.Common.ClosedBy': 'Closed by',
    'System.Reason': 'Reason',
  };
  if (map[refName]) return map[refName];
  const short = refName.split('.').pop();
  return short.replace(/([a-z])([A-Z])/g, '$1 $2');
}

const NOISE_FIELDS = new Set([
  'System.Rev', 'System.Watermark', 'System.AuthorizedDate', 'System.AuthorizedAs',
  'System.PersonId', 'System.ChangedDate', 'System.ChangedBy', 'System.Id',
  'System.AreaId', 'System.IterationId', 'System.AreaLevel1', 'System.AreaLevel2',
  'System.AreaLevel3', 'System.AreaLevel4', 'System.IterationLevel1', 'System.IterationLevel2',
  'System.IterationLevel3', 'System.IterationLevel4', 'System.CommentCount',
  'System.CreatedDate', 'System.CreatedBy', 'System.IsDeleted', 'System.TeamProject',
  'System.NodeName', 'System.WorkItemType',
]);

function personName(identity) {
  if (!identity) return null;
  if (typeof identity === 'string') return identity;
  return identity.displayName || identity.uniqueName || null;
}

function fieldValueText(v) {
  if (v == null) return null;
  if (typeof v === 'object') return personName(v) || JSON.stringify(v);
  return String(v);
}

function activityDate(update) {
  const dates = [
    update.revisedDate,
    update.fields?.['System.ChangedDate']?.newValue,
  ];
  return dates.find((date) =>
    typeof date === 'string' && !date.startsWith('9999') && Number.isFinite(Date.parse(date))) || null;
}

// updates: raw array from ADO updates endpoint
function summarizeUpdates(updates, identityId = '') {
  const result = [];
  for (const u of updates || []) {
    const fields = u.fields || {};
    const comment = fields['System.History'] && fields['System.History'].newValue != null
      ? sanitizeHtml(fields['System.History'].newValue, identityId)
      : null;

    const changes = [];
    for (const [ref, change] of Object.entries(fields)) {
      if (ref === 'System.History') continue;
      if (NOISE_FIELDS.has(ref)) continue;
      const oldV = fieldValueText(change.oldValue);
      const newV = fieldValueText(change.newValue);
      if (oldV == null && newV == null) continue;
      changes.push({ field: friendlyFieldName(ref), from: oldV, to: newV });
    }

    result.push({
      rev: u.rev,
      date: activityDate(u),
      by: personName(u.revisedBy),
      comment,
      changes,
    });
  }
  result.sort((a, b) => (a.date < b.date ? 1 : -1));
  return result;
}

module.exports = { sanitizeHtml, summarizeUpdates };
