'use strict';

const { applyDefaults, preSave } = require('./policy.cjs');

applyDefaults(process.env);

const Waline = require('@waline/vercel');

module.exports = Waline({ preSave });
