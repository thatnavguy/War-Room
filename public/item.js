'use strict';

const $ = (sel) => document.querySelector(sel);

let providerLabel = 'the source';

const TOUCH_LABELS = {
  assigned: 'Assigned to me (now or previously)',
  created: 'Created by me',
  edited: 'Edited by me',
  commented: 'Commented by me',
  mentioned: 'Mentioned me in a comment',
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
      message.textContent = image.referrerPolicy === 'no-referrer'
        ? 'Could not load this image. Open the issue in GitHub and check that you can access it.'
        : 'Could not load this screenshot. Check the source connection in Settings, then reload this page.';
      image.replaceWith(message);
    }, { once: true });
  }
}

function setSectionVisible(sectionId, visible) {
  $(`#${sectionId}`).hidden = !visible;
  $(`#item-sections a[href="#${sectionId}"]`).hidden = !visible;
}

async function load() {
  const params = new URLSearchParams(location.search);
  const fromDiscovery = params.get('room') === 'discovery';
  const roomName = fromDiscovery ? 'Discovery Room' : 'Briefing Room';
  $('#room-back-link').href = fromDiscovery ? '/?room=discovery' : '/';
  $('#room-back-label').textContent = roomName;
  const id = params.get('id');
  if (!id) {
    $('#item-title').textContent = 'No work item selected';
    $('#history-status').textContent = `Return to ${roomName} and select an item to see its details.`;
    $('#links-status').textContent = 'Select a work item to see its related links.';
    $('#attachments-status').textContent = 'Select a work item to see its attachments.';
    return;
  }

  const res = await fetch(`/api/items/${id}`);
  if (!res.ok) {
    $('#item-title').textContent = 'Item not found';
    $('#history-status').textContent = `This work item is not in your local tracker. Return to ${roomName} and sync if you expect it to appear.`;
    $('#links-status').textContent = 'Related links are unavailable because this work item is not in your local tracker.';
    $('#attachments-status').textContent = 'Attachments are unavailable because this work item is not in your local tracker.';
    return;
  }
  const item = await res.json();
  providerLabel = item.provider_label || providerLabel;

  document.title = `${item.external_id} — War Room`;
  $('#item-title').textContent = `${item.type} ${item.external_id}: ${item.title}`;
  $('#item-provider').textContent = item.provider_label;
  $('#item-source-caption').textContent = `${item.provider_label} work item`;
  if (item.url) {
    $('#source-link').href = item.url;
    $('#source-link').textContent = `Open in ${item.provider_label} ↗`;
    $('#source-link').hidden = false;
  }

  const fields = [
    ['ID', item.external_id],
    ['Source', item.provider_label],
    ['Priority level', item.priority_level],
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
    ['Labels', item.tags],
  ];

  const detail = $('#detail');
  for (const [label, value] of fields) {
    const div = document.createElement('div');
    const lbl = document.createElement('span');
    lbl.className = 'field-label';
    lbl.textContent = label;
    const val = document.createElement('span');
    val.textContent = value == null || value === '' ? '–' : value;
    if (['Assigned to', 'Created by', 'Changed by'].includes(label) && item.my_display_name && value === item.my_display_name) {
      val.className = 'my-name';
    }
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
  if (fromDiscovery && !(item.touches || []).length) {
    $('#why-heading').textContent = 'Why it appears in Discovery Room';
    $('#touches-empty').textContent = 'No assignment, creation, edit, comment, or mention involving you was recorded. Viewing this item does not add it to Briefing Room.';
  }

  showRichText('#sec-description', '#description', item.description);
  showRichText('#sec-acceptance', '#acceptance', item.acceptance_criteria);
  showRichText('#sec-repro', '#repro', item.repro_steps);

  if (item.type === 'Bug') {
    $('#desc-heading').textContent = 'Description';
  }

  const sectionNav = $('#item-sections');
  for (const link of sectionNav.querySelectorAll('a:not(#source-link)')) {
    const section = $(link.getAttribute('href'));
    link.hidden = section.hidden;
    section.tabIndex = -1;
  }
  sectionNav.hidden = false;
  await Promise.all([loadHistory(id), loadRelatedLinks(id), loadAttachments(id)]);
}

async function loadAttachments(id) {
  const status = $('#attachments-status');
  const list = $('#attachments');
  try {
    const res = await fetch(`/api/items/${id}/attachments`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load attachments');
    list.replaceChildren();
    status.textContent = data.attachments.length
      ? `${data.attachments.length} attachment${data.attachments.length === 1 ? '' : 's'}. File links open in ${providerLabel}.`
      : 'No attachments on this work item.';
    for (const attachment of data.attachments) {
      const entry = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'attachment-info';
      const link = document.createElement(attachment.url ? 'a' : 'span');
      link.textContent = attachment.name;
      if (attachment.url) {
        link.href = attachment.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      info.appendChild(link);
      if (attachment.size != null) {
        const size = document.createElement('span');
        size.className = 'muted';
        size.textContent = attachment.size < 1024 ? `${attachment.size} B`
          : attachment.size < 1024 * 1024 ? `${(attachment.size / 1024).toFixed(1)} KB`
            : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`;
        info.appendChild(size);
      }
      entry.appendChild(info);
      if (!attachment.url) {
        const warning = document.createElement('p');
        warning.className = 'image-error';
        warning.textContent = 'This attachment has an unsupported source URL. Open the work item in Azure DevOps to view it.';
        entry.appendChild(warning);
      } else if (attachment.preview_url) {
        const image = document.createElement('img');
        image.alt = attachment.name;
        image.loading = 'lazy';
        image.addEventListener('error', () => {
          const warning = document.createElement('p');
          warning.className = 'image-error';
          warning.textContent = 'Preview unavailable. Use the file link above to open it in Azure DevOps.';
          image.replaceWith(warning);
        }, { once: true });
        image.src = attachment.preview_url;
        entry.appendChild(image);
      }
      list.appendChild(entry);
    }
    setSectionVisible('sec-attachments', data.attachments.length > 0);
  } catch (err) {
    setSectionVisible('sec-attachments', true);
    status.textContent = `Could not load attachments: ${err.message}. Check Settings and reload this page.`;
  }
}

async function loadRelatedLinks(id) {
  const status = $('#links-status');
  const target = $('#related-links');
  try {
    const res = await fetch(`/api/items/${id}/links`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load related links');
    target.replaceChildren();
    status.textContent = data.links.length ? `${data.links.length} related links` : 'No related links on this work item.';
    const groups = new Map();
    for (const link of data.links) {
      if (!groups.has(link.type)) groups.set(link.type, []);
      groups.get(link.type).push(link);
    }
    for (const [type, links] of groups) {
      const group = document.createElement('div');
      const heading = document.createElement('h3');
      heading.textContent = type;
      group.appendChild(heading);
      for (const note of new Set(links.filter((link) => link.url && link.note).map((link) => link.note))) {
        const explanation = document.createElement('p');
        explanation.className = 'muted';
        explanation.textContent = note;
        group.appendChild(explanation);
      }
      const list = document.createElement('ul');
      for (const link of links) {
        const entry = document.createElement('li');
        const title = document.createElement(link.url ? 'a' : 'strong');
        title.textContent = link.title;
        if (link.url) {
          title.href = link.url;
          title.target = '_blank';
          title.rel = 'noopener noreferrer';
          if (link.note) title.textContent += ' — Open in Azure DevOps';
        }
        entry.appendChild(title);
        if (link.updated) {
          const date = document.createElement('span');
          date.className = 'muted';
          date.textContent = `Updated ${fmtDate(link.updated)}`;
          entry.appendChild(date);
        }
        for (const text of [link.comment, link.url ? '' : link.note]) {
          if (!text) continue;
          const description = document.createElement('p');
          description.className = 'muted';
          description.textContent = text;
          entry.appendChild(description);
        }
        list.appendChild(entry);
      }
      group.appendChild(list);
      target.appendChild(group);
    }
    setSectionVisible('sec-links', data.links.length > 0);
  } catch (err) {
    setSectionVisible('sec-links', true);
    status.textContent = `Could not load related links: ${err.message}. Check the connection in Settings, then reload this page.`;
  }
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
      if (data.myDisplayName && r.by === data.myDisplayName) who.className = 'my-name';
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

function setupNotes(id) {
  const box = $('#note-text');
  const status = $('#note-status');
  let timer = null;
  let saved = '';
  let version = 0;

  async function save() {
    clearTimeout(timer);
    timer = null;
    const text = box.value;
    if (text === saved) return;
    const mine = ++version;
    status.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/items/${encodeURIComponent(id)}/note`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: text }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      saved = text;
      if (mine === version) status.textContent = body.updated_at ? `Saved ${fmtDate(body.updated_at)}` : '';
    } catch (err) {
      status.textContent = `Could not save note: ${err.message}`;
    }
  }

  const rendered = $('#note-rendered');
  const setMode = async (preview) => {
    $('#note-write').setAttribute('aria-pressed', String(!preview));
    $('#note-preview').setAttribute('aria-pressed', String(preview));
    box.hidden = preview;
    rendered.hidden = !preview;
    if (!preview) return;
    await save();
    rendered.textContent = 'Rendering…';
    try {
      const res = await fetch('/api/note-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: box.value }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      if (body.html) renderRichText(rendered, body.html);
      else rendered.textContent = 'Nothing to preview.';
    } catch (err) {
      rendered.textContent = `Could not render note: ${err.message}`;
    }
  };
  $('#note-write').addEventListener('click', () => setMode(false));
  $('#note-preview').addEventListener('click', () => setMode(true));

  async function uploadImages(files) {
    for (const file of files) {
      status.textContent = 'Uploading image…';
      try {
        const res = await fetch(`/api/items/${encodeURIComponent(id)}/note-images`, {
          method: 'POST', headers: { 'Content-Type': file.type }, body: file,
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        const md = `\n![image](${body.url})\n`;
        const pos = box.selectionEnd ?? box.value.length;
        box.value = box.value.slice(0, pos) + md + box.value.slice(pos);
        box.selectionStart = box.selectionEnd = pos + md.length;
        status.textContent = '';
        await save();
      } catch (err) {
        status.textContent = `Could not add image: ${err.message}`;
      }
    }
  }
  const imageFiles = (dt) => [...(dt?.files || [])].filter((f) => f.type.startsWith('image/'));
  box.addEventListener('paste', (e) => {
    const files = imageFiles(e.clipboardData);
    if (files.length) { e.preventDefault(); uploadImages(files); }
  });
  box.addEventListener('dragover', (e) => { if (imageFiles(e.dataTransfer).length || [...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith('image/'))) e.preventDefault(); });
  box.addEventListener('drop', (e) => {
    const files = imageFiles(e.dataTransfer);
    if (files.length) { e.preventDefault(); uploadImages(files); }
  });

  box.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 600); });
  box.addEventListener('blur', save);
  window.addEventListener('pagehide', () => {
    if (box.value === saved) return;
    fetch(`/api/items/${encodeURIComponent(id)}/note`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: box.value }), keepalive: true,
    });
  });

  fetch(`/api/items/${encodeURIComponent(id)}/note`).then((r) => r.json()).then((n) => {
    if (box.value === '') { box.value = n.note || ''; saved = box.value; }
    status.textContent = n.updated_at ? `Saved ${fmtDate(n.updated_at)}` : '';
  }).catch((err) => { status.textContent = `Could not load note: ${err.message}`; });
}

setupNotes(new URLSearchParams(location.search).get('id'));

load().catch((err) => {
  $('#history-status').textContent = `Could not load this work item: ${err.message}`;
  $('#links-status').textContent = `Could not load this work item: ${err.message}`;
});
