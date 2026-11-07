'use strict';

const express = require('express');
const db = require('./db');
const sync = require('./sync');
const config = require('./config');
const ado = require('./ado');
const { renderMarkdown } = require('./markdown');
const { getProvider, listProviders, describeItem } = require('./providers');

const router = express.Router();

router.get('/providers', (req, res) => res.json({ providers: listProviders() }));

router.get('/config', (req, res) => {
  res.json({
    configured: config.isAnyConfigured(),
    azureDevOps: {
      configured: config.isConfigured(),
      orgUrl: config.orgUrl,
      patSet: Boolean(config.pat),
      projects: config.projects.join(', '),
    },
    github: {
      configured: config.isGitHubConfigured(),
      tokenSet: Boolean(config.ghToken),
      repos: config.ghRepos.join(', '),
      host: config.ghHost,
    },
    port: config.port,
    staleDays: config.staleDays,
    lookbackDays: config.lookbackDays,
  });
});

router.post('/config', (req, res) => {
  try {
    const body = req.body || {};
    const values = {};
    if (body.azureDevOps) {
      const section = body.azureDevOps;
      if (!section.orgUrl || !section.orgUrl.trim()) {
        return res.status(400).json({ error: 'Organization URL is required' });
      }
      if (!config.pat && !(section.pat || '').trim()) {
        return res.status(400).json({ error: 'A Personal Access Token is required' });
      }
      values.orgUrl = section.orgUrl;
      values.pat = section.pat;
      values.projects = section.projects;
    }
    if (body.github) {
      const section = body.github;
      if (!config.ghToken && !(section.ghToken || '').trim()) {
        return res.status(400).json({ error: 'A GitHub personal access token is required' });
      }
      values.ghToken = section.ghToken;
      values.ghRepos = section.ghRepos;
      values.ghHost = section.ghHost;
    }
    if (body.general) {
      values.port = body.general.port;
      values.staleDays = body.general.staleDays;
      values.lookbackDays = body.general.lookbackDays;
    }
    if (Object.keys(values).length === 0) {
      return res.status(400).json({ error: 'Nothing to save. Send an azureDevOps, github, or general section.' });
    }
    const result = config.save(values);
    res.json({ saved: true, configured: config.isAnyConfigured(), portChanged: result.portChanged, port: config.port });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  if (!config.isAnyConfigured()) {
    return res.status(400).json({ error: 'Not configured. Open the setup page first.' });
  }
  try {
    const stats = await sync.runSync(req.body?.provider || undefined);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sync/status', (req, res) => {
  res.json(sync.syncStatus());
});

router.get('/me', (req, res) => {
  res.json({ identities: db.identities() });
});

router.get('/summary', (req, res) => {
  res.json(db.getSummary(config.staleDays));
});

router.get('/items', (req, res) => {
  const filters = {
    search: req.query.search || '',
    project: req.query.project || '',
    provider: req.query.provider || '',
    priority: req.query.priority || '',
    label: req.query.label || '',
    type: req.query.type || '',
    state: req.query.state || '',
    iteration: req.query.iteration || '',
    touch: req.query.touch || '',
    assignedToMe: req.query.mine === '1',
    hiddenOnly: req.query.hidden === '1',
    focus: ['digest', 'attention'].includes(req.query.focus) ? req.query.focus : '',
    from: req.query.from || '',
    to: req.query.to || '',
    limit: parseInt(req.query.limit, 10) || 200,
    offset: parseInt(req.query.offset, 10) || 0,
  };
  const result = db.queryItems(filters);
  res.json({ ...result, items: result.items.map(describeItem) });
});

router.post('/items/:id/visibility', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof req.body?.hidden !== 'boolean') {
    return res.status(400).json({ error: 'A valid work-item ID and hidden boolean are required.' });
  }
  const result = db.setItemHidden(id, req.body.hidden);
  res.status(result.status || 200).json(result);
});

const renderNote = (note) => renderMarkdown(note, '', { noteImages: true });

router.get('/items/:id/note', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'A valid work-item ID is required.' });
  const result = db.getItemNote(id);
  res.json({ ...result, html: renderNote(result.note) });
});

router.post('/note-preview', (req, res) => {
  const note = req.body?.note;
  if (typeof note !== 'string' || note.length > 100000) return res.status(400).json({ error: 'A note string is required.' });
  res.json({ html: renderNote(note) });
});

const NOTE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

router.post('/items/:id/note-images', express.raw({ type: NOTE_IMAGE_TYPES, limit: '10mb' }), (req, res) => {
  const id = Number(req.params.id);
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!Number.isSafeInteger(id) || id <= 0 || !NOTE_IMAGE_TYPES.includes(mime) || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'A valid work-item ID and a PNG, JPEG, GIF or WebP image (max 10 MB) are required.' });
  }
  const result = db.addNoteImage(id, mime, req.body);
  if (result.error) return res.status(result.status || 400).json(result);
  res.json({ id: result.id, url: `/api/note-images/${result.id}` });
});

router.get('/note-images/:id', (req, res) => {
  const image = db.getNoteImage(Number(req.params.id));
  if (!image) return res.status(404).json({ error: 'Not found' });
  res.set({ 'Content-Type': image.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
  res.send(image.data);
});

router.put('/items/:id/note', (req, res) => {
  const id = Number(req.params.id);
  const note = req.body?.note;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof note !== 'string' || note.length > 100000) {
    return res.status(400).json({ error: 'A valid work-item ID and a note string (max 100,000 characters) are required.' });
  }
  const result = db.setItemNote(id, note);
  res.status(result.status || 200).json(result.error ? result : { ...result, html: renderNote(result.note) });
});

router.get('/items/:id', (req, res) => {
  const item = db.getItem(parseInt(req.params.id, 10));
  if (!item) return res.status(404).json({ error: 'Not found' });
  const { sanitizeRichText } = getProvider(item.provider);
  res.json({
    ...describeItem(item),
    description: sanitizeRichText(item.description, item),
    acceptance_criteria: sanitizeRichText(item.acceptance_criteria, item),
    repro_steps: sanitizeRichText(item.repro_steps, item),
    history: sanitizeRichText(item.history, item),
    attachments: item.attachments ? JSON.parse(item.attachments) : [],
  });
});

router.get('/items/:id/history', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = db.getItem(id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  try {
    res.json({ revisions: await getProvider(item.provider).getHistory(item), myDisplayName: describeItem(item).my_display_name });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/items/:id/links', async (req, res) => {
  const item = db.getItem(parseInt(req.params.id, 10));
  if (!item) return res.status(404).json({ error: 'Not found' });
  try {
    res.json({ links: await getProvider(item.provider).getRelatedLinks(item) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/items/:id/attachments', async (req, res) => {
  const item = db.getItem(parseInt(req.params.id, 10));
  if (!item) return res.status(404).json({ error: 'Not found' });
  try {
    res.json({ attachments: await getProvider(item.provider).getAttachments(item) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/attachments/image', async (req, res) => {
  if (!config.isConfigured()) return res.status(400).json({ error: 'Configure Azure DevOps before loading screenshots.' });
  if (!ado.imageAttachmentUrl(req.query.url)) {
    return res.status(400).json({ error: 'Unsupported screenshot source.' });
  }
  try {
    const image = await ado.getImageAttachment(req.query.url);
    res.set({
      'Content-Type': image.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(image.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/filters', (req, res) => {
  res.json(db.getFilterValues());
});

module.exports = router;
