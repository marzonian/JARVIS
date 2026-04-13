#!/usr/bin/env node
/* eslint-disable no-console */
const {
  assert,
  startAuditServer,
} = require('./jarvis-audit-common');

async function run() {
  const useExisting = !!process.env.BASE_URL;
  const server = await startAuditServer({
    useExisting,
    baseUrl: process.env.BASE_URL,
    port: process.env.JARVIS_AUDIT_PORT || 3144,
  });

  try {
    const res = await fetch(`${server.baseUrl}/api/assistant/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'should i take this setup now',
        strategy: 'original',
        activeModule: 'analyst',
        voiceMode: true,
        voiceBriefMode: 'earbud',
      }),
      signal: AbortSignal.timeout(20000),
    });
    const txt = await res.text();
    let body = {};
    try {
      body = JSON.parse(txt || '{}');
    } catch {
      body = { raw: txt };
    }
    assert(res.status === 409, 'voice guard should return 409', {
      status: res.status,
      body,
    });
    assert(String(body?.message || '') === 'Voice must use Jarvis endpoint', 'voice guard message mismatch', {
      body,
    });
    assert(String(body?.requiredEndpoint || '') === '/api/jarvis/query', 'voice guard requiredEndpoint mismatch', {
      body,
    });
    assert(String(body?.traceId || '').trim().length > 0, 'voice guard traceId missing', {
      body,
    });
    console.log('✅ jarvis voice endpoint guard test passed');

    const sessionId = `jarvis-general-chat-firewall-${Date.now()}`;
    const generalRes = await fetch(`${server.baseUrl}/api/jarvis/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'its still dumb it just says anything',
        strategy: 'original',
        activeModule: 'bridge',
        contextHint: 'bridge',
        voiceMode: true,
        voiceBriefMode: 'earbud',
        sessionId,
        clientId: sessionId,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const generalTxt = await generalRes.text();
    let generalBody = {};
    try {
      generalBody = JSON.parse(generalTxt || '{}');
    } catch {
      generalBody = { raw: generalTxt };
    }
    assert(generalRes.ok, 'jarvis query should succeed for general chat phrase', { status: generalRes.status, generalBody });
    assert(String(generalBody?.intent || '') === 'general_chat', 'general chat phrase intent mismatch', { generalBody });
    assert(Array.isArray(generalBody?.toolsUsed) && generalBody.toolsUsed.length === 1 && generalBody.toolsUsed[0] === 'Jarvis', 'general chat phrase should use only Jarvis tool', { generalBody });
    const reply = String(generalBody?.reply || '');
    const forbidden = [
      /\borb\b/i,
      /\btopstep\b/i,
      /\bbest setup\b/i,
      /\b10:15\b/i,
      /\bchance of green day\b/i,
      /\bentry window\b/i,
    ];
    for (const re of forbidden) {
      assert(!re.test(reply), `general chat reply leaked trading token ${re}`, { reply, generalBody });
    }
    assert(/not sure what you want|want to talk about trading|something else/i.test(reply), 'general chat phrase should receive clarification reply', { reply, generalBody });
    console.log('✅ jarvis general-chat content firewall test passed');
  } finally {
    await server.stop();
  }
}

run().catch((err) => {
  console.error(`\nJarvis voice endpoint guard test failed: ${err.message}`);
  process.exit(1);
});
