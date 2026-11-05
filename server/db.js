'use strict';

const path = require('path');
const config = require('./config');
const { createStore } = require('./store');

// Keep the existing filename so upgrades retain all locally tracked work.
module.exports = createStore(path.join(__dirname, '..', 'data', 'devops-center.db'), config.orgUrl);
