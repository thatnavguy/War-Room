'use strict';

const config = require('./config');
const autoSync = require('./auto-sync');
const { createApp } = require('./app');

createApp().listen(config.port, '127.0.0.1', () => {
  console.log(`War Room running at http://localhost:${config.port}`);
  console.log('(Keep this window open while using the app. Close it to stop.)');
  autoSync.start();
});
