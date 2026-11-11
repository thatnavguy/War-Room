'use strict';

const path = require('path');
const express = require('express');

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(value, withScheme) {
  if (!value) return '';
  try {
    return new URL(withScheme ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Blocks DNS-rebinding (foreign Host header) and cross-site requests (foreign Origin)
// so other web pages cannot read local data or change settings through the browser.
function localOnly(req, res, next) {
  if (!LOCAL_HOSTNAMES.has(hostnameOf(req.headers.host, false))) {
    return res.status(403).json({ error: 'War Room only accepts requests addressed to localhost.' });
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !LOCAL_HOSTNAMES.has(hostnameOf(origin, true))) {
    return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
  }
  next();
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status < 500 ? err.message : 'Something went wrong on the War Room server.' });
}

function createApp() {
  const app = express();
  app.use(localOnly);
  app.use(express.json());
  app.use('/api/reading', require('./reading'));
  app.use('/api', require('./api'));
  app.use('/vendor/mermaid', express.static(path.dirname(require.resolve('mermaid')), { index: false }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, localOnly, errorHandler };
