'use strict';

const { resolveAnalystPrecedence } = require('../analyst-precedence');

function resolvePrecedence(input = {}) {
  return resolveAnalystPrecedence(input);
}

module.exports = {
  resolvePrecedence,
};

