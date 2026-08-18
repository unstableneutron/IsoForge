import { describe, expect, it } from 'vitest';
import { serveMcp } from './mcp';
import type { IsoForgeEnv } from './service';

const unavailableNamespace = {
  idFromName() { throw new Error('not used by discovery/list tests'); },
  get() { throw new Error('not used by discovery/list tests'); }
} as unknown as IsoForgeEnv['DIAGRAMS'];

const env: IsoForgeEnv = { DIAGRAMS: unavailableNamespace, CATALOG: unavailableNamespace };
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'isoforge-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
};

function modernRequest(method: string, params: Record<string, unknown> = {}, name?: string): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Host: 'localhost',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } })
  });
}

describe('IsoForge MCP HTTP entry', () => {
  it('negotiates the current 2026-07-28 request-scoped protocol', async () => {
    const response = await serveMcp(modernRequest('server/discover'), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { supportedVersions: string[] } };
    expect(body.result.supportedVersions).toEqual(['2026-07-28']);
  });

  it('lists the complete tool surface in the current protocol', async () => {
    const response = await serveMcp(modernRequest('tools/list'), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map(tool => tool.name)).toEqual([
      'create_diagram',
      'list_diagrams',
      'get_diagram',
      'get_diagram_state',
      'apply_diagram_operations',
      'search_icons',
      'export_diagram_json'
    ]);
  });

  it('keeps the official stateless 2025 initialization fallback', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Host: 'localhost' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1.0.0' } }
      })
    });
    const response = await serveMcp(request, env);
    expect(response.status).toBe(200);
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? (await response.text()).split('\n').find(line => line.startsWith('data: '))?.slice(6)
      : await response.text();
    const body = JSON.parse(payload ?? '') as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toMatch(/^2025-/);
    expect(body.result.serverInfo.name).toBe('isoforge');
  });

  it('rejects DNS rebinding and enforces the optional token', async () => {
    const badHost = modernRequest('tools/list');
    const rebound = new Request(badHost, { headers: { ...Object.fromEntries(badHost.headers), Host: 'attacker.example' } });
    expect((await serveMcp(rebound, env)).status).toBe(403);

    const secured = { ...env, MCP_BEARER_TOKEN: 'test-secret' };
    expect((await serveMcp(modernRequest('tools/list'), secured)).status).toBe(401);
    const authorized = modernRequest('tools/list');
    authorized.headers.set('Authorization', 'Bearer test-secret');
    expect((await serveMcp(authorized, secured)).status).toBe(200);
  });
});
