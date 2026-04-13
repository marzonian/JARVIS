'use strict';

const { enforceEarbudFinalGate } = require('../jarvis-audit');

function finalizeVoiceReply(input = {}) {
  return enforceEarbudFinalGate(input);
}

module.exports = {
  finalizeVoiceReply,
};

