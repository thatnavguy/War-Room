'use strict';

function mentionId(attributes) {
  const value = attributes.match(/(?:^|\s)data-vss-mention\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!value) return null;
  const id = (value[1] ?? value[2] ?? value[3]).match(/^version:2\.0,([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return id ? id[1].toLowerCase() : null;
}

function mentionsMe(html, identityId) {
  if (!identityId || !html) return false;
  const content = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  return [...content.matchAll(/<a\b([^<>]*)>/gi)]
    .some((match) => mentionId(match[1]) === identityId.toLowerCase());
}

function latestMention(updates, identityId) {
  const dates = (updates || []).filter((update) =>
    mentionsMe(update.fields?.['System.History']?.newValue, identityId))
    .map((update) => update.fields?.['System.ChangedDate']?.newValue || update.revisedDate)
    .filter((date) => typeof date === 'string' && date < '9999' && Number.isFinite(Date.parse(date)));
  return dates.sort().pop() || null;
}

function latestCommentMentionsMe(updates, identityId) {
  const comments = (updates || []).filter((update) =>
    String(update.fields?.['System.History']?.newValue || '').trim());
  comments.sort((a, b) => Number(a.rev ?? a.id ?? 0) - Number(b.rev ?? b.id ?? 0) ||
    Date.parse(a.fields?.['System.ChangedDate']?.newValue || a.revisedDate) -
    Date.parse(b.fields?.['System.ChangedDate']?.newValue || b.revisedDate));
  return mentionsMe(comments.at(-1)?.fields?.['System.History']?.newValue, identityId);
}

module.exports = { mentionId, mentionsMe, latestMention, latestCommentMentionsMe };
