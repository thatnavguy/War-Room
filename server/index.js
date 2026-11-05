'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const api = require('./api');

const app = express();
app.use(express.json());
app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Mission Hall running at http://localhost:${config.port}`);
});
