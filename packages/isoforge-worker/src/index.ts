import { DiagramCatalog, DiagramCell } from './cells';
import { DomainError } from './domain';
import { errorResponse, json, readJson } from './http';
import { serveMcp } from './mcp';
import { DiagramService, type IsoForgeEnv } from './service';
import type { ApplyRequest, DiagramState } from './types';

export { DiagramCatalog, DiagramCell };

async function serveApi(request: Request, env: IsoForgeEnv, path: string): Promise<Response> {
  const service = new DiagramService(env);
  if (request.method === 'GET' && path === '/api/diagrams') return json({ diagrams: await service.list() });
  if (request.method === 'POST' && path === '/api/diagrams') {
    const body = await readJson<{ id?: string; title: string; description?: string; state?: DiagramState }>(request);
    return json(await service.create(body), 201);
  }
  const match = path.match(/^\/api\/diagrams\/([^/]+)(?:\/(state|operations|export))?$/);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    const action = match[2];
    if (request.method === 'GET' && (!action || action === 'state')) {
      const record = await service.get(id);
      return action === 'state'
        ? json({ diagramId: id, schemaVersion: record.schemaVersion, revision: record.revision, state: record.state })
        : json(record);
    }
    if (request.method === 'GET' && action === 'export') {
      const record = await service.get(id);
      return new Response(JSON.stringify(record.state, null, 2), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${id}.json"` } });
    }
    if (request.method === 'POST' && action === 'operations') {
      return json(await service.apply(id, await readJson<ApplyRequest>(request)));
    }
  }
  const ws = path.match(/^\/ws\/diagrams\/([^/]+)$/);
  if (ws && request.method === 'GET') return service.webSocket(decodeURIComponent(ws[1]!), request);
  throw new DomainError('NOT_FOUND', 'Route not found', 404);
}

export default {
  async fetch(request: Request, env: IsoForgeEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health') return json({ status: 'ok', service: 'isoforge', runtime: 'celld', mcpProtocol: '2026-07-28' });
      if (url.pathname === '/mcp') return await serveMcp(request, env);
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return await serveApi(request, env, url.pathname);
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      throw new DomainError('NOT_FOUND', 'Route not found', 404);
    } catch (error) {
      return errorResponse(error);
    }
  }
};
