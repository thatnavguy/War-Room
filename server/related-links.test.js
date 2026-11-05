'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapRelatedLinks } = require('./related-links');

const item = { source_scope: 'https://dev.azure.com/example', project: 'Project A', external_id: '42' };
const project = '11111111-1111-1111-1111-111111111111';
const repository = '22222222-2222-2222-2222-222222222222';
const commit = 'a'.repeat(40);

test('maps work item relations, commits, pull requests, web links and excludes attachments', () => {
  const links = mapRelatedLinks([
    { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${item.source_scope}/Project%20A/_apis/wit/workItems/7`, attributes: { name: 'Parent', comment: 'Context' } },
    { rel: 'ArtifactLink', url: `vstfs:///Git/Commit/${project}%2f${repository}%2f${commit}`, attributes: { resourceModifiedDate: '2026-01-01' } },
    { rel: 'ArtifactLink', url: `vstfs:///Git/PullRequestId/${project}%2F${repository}%2F123` },
    { rel: 'Hyperlink', url: 'https://example.org/info', attributes: { name: 'Hyperlink' } },
    { rel: 'AttachedFile', url: 'https://example.org/file' },
  ], item);
  assert.equal(links.length, 4);
  assert.equal(links[0].url, `${item.source_scope}/Project%20A/_workitems/edit/7`);
  assert.equal(links[0].type, 'Parent');
  assert.equal(links[0].comment, 'Context');
  assert.equal(links[1].url, `${item.source_scope}/${project}/_git/${repository}/commit/${commit}`);
  assert.equal(links[1].updated, '2026-01-01');
  assert.equal(links[2].url, `${item.source_scope}/${project}/_git/${repository}/pullrequest/123`);
  assert.equal(links[3].url, 'https://example.org/info');
});

test('GitHub artifact references stay visible with an explicit Azure DevOps fallback', () => {
  const links = mapRelatedLinks([
    { rel: 'ArtifactLink', url: `vstfs:///GitHub/PullRequest/${repository}%2f80` },
    { rel: 'ArtifactLink', url: `vstfs:///GitHub/Commit/${repository}%2f${commit}` },
    { rel: 'ArtifactLink', url: 'vstfs:///Unknown/Artifact/reference' },
  ], item);
  assert.equal(links[0].title, 'Pull request #80');
  assert.equal(links[0].type, 'GitHub Pull Request');
  assert.equal(links[1].title, 'Commit aaaaaaaa');
  for (const link of links) {
    assert.equal(link.url, `${item.source_scope}/Project%20A/_workitems/edit/42`);
    assert.match(link.note, /direct web address is not provided/);
  }
});

test('unsafe web schemes, credentials, foreign work item URLs and malformed artifacts do not become unsafe anchors', () => {
  const links = mapRelatedLinks([
    { rel: 'Hyperlink', url: 'javascript:alert(1)' },
    { rel: 'Hyperlink', url: 'data:text/html,test' },
    { rel: 'Hyperlink', url: 'https://user:password@example.org/' },
    { rel: 'System.LinkTypes.Related', url: 'https://evil.example/_apis/wit/workItems/7' },
    { rel: 'ArtifactLink', url: 'vstfs:///Git/Commit/%broken' },
  ], item);
  assert.ok(links.slice(0, 4).every((link) => link.url === null && link.note));
  assert.match(links[4].url, /^https:\/\/dev.azure.com\/example\//);
  assert.ok(links[4].note);
  assert.deepEqual(mapRelatedLinks([], item), []);
});
