'use strict';

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function mapRelatedLinks(relations, item) {
  const scope = new URL(item.source_scope);
  const root = scope.pathname.replace(/\/+$/, '');
  const itemUrl = `${item.source_scope}/${encodeURIComponent(item.project)}/_workitems/edit/${encodeURIComponent(item.external_id)}`;
  return (relations || []).filter((relation) => relation.rel !== 'AttachedFile').map((relation) => {
    const attributes = relation.attributes || {};
    const link = {
      type: attributes.name || relation.rel || 'Link',
      title: attributes.name || 'Related link',
      url: null,
      comment: attributes.comment || '',
      updated: attributes.resourceModifiedDate || attributes.resourceCreatedDate || null,
      note: '',
    };
    const source = String(relation.url || '');
    if (relation.rel === 'Hyperlink') {
      link.title = source;
      link.url = safeWebUrl(source);
    } else if (relation.rel?.startsWith('System.LinkTypes.')) {
      const webUrl = safeWebUrl(source);
      const url = webUrl ? new URL(webUrl) : null;
      const match = url && url.origin === scope.origin && url.pathname.startsWith(root + '/')
        && url.pathname.slice(root.length).match(/^\/(?:([^/]+)\/)?_apis\/wit\/workitems\/(\d+)$/i);
      if (match) {
        link.title = `Work item ${match[2]}`;
        link.url = `${item.source_scope}/${match[1] ? match[1] + '/' : ''}_workitems/edit/${match[2]}`;
      }
    } else if (relation.rel === 'ArtifactLink') {
      let artifact;
      try {
        artifact = decodeURIComponent(source);
      } catch {
        link.note = 'This link has an invalid artifact reference.';
      }
      const git = artifact?.match(/^vstfs:\/\/\/Git\/(Commit|PullRequestId)\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f]{40}|\d+)$/i);
      const github = artifact?.match(/^vstfs:\/\/\/GitHub\/(Commit|PullRequest|Issue)\/([0-9a-f-]{36})\/([0-9a-f]{40}|\d+)$/i);
      if (git && ((git[1] === 'Commit' && /^[0-9a-f]{40}$/i.test(git[4]))
        || (git[1] === 'PullRequestId' && /^\d+$/.test(git[4])))) {
        const commit = git[1] === 'Commit';
        link.type = commit ? 'Commit' : 'Pull Request';
        link.title = commit ? `Commit ${git[4].slice(0, 8)}` : `Pull request ${git[4]}`;
        link.url = `${item.source_scope}/${git[2]}/_git/${git[3]}/${commit ? 'commit' : 'pullrequest'}/${git[4]}`;
      } else {
        if (github) {
          link.type = `GitHub ${github[1] === 'PullRequest' ? 'Pull Request' : github[1]}`;
          link.title = github[1] === 'Commit' ? `Commit ${github[3].slice(0, 8)}` : `${github[1] === 'Issue' ? 'Issue' : 'Pull request'} #${github[3]}`;
        }
        link.url = itemUrl;
        link.note = 'Open this work item in Azure DevOps to follow this artifact link. Its direct web address is not provided by the work-item API.';
      }
    }
    if (!link.url && !link.note) link.note = 'This link has no supported web address.';
    return link;
  });
}

module.exports = { mapRelatedLinks };
