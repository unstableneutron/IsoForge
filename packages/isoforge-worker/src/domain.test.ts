import { describe, expect, it } from 'vitest';
import { applyOperations, emptyDiagram, sha256 } from './domain';

describe('diagram operations', () => {
  it('applies a coherent batch without mutating the input', () => {
    const current = emptyDiagram('Network');
    const next = applyOperations(current, [
      { type: 'upsert_item', item: { id: 'api', name: 'API', icon: 'server' } },
      { type: 'upsert_view', view: { id: 'main', name: 'Main', items: [{ id: 'api', tile: { x: 1, y: 2 } }], connectors: [] } },
      { type: 'move_item', viewId: 'main', itemId: 'api', tile: { x: 4, y: 5 } }
    ]);
    expect(current.items).toEqual([]);
    expect(next.items[0]?.id).toBe('api');
    expect(next.views[0]?.items?.[0]?.tile).toEqual({ x: 4, y: 5 });
  });

  it('cascades deleted model items from placements and connectors', () => {
    const current = applyOperations(emptyDiagram('Network'), [
      { type: 'upsert_item', item: { id: 'api', name: 'API' } },
      { type: 'upsert_view', view: { id: 'main', items: [{ id: 'api', tile: { x: 0, y: 0 } }], connectors: [{ id: 'c', anchors: [{ ref: { item: 'api' } }] }] } }
    ]);
    const next = applyOperations(current, [{ type: 'delete_item', itemId: 'api' }]);
    expect(next.items).toHaveLength(0);
    expect(next.views[0]?.items).toHaveLength(0);
    expect(next.views[0]?.connectors).toHaveLength(0);
  });

  it('hashes semantically identical request objects identically', async () => {
    await expect(sha256({ b: 2, a: 1 })).resolves.toBe(await sha256({ a: 1, b: 2 }));
  });
});
