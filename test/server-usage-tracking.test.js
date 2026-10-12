import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const start = 'event: response.created\ndata: {"type":"response.created","response":{}}\n\n';
const complete = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":21,"output_tokens":7}}}\n\n';
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function withResponse({ headers = {}, status = 200, responseBody = start + complete, requestBody = { stream: true }, path = '/responses', provider = 'codex' }, check) {
  const upstream = http.createServer((_req, res) => { res.writeHead(status, headers); res.end(responseBody); });
  const port = await listen(upstream);
  const manager = new AccountManager([{ name: 'test', provider, type: 'api-key', apiKey: 'test-key' }]);
  const proxy = createProxyServer(manager, { provider, upstream: `http://127.0.0.1:${port}`, activeWarmup: false, codexUsageRefresh: false });
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody) });
    const bytes = await response.text();
    await check({ response, bytes, manager });
  } finally {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]);
  }
}

for (const path of ['/responses', '/codex/responses?trace=1']) {
  for (const headers of [{}, { 'content-type': 'text/event-stream' }]) {
    test(`Codex ${path} counts SSE tokens once with ${Object.keys(headers).length ? 'explicit' : 'missing'} MIME`, async () => {
      await withResponse({ path, headers }, ({ response, bytes, manager }) => {
        assert.equal(response.status, 200);
        assert.equal(bytes, start + complete);
        assert.equal(response.headers.get('content-type'), headers['content-type'] ?? null);
        assert.equal(manager.accounts[0].usage.totalInputTokens, 21);
        assert.equal(manager.accounts[0].usage.totalOutputTokens, 7);
      });
    });
  }
}

for (const scenario of [
  { requestBody: { stream: false } },
  { requestBody: {} },
  { path: '/responses/compact' },
  { path: '/models' },
  { headers: { 'content-type': 'application/json' } },
  { status: 400 },
  { provider: 'anthropic', path: '/v1/messages' },
]) {
  test(`missing MIME fallback stays scoped: ${JSON.stringify(scenario)}`, async () => {
    await withResponse(scenario, ({ bytes, manager }) => {
      assert.equal(bytes, start + complete);
      assert.equal(manager.accounts[0].usage.totalInputTokens, 0);
      assert.equal(manager.accounts[0].usage.totalOutputTokens, 0);
    });
  });
}

test('Codex missing MIME forwards the first frame before the upstream finishes', async () => {
  // B2 (pre-output stream replay, TEAMCODEX_OVERLOAD_HOLD_MS) deliberately
  // stages the response.created envelope until the first output event so a
  // pre-output failure can be replayed; the frame then reaches the client only
  // together with the terminal. This test pins the LEGACY first-frame pass-
  // through of a MIME-less SSE body, so it runs with the shared B1/B2 kill switch
  // off. (MIME-less token counting with B2 on is covered by the suite above.)
  const savedHold = process.env.TEAMCODEX_OVERLOAD_HOLD_MS;
  process.env.TEAMCODEX_OVERLOAD_HOLD_MS = '0';
  let finish;
  let fallback;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200);
    res.write(start);
    finish = () => res.end(complete);
    fallback = setTimeout(finish, 1500);
  });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{ name: 'test', provider: 'codex', type: 'api-key', apiKey: 'test-key' }]);
  const proxy = createProxyServer(manager, { provider: 'codex', upstream: `http://127.0.0.1:${upstreamPort}`, activeWarmup: false, codexUsageRefresh: false });
  const port = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/responses`, { method: 'POST', body: JSON.stringify({ stream: true }) });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value).toString(), start);
    clearTimeout(fallback);
    finish();
    while (!(await reader.read()).done) { /* drain the response */ }
    assert.equal(manager.accounts[0].usage.totalInputTokens, 21);
    assert.equal(manager.accounts[0].usage.totalOutputTokens, 7);
  } finally {
    if (savedHold === undefined) delete process.env.TEAMCODEX_OVERLOAD_HOLD_MS;
    else process.env.TEAMCODEX_OVERLOAD_HOLD_MS = savedHold;
    clearTimeout(fallback);
    finish?.();
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]);
  }
});
