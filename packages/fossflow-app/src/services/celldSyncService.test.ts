import { describe, expect, it, vi } from 'vitest';
import {
  CelldDiagramClient,
  CelldRevisionConflict,
  normalizeCelldMessage,
  normalizeCelldSnapshot
} from './celldSyncService';

const model = {
  title: 'System',
  icons: [],
  colors: [],
  items: [],
  views: []
};

describe('celld synchronization protocol', () => {
  it('normalizes authoritative REST and WebSocket envelopes', () => {
    expect(normalizeCelldSnapshot({ id: 'd1', revision: 0, state: model }, 'd1')).toEqual({ id: 'd1', revision: 0, model });
    expect(normalizeCelldMessage({ type: 'diagram.patch', revision: 2, state: model }, 'd1')).toEqual({ type: 'change', id: 'd1', revision: 2, model });
  });

  it('submits a relative, revisioned, idempotent replacement batch', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ diagramId: 'd1', previousRevision: 3, revision: 4, state: model }));
    const client = new CelldDiagramClient<typeof model>('d1', { fetchImpl: fetchImpl as typeof fetch });
    await expect(client.submitModel(model, 3)).resolves.toMatchObject({ id: 'd1', revision: 4, model });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('/api/diagrams/d1/operations');
    const body = JSON.parse(String(init?.body));
    expect(body.expectedRevision).toBe(3);
    expect(body.idempotencyKey).toBeTruthy();
    expect(body.operations).toEqual([{ type: 'replace_state', state: model }]);
  });

  it('binds the native fetch receiver before storing it on the client', async () => {
    const originalFetch = globalThis.fetch;
    const receiverCheckingFetch = vi.fn(function (this: typeof globalThis, input: RequestInfo | URL) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(Response.json({ id: 'd1', revision: 0, state: model }));
    });
    globalThis.fetch = receiverCheckingFetch as typeof fetch;
    try {
      const client = new CelldDiagramClient<typeof model>('d1');
      await expect(client.loadSnapshot()).resolves.toMatchObject({ revision: 0, model });
      expect(receiverCheckingFetch).toHaveBeenCalledWith('/api/diagrams/d1', expect.any(Object));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reloads the canonical snapshot after an explicit conflict', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'REVISION_CONFLICT' } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ id: 'd1', revision: 7, state: model }));
    const client = new CelldDiagramClient<typeof model>('d1', { fetchImpl: fetchImpl as typeof fetch });
    await expect(client.submitModel(model, 5)).rejects.toMatchObject({
      name: CelldRevisionConflict.name,
      canonical: { revision: 7, model }
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/diagrams/d1');
  });
});
