'use strict';

const express = require('express');
const db = require('./db');
const sync = require('./sync');
const config = require('./config');
const ado = require('./ado');
const { getProvider, listProviders, describeItem } = require('./providers');

const router = express.Router();

router.get('/providers', (req, res) => res.json({ providers: listProviders() }));

router.get('/config', (req, res) => {
  res.json({
    configured: config.isConfigured(),
    orgUrl: config.orgUrl,
    patSet: Boolean(config.pat),
    projects: config.projects.join(', '),
    port: config.port,
    staleDays: config.staleDays,
    lookbackDays: config.lookbackDays,
  });
});

router.post('/config', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.orgUrl || !body.orgUrl.trim()) {
      return res.status(400).json({ error: 'Organization URL is required' });
    }
    if (!config.pat && !(body.pat || '').trim()) {
      return res.status(400).json({ error: 'A Personal Access Token is required' });
    }
    const result = config.save(body);
    res.json({ saved: true, configured: config.isConfigured(), portChanged: result.portChanged, port: config.port });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  if (!config.isConfigured()) {
    return res.status(400).json({ error: 'Not configured. Open the setup page first.' });
  }
  try {
    const stats = await sync.runSync(req.body?.provider || 'azure-devops');
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sync/status', (req, res) => {
  res.json(sync.syncStatus());
});

router.get('/me', (req, res) => {
  res.json({ displayName: db.getSyncState('meDisplayName') || '', provider: 'azure-devops', source_scope: config.orgUrl });
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
    type: req.query.type || '',
    state: req.query.state || '',
    iteration: req.query.iteration || '',
    touch: req.query.touch || '',
    assignedToMe: req.query.mine === '1',
    from: req.query.from || '',
    to: req.query.to || '',
    limit: parseInt(req.query.limit, 10) || 200,
    offset: parseInt(req.query.offset, 10) || 0,
  };
  const result = db.queryItems(filters);
  res.json({ ...result, items: result.items.map(describeItem) });
});

router.get('/items/:id', (req, res) => {
  const item = db.getItem(parseInt(req.params.id, 10));
  if (!item) return res.status(404).json({ error: 'Not found' });
  const { sanitizeRichText } = getProvider(item.provider);
  res.json({
    ...describeItem(item),
    description: sanitizeRichText(item.description),
    acceptance_criteria: sanitizeRichText(item.acceptance_criteria),
    repro_steps: sanitizeRichText(item.repro_steps),
    history: sanitizeRichText(item.history),
    attachments: item.attachments ? JSON.parse(item.attachments) : [],
  });
});

router.get('/items/:id/history', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = db.getItem(id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  try {
    res.json({ revisions: await getProvider(item.provider).getHistory(item) });
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
