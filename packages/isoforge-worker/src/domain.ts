import type { DiagramOperation, DiagramState } from './types';

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function emptyDiagram(title: string, description?: string): DiagramState {
  return {
    version: '1.0',
    title,
    ...(description ? { description } : {}),
    items: [],
    views: [{ id: 'main', name: 'Main', items: [], connectors: [] }],
    icons: [],
    colors: []
  };
}

export function validateDiagramState(value: unknown): asserts value is DiagramState {
  if (!value || typeof value !== 'object') throw new DomainError('INVALID_STATE', 'Diagram state must be an object');
  const state = value as Partial<DiagramState>;
  if (typeof state.title !== 'string' || !state.title.trim()) throw new DomainError('INVALID_STATE', 'Diagram title is required');
  for (const field of ['items', 'views', 'icons', 'colors'] as const) {
    if (!Array.isArray(state[field])) throw new DomainError('INVALID_STATE', `Diagram ${field} must be an array`);
  }
  const ids = new Set<string>();
  for (const item of state.items!) {
    if (!item || typeof item.id !== 'string' || !item.id) throw new DomainError('INVALID_STATE', 'Every model item needs a non-empty id');
    if (ids.has(item.id)) throw new DomainError('INVALID_STATE', `Duplicate model item id: ${item.id}`);
    ids.add(item.id);
  }
}

function upsert<T extends { id: string }>(values: T[], value: T): T[] {
  const index = values.findIndex(candidate => candidate.id === value.id);
  if (index < 0) return [...values, structuredClone(value)];
  const copy = values.slice();
  copy[index] = structuredClone(value);
  return copy;
}

export function applyOperations(current: DiagramState, operations: DiagramOperation[]): DiagramState {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new DomainError('INVALID_OPERATIONS', 'At least one operation is required');
  }
  let next = structuredClone(current);
  for (const operation of operations) {
    switch (operation.type) {
      case 'replace_state':
        validateDiagramState(operation.state);
        next = structuredClone(operation.state);
        break;
      case 'upsert_item':
        if (!operation.item?.id) throw new DomainError('INVALID_OPERATION', 'upsert_item requires item.id');
        next.items = upsert(next.items, operation.item);
        break;
      case 'delete_item':
        next.items = next.items.filter(item => item.id !== operation.itemId);
        next.views = next.views.map(view => ({
          ...view,
          items: (view.items ?? []).filter(item => item.id !== operation.itemId),
          connectors: (view.connectors ?? []).filter(connector =>
            !(connector.anchors ?? []).some(anchor => anchor.ref?.item === operation.itemId)
          )
        }));
        break;
      case 'upsert_view':
        if (!operation.view?.id) throw new DomainError('INVALID_OPERATION', 'upsert_view requires view.id');
        next.views = upsert(next.views, operation.view);
        break;
      case 'delete_view':
        next.views = next.views.filter(view => view.id !== operation.viewId);
        break;
      case 'connect': {
        const view = next.views.find(candidate => candidate.id === operation.viewId);
        if (!view) throw new DomainError('VIEW_NOT_FOUND', `View not found: ${operation.viewId}`, 404);
        view.connectors = upsert(view.connectors ?? [], operation.connector);
        break;
      }
      case 'delete_connector': {
        const view = next.views.find(candidate => candidate.id === operation.viewId);
        if (!view) throw new DomainError('VIEW_NOT_FOUND', `View not found: ${operation.viewId}`, 404);
        view.connectors = (view.connectors ?? []).filter(connector => connector.id !== operation.connectorId);
        break;
      }
      case 'move_item': {
        const view = next.views.find(candidate => candidate.id === operation.viewId);
        if (!view) throw new DomainError('VIEW_NOT_FOUND', `View not found: ${operation.viewId}`, 404);
        const item = (view.items ?? []).find(candidate => candidate.id === operation.itemId);
        if (!item) throw new DomainError('VIEW_ITEM_NOT_FOUND', `Item ${operation.itemId} is not placed in view ${operation.viewId}`, 404);
        item.tile = structuredClone(operation.tile);
        break;
      }
      default:
        throw new DomainError('UNKNOWN_OPERATION', `Unknown operation: ${(operation as { type?: string }).type ?? '<missing>'}`);
    }
  }
  validateDiagramState(next);
  return next;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
