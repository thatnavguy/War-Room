'use strict';

const $ = (sel) => document.querySelector(sel);

const TOUCH_LABELS = {
  assigned: 'Assigned to me (now or previously)',
  created: 'Created by me',
  edited: 'Edited by me',
  commented: 'Commented by me',
};

function fmtDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString();
}

function showRichText(sectionSel, targetSel, html) {
  if (!html || !html.trim()) return;
  $(sectionSel).hidden = false;
  renderRichText($(targetSel), html);
}

function renderRichText(target, html) {
  target.innerHTML = html;
  for (const image of target.querySelectorAll('img')) {
    image.addEventListener('error', () => {
      const message = document.createElement('p');
      message.className = 'image-error';
      message.textContent = 'Could not load this screenshot. Check the Azure DevOps connection in Settings, then reload this page.';
      image.replaceWith(message);
    }, { once: true });
  }
}

async function load() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    $('#item-title').textContent = 'No work item selected';
    $('#history-status').textContent = 'Return to My work and select an item to see its details.';
    return;
  }

  const res = await fetch(`/api/items/${id}`);
  if (!res.ok) {
    $('#item-title').textContent = 'Item not found';
    $('#history-status').textContent = 'This work item is not in your local tracker. Return to My work and sync if you expect it to appear.';
    return;
  }
  const item = await res.json();

  document.title = `${item.id} — Mission Hall`;
  $('#item-title').textContent = `${item.type} ${item.id}: ${item.title}`;
  if (item.url) {
    $('#ado-link').href = item.url;
    $('#ado-link').hidden = false;
  }

  const fields = [
    ['ID', item.id],
    ['Type', item.type],
    ['State', item.state],
    ['Project', item.project],
    ['Assigned to', item.assigned_to],
    ['Created by', item.created_by],
    ['Created', fmtDate(item.created_date)],
    ['Changed by', item.changed_by],
    ['Changed', fmtDate(item.changed_date)],
    ['Iteration', item.iteration_path],
    ['Area', item.area_path],
    ['Tags', item.tags],
  ];

  const detail = $('#detail');
  for (const [label, value] of fields) {
    const div = document.createElement('div');
    const lbl = document.createElement('span');
    lbl.className = 'field-label';
    lbl.textContent = label;
    const val = document.createElement('span');
    val.textContent = value == null || value === '' ? '–' : value;
    div.append(lbl, val);
    detail.appendChild(div);
  }

  const touches = $('#touches');
  for (const t of item.touches || []) {
    const li = document.createElement('li');
    li.textContent = TOUCH_LABELS[t.touch_type] || t.touch_type;
    if (t.touched_at) li.textContent += ` · ${fmtDate(t.touched_at)}`;
    touches.appendChild(li);
  }
  $('#touches-empty').hidden = touches.childElementCount > 0;

  showRichText('#sec-description', '#description', item.description);
  showRichText('#sec-acceptance', '#acceptance', item.acceptance_criteria);
  showRichText('#sec-repro', '#repro', item.repro_steps);

  if (item.type === 'Bug') {
    $('#desc-heading').textContent = 'Description';
  }

  if (item.attachments && item.attachments.length > 0) {
    $('#sec-attachments').hidden = false;
    const ul = $('#attachments');
    for (const att of item.attachments) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = att.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = att.name;
      li.appendChild(a);
      ul.appendChild(li);
    }
  }

  const sectionNav = $('#item-sections');
  for (const link of sectionNav.querySelectorAll('a:not(#ado-link)')) {
    const section = $(link.getAttribute('href'));
    link.hidden = section.hidden;
    section.tabIndex = -1;
  }
  sectionNav.hidden = false;
  await loadHistory(id);
}

async function loadHistory(id) {
  const status = $('#history-status');
  try {
    const res = await fetch(`/api/items/${id}/history`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load history');

    const list = $('#history-list');
    const revs = data.revisions || [];
    list.replaceChildren();

    for (const r of revs) {
      const li = document.createElement('li');
      li.className = 'history-entry';
      li.dataset.hasComment = 'false';

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const who = document.createElement('strong');
      who.textContent = r.by || 'Unknown';
      const when = document.createElement('span');
      when.className = 'muted';
      when.textContent = ` · ${fmtDate(r.date)} · rev ${r.rev}`;
      meta.append(who, when);
      li.appendChild(meta);

      if (r.comment) {
        const c = document.createElement('div');
        c.className = 'history-comment rich-text';
        renderRichText(c, r.comment);
        li.dataset.hasComment = String(Boolean(c.textContent.trim() || c.querySelector('img')));
        li.appendChild(c);
      }

      if (r.changes && r.changes.length > 0) {
        const ul = document.createElement('ul');
        ul.className = 'history-changes';
        for (const ch of r.changes) {
          const cli = document.createElement('li');
          const fname = document.createElement('span');
          fname.className = 'change-field';
          fname.textContent = ch.field;
          cli.appendChild(fname);
          if (ch.from != null && ch.to != null) {
            cli.append(`: ${trunc(ch.from)} → ${trunc(ch.to)}`);
          } else if (ch.to != null) {
            cli.append(`: ${trunc(ch.to)}`);
          } else {
            cli.append(': cleared');
          }
          ul.appendChild(cli);
        }
        li.appendChild(ul);
      }

      list.appendChild(li);
    }
    list.dataset.loaded = 'true';
    filterHistory();
  } catch (err) {
    status.textContent = err.message;
  }
}

function filterHistory() {
  const list = $('#history-list');
  if (list.dataset.loaded !== 'true') return;
  const commentsOnly = $('#comments-only').checked;
  let visible = 0;
  for (const entry of list.children) {
    entry.hidden = commentsOnly && entry.dataset.hasComment !== 'true';
    if (!entry.hidden) visible++;
    const changes = entry.querySelector('.history-changes');
    if (changes) changes.hidden = commentsOnly;
  }
  $('#history-status').textContent = visible === 0
    ? (commentsOnly ? 'No comments on this work item.' : 'No revisions.')
    : `${visible} ${commentsOnly ? (visible === 1 ? 'comment' : 'comments') : (visible === 1 ? 'revision' : 'revisions')}`;
}

$('#comments-only').addEventListener('change', filterHistory);

function trunc(s) {
  const t = String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}

load().catch((err) => {
  $('#history-status').textContent = `Could not load this work item: ${err.message}`;
});
