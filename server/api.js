'use strict';

const express = require('express');
const db = require('./db');
const sync = require('./sync');
const config = require('./config');
const autoSync = require('./auto-sync');
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
      autoSyncMinutes: config.adoAutoSyncMinutes,
    },
    github: {
      configured: config.isGitHubConfigured(),
      tokenSet: Boolean(config.ghToken),
      repos: config.ghRepos.join(', '),
      host: config.ghHost,
      autoSyncMinutes: config.ghAutoSyncMinutes,
    },
    port: config.port,
    staleDays: config.staleDays,
    lookbackDays: config.lookbackDays,
    discoveryDays: config.discoveryDays,
  });
});

router.post('/config', (req, res) => {
  try {
    const body = req.body || {};
    const values = {};
    for (const section of [body.azureDevOps, body.github]) {
      const minutes = section?.autoSyncMinutes;
      if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)) {
        return res.status(400).json({ error: 'Auto-sync interval must be a whole number from 0 to 1440 minutes (0 turns it off).' });
      }
    }
    if (body.azureDevOps) {
      const section = body.azureDevOps;
      if (!section.orgUrl || !section.orgUrl.trim()) {
        return res.status(400).json({ error: 'Organization URL is required' });
      }
      if (!config.pat && !(section.pat || '').trim()) {
        return res.status(400).json({ error: 'A Personal Access Token is required' });
      }
      if (!(section.pat || '').trim() && config.normalizeOrgUrl(section.orgUrl).toLowerCase() !== config.orgUrl.toLowerCase()) {
        return res.status(400).json({ error: 'Enter the Personal Access Token again when changing the organization URL.' });
      }
      values.orgUrl = section.orgUrl;
      values.pat = section.pat;
      values.projects = section.projects;
      values.adoAutoSyncMinutes = section.autoSyncMinutes;
    }
    if (body.github) {
      const section = body.github;
      if (!config.ghToken && !(section.ghToken || '').trim()) {
        return res.status(400).json({ error: 'A GitHub personal access token is required' });
      }
      if (section.ghHost !== undefined && !(section.ghToken || '').trim() &&
          (config.normalizeHost(section.ghHost) || 'github.com') !== config.ghHost) {
        return res.status(400).json({ error: 'Enter the GitHub token again when changing the GitHub host.' });
      }
      values.ghToken = section.ghToken;
      values.ghRepos = section.ghRepos;
      values.ghHost = section.ghHost;
      values.ghAutoSyncMinutes = section.autoSyncMinutes;
    }
    if (body.general) {
      const days = body.general.discoveryDays;
      if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
        return res.status(400).json({ error: 'Discovery window must be a whole number from 1 to 3650 days.' });
      }
      if (body.general.port !== undefined && !config.isValidPort(body.general.port)) {
        return res.status(400).json({ error: 'Port must be a whole number from 1 to 65535.' });
      }
      values.port = body.general.port;
      values.staleDays = body.general.staleDays;
      values.lookbackDays = body.general.lookbackDays;
      values.discoveryDays = days;
    }
    if (Object.keys(values).length === 0) {
      return res.status(400).json({ error: 'Nothing to save. Send an azureDevOps, github, or general section.' });
    }
    const result = config.save(values);
    if (values.adoAutoSyncMinutes !== undefined) autoSync.start('azure-devops');
    if (values.ghAutoSyncMinutes !== undefined) autoSync.start('github');
    res.json({ saved: true, configured: config.isAnyConfigured(), portChanged: result.portChanged, port: config.port });
  } catch (err) {
    res.status(err.status === 400 ? 400 : 500).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  if (!config.isAnyConfigured()) {
    return res.status(400).json({ error: 'Not configured. Open the setup page first.' });
  }
  try {
    const stats = await sync.runSync(req.body?.provider || undefined);
    for (const error of stats.errors || []) console.error(`[sync] ${error}`);
    res.json(stats);
  } catch (err) {
    console.error(`[sync] ${err.message}`);
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
  res.json(db.getSummary(config.staleDays, req.query.room === 'inspection'));
});

router.get('/items', (req, res) => {
  const filters = {
    discovery: req.query.room === 'discovery',
    inspection: req.query.room === 'inspection',
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
    closedOnly: req.query.hidden === 'closed',
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

function parseAttachments(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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
    attachments: parseAttachments(item.attachments),
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
  res.json(db.getFilterValues(req.query.room || ''));
});

module.exports = router;
