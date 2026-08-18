#!/usr/bin/env node

const baseUrl = process.env.ISOFORGE_URL ?? 'http://localhost:8787';
const token = process.env.MCP_BEARER_TOKEN;
const args = new Set(process.argv.slice(2));
const idArg = process.argv.find(value => value.startsWith('--diagram-id='));
const diagramId = idArg?.slice('--diagram-id='.length) || `e2e-${Date.now()}`;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function responsePayload(response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split('\n').find(line => line.startsWith('data: '))?.slice(6);
    return JSON.parse(data ?? 'null');
  }
  return JSON.parse(text);
}

async function mcp(body, modern = false) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  if (modern) {
    headers['MCP-Protocol-Version'] = '2026-07-28';
    headers['Mcp-Method'] = body.method;
    if (body.method === 'tools/call') headers['Mcp-Name'] = body.params.name;
  }
  const response = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const payload = await responsePayload(response);
  invariant(response.ok, `MCP ${body.method} failed (${response.status}): ${JSON.stringify(payload)}`);
  invariant(!payload.error, `MCP ${body.method} returned an error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'isoforge-e2e', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}

async function modern(method, params = {}) {
  return mcp({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { ...params, _meta: modernMeta() } }, true);
}

async function openRoom(id) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/ws/diagrams/${encodeURIComponent(id)}`;
  const socket = new WebSocket(url);
  const queued = [];
  const waiters = [];
  socket.addEventListener('message', event => {
    const value = JSON.parse(String(event.data));
    const index = waiters.findIndex(waiter => waiter.predicate(value));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(value);
    else queued.push(value);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
  return {
    socket,
    waitFor(predicate, timeoutMs = 10_000) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const pending = waiters.indexOf(waiter);
          if (pending >= 0) waiters.splice(pending, 1);
          reject(new Error('Timed out waiting for WebSocket update'));
        }, timeoutMs);
      });
    }
  };
}

async function getRecord(id) {
  const response = await fetch(`${baseUrl}/api/diagrams/${encodeURIComponent(id)}`);
  const body = await response.json();
  invariant(response.ok, `GET diagram failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

if (args.has('--verify-only')) {
  const record = await getRecord(diagramId);
  invariant(record.state?.items?.some(item => item.id === 'api'), 'Persisted API item is missing after restart');
  console.log(JSON.stringify({ gate: 'restart-persistence', diagramId, revision: record.revision, passed: true }));
  process.exit(0);
}

const health = await fetch(`${baseUrl}/health`).then(response => response.json());
invariant(health.status === 'ok' && health.runtime === 'celld', 'celld Worker health failed');

const initialize = await mcp({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'isoforge-e2e-legacy', version: '1.0.0' } }
});
invariant(initialize.serverInfo?.name === 'isoforge', 'Legacy initialize did not identify IsoForge');

const legacyTools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
invariant(legacyTools.tools?.some(tool => tool.name === 'apply_diagram_operations'), 'Legacy tools/list omitted apply tool');

const discover = await modern('server/discover');
invariant(discover.supportedVersions?.includes('2026-07-28'), 'Modern discovery omitted 2026-07-28');

const create = await modern('tools/call', {
  name: 'create_diagram',
  arguments: { id: diagramId, title: 'IsoForge E2E' }
});
invariant(!create.isError, `create_diagram failed: ${JSON.stringify(create)}`);

const initial = await getRecord(diagramId);
invariant(initial.revision === 0, `Expected initial revision 0, got ${initial.revision}`);

const room = await openRoom(diagramId);
const snapshot = await room.waitFor(message => message.type === 'diagram.snapshot');
invariant(snapshot.revision === 0, 'Initial WebSocket snapshot revision was not 0');

const idempotencyKey = `e2e-apply-${crypto.randomUUID()}`;
const operationArguments = {
  diagramId,
  expectedRevision: 0,
  idempotencyKey,
  operations: [{ type: 'upsert_item', item: { id: 'api', name: 'API', icon: 'server' } }]
};
const updatePromise = room.waitFor(message => message.type === 'diagram.patch' && message.revision === 1);
const apply = await modern('tools/call', { name: 'apply_diagram_operations', arguments: operationArguments });
invariant(!apply.isError && apply.structuredContent?.revision === 1, `apply tool failed: ${JSON.stringify(apply)}`);
const patch = await updatePromise;
invariant(patch.state.items.some(item => item.id === 'api'), 'WebSocket patch omitted persisted item');

const replay = await modern('tools/call', { name: 'apply_diagram_operations', arguments: operationArguments });
invariant(replay.structuredContent?.idempotentReplay === true, 'Idempotent retry was not replayed');

const stale = await fetch(`${baseUrl}/api/diagrams/${encodeURIComponent(diagramId)}/operations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...operationArguments, idempotencyKey: `stale-${crypto.randomUUID()}` })
});
const staleBody = await stale.json();
invariant(stale.status === 409 && staleBody.error?.code === 'REVISION_CONFLICT', 'Stale revision did not return explicit 409 conflict');

const record = await getRecord(diagramId);
invariant(record.revision === 1 && record.state.items.some(item => item.id === 'api'), 'REST did not observe the MCP mutation');
room.socket.close();

console.log(JSON.stringify({
  gate: 'live-e2e',
  passed: true,
  diagramId,
  revision: record.revision,
  protocol: discover.supportedVersions,
  toolCount: legacyTools.tools.length,
  websocketEvent: patch.type,
  next: `node scripts/validate-e2e.mjs --verify-only --diagram-id=${diagramId}`
}));
