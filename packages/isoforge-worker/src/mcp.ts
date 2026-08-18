import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
  type McpHttpHandler
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DomainError } from './domain';
import { searchIcons } from './icons';
import { DiagramService, type IsoForgeEnv } from './service';
import type { DiagramOperation, DiagramState } from './types';

const jsonObject = z.record(z.string(), z.unknown());
const stateSchema = z.object({
  version: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  items: z.array(jsonObject),
  views: z.array(jsonObject),
  icons: z.array(z.unknown()),
  colors: z.array(z.unknown()),
  fitToScreen: z.boolean().optional()
}).passthrough();

const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('replace_state'), state: stateSchema }),
  z.object({ type: z.literal('upsert_item'), item: jsonObject.and(z.object({ id: z.string().min(1), name: z.string().min(1) })) }),
  z.object({ type: z.literal('delete_item'), itemId: z.string().min(1) }),
  z.object({ type: z.literal('upsert_view'), view: jsonObject.and(z.object({ id: z.string().min(1) })) }),
  z.object({ type: z.literal('delete_view'), viewId: z.string().min(1) }),
  z.object({ type: z.literal('connect'), viewId: z.string().min(1), connector: jsonObject.and(z.object({ id: z.string().min(1) })) }),
  z.object({ type: z.literal('delete_connector'), viewId: z.string().min(1), connectorId: z.string().min(1) }),
  z.object({ type: z.literal('move_item'), viewId: z.string().min(1), itemId: z.string().min(1), tile: z.object({ x: z.number(), y: z.number() }).passthrough() })
]);

function toolSuccess(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(error: unknown) {
  const detail = error instanceof DomainError
    ? { code: error.code, message: error.message, status: error.status, details: error.details }
    : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
  return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify({ error: detail }) }], structuredContent: { error: detail } };
}

function registerTools(server: McpServer, service: DiagramService): void {
  server.registerTool('create_diagram', {
    title: 'Create diagram',
    description: 'Create an authoritative IsoForge diagram. An optional FossFLOW-compatible state may be supplied.',
    inputSchema: z.object({ id: z.string().optional(), title: z.string().min(1), description: z.string().optional(), state: stateSchema.optional() })
  }, async input => {
    try { return toolSuccess(await service.create(input as { id?: string; title: string; description?: string; state?: DiagramState }) as unknown as Record<string, unknown>); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('list_diagrams', {
    title: 'List diagrams',
    description: 'List persisted diagrams with their current monotonic revisions.',
    inputSchema: z.object({})
  }, async () => {
    try { return toolSuccess({ diagrams: await service.list() }); } catch (error) { return toolError(error); }
  });

  server.registerTool('get_diagram', {
    title: 'Get diagram',
    description: 'Get a complete persisted diagram record and FossFLOW-compatible model state.',
    inputSchema: z.object({ diagramId: z.string().min(1) })
  }, async ({ diagramId }) => {
    try { return toolSuccess(await service.get(diagramId) as unknown as Record<string, unknown>); } catch (error) { return toolError(error); }
  });

  server.registerTool('get_diagram_state', {
    title: 'Get diagram state',
    description: 'Get only the current revision, schema version, and canonical diagram state for optimistic writes.',
    inputSchema: z.object({ diagramId: z.string().min(1) })
  }, async ({ diagramId }) => {
    try {
      const record = await service.get(diagramId);
      return toolSuccess({ diagramId: record.id, schemaVersion: record.schemaVersion, revision: record.revision, state: record.state });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('apply_diagram_operations', {
    title: 'Atomically apply diagram operations',
    description: 'Atomically replace state, upsert/delete items or views, connect/delete connectors, and move items. expectedRevision prevents lost updates; idempotencyKey makes retries safe.',
    inputSchema: z.object({
      diagramId: z.string().min(1),
      expectedRevision: z.number().int().nonnegative(),
      idempotencyKey: z.string().min(1).max(200),
      operations: z.array(operationSchema).min(1).max(500)
    })
  }, async ({ diagramId, expectedRevision, idempotencyKey, operations }) => {
    try {
      return toolSuccess(await service.apply(diagramId, { expectedRevision, idempotencyKey, operations: operations as DiagramOperation[] }) as unknown as Record<string, unknown>);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('search_icons', {
    title: 'Search icons',
    description: 'Discover stable IsoForge/Isoflow icon identifiers by keyword and optional pack.',
    inputSchema: z.object({ query: z.string().default(''), pack: z.enum(['isoflow', 'aws', 'gcp']).optional(), limit: z.number().int().min(1).max(100).default(20) })
  }, async ({ query, pack, limit }) => toolSuccess({ icons: searchIcons(query, pack, limit) }));

  server.registerTool('export_diagram_json', {
    title: 'Export diagram JSON',
    description: 'Export canonical FossFLOW-compatible diagram state as formatted JSON with its acknowledged revision.',
    inputSchema: z.object({ diagramId: z.string().min(1) })
  }, async ({ diagramId }) => {
    try {
      const record = await service.get(diagramId);
      return toolSuccess({ diagramId, revision: record.revision, mediaType: 'application/json', json: JSON.stringify(record.state, null, 2) });
    } catch (error) { return toolError(error); }
  });
}

function createServer(env: IsoForgeEnv): McpServer {
  const server = new McpServer({ name: 'isoforge', version: '0.1.0' });
  registerTools(server, new DiagramService(env));
  return server;
}

const handlers = new WeakMap<object, McpHttpHandler>();

function handlerFor(env: IsoForgeEnv): McpHttpHandler {
  const key = env as object;
  let handler = handlers.get(key);
  if (!handler) {
    // celld follows the Workers timer surface and intentionally does not
    // provide setInterval. The SDK's optional SSE keepalive uses it, so turn
    // that heartbeat off while retaining the official stateless legacy path.
    handler = createMcpHandler(() => createServer(env), {
      legacy: 'stateless',
      keepAliveMs: 0
    });
    handlers.set(key, handler);
  }
  return handler;
}

function splitAllowlist(value: string | undefined): string[] {
  return (value ?? 'localhost,127.0.0.1,[::1]').split(',').map(item => item.trim()).filter(Boolean);
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right))
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < av.length; i++) difference |= av[i]! ^ bv[i]!;
  return difference === 0;
}

export async function serveMcp(request: Request, env: IsoForgeEnv): Promise<Response> {
  const rejected = hostHeaderValidationResponse(request, splitAllowlist(env.ALLOWED_HOSTS))
    ?? originValidationResponse(request, splitAllowlist(env.ALLOWED_ORIGINS));
  if (rejected) return rejected;

  let authInfo;
  if (env.MCP_BEARER_TOKEN) {
    const authorization = request.headers.get('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token || !(await constantTimeEqual(token, env.MCP_BEARER_TOKEN))) {
      return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing or invalid bearer token' }, id: null }, {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="isoforge-mcp"' }
      });
    }
    authInfo = { token, clientId: 'isoforge-local', scopes: ['mcp'] };
  }
  return handlerFor(env).fetch(request, { authInfo });
}
