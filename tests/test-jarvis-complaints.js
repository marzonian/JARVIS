#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const { startAuditServer, postJson } = require('./jarvis-audit-common');

async function run() {
  const server = await startAuditServer({
    useExisting: !!process.env.BASE_URL,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3158,
  });
  try {
    const payload = {
      prompt: 'am i clear to trade today',
      reply: 'signal is aborted without reason',
      notes: 'unexpected abort',
      traceId: `cmp-${Date.now()}`,
      sessionId: `cmp-sess-${Date.now()}`,
      clientId: `cmp-client-${Date.now()}`,
      intent: 'trading_decision',
      selectedSkill: 'TradingDecision',
      routePath: 'jarvis_orchestrator.trading_decision',
      toolsUsed: ['Jarvis'],
    };
    const created = await postJson(server.baseUrl, '/api/jarvis/complaints', payload);
    assert.strictEqual(created.success, true);
    assert(Number(created.complaintId) > 0, 'complaintId must be numeric');

    const listResp = await fetch(`${server.baseUrl}/api/jarvis/complaints?limit=25`);
    const listJson = await listResp.json();
    assert.strictEqual(listJson.success, true);
    assert(Array.isArray(listJson.complaints), 'complaints list expected');
    const found = listJson.complaints.find((row) => Number(row.id) === Number(created.complaintId));
    assert(found, 'created complaint should be in list');
    assert.strictEqual(found.prompt, payload.prompt);
    assert.strictEqual(found.reply, payload.reply);

    const mdResp = await fetch(`${server.baseUrl}/api/jarvis/complaints/export?format=markdown&limit=5`);
    const mdText = await mdResp.text();
    assert(mdResp.ok, 'markdown export should be ok');
    assert(/Jarvis Complaints Export/i.test(mdText), 'markdown export heading missing');
  } finally {
    await server.stop();
  }
  console.log('All jarvis complaints tests passed.');
}

run().catch((err) => {
  console.error(`❌ test-jarvis-complaints failed\n   ${err.message}`);
  process.exit(1);
});

