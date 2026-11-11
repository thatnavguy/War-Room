'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const api = require('./api');
const autoSync = require('./auto-sync');

const app = express();
app.use(express.json());
app.use('/api/reading', require('./reading'));
app.use('/api', api);
app.use('/vendor/mermaid', express.static(path.dirname(require.resolve('mermaid')), { index: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(config.port, '127.0.0.1', () => {
  console.log(`War Room running at http://localhost:${config.port}`);
  console.log('(Keep this window open while using the app. Close it to stop.)');
  autoSync.start();
});
