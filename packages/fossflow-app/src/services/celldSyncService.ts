/**
 * Small, diagram-scoped client for the IsoForge celld HTTP/WebSocket API.
 *
 * The browser deliberately has no service origin configuration.  REST and
 * WebSocket traffic stay on the origin that served the app so the same build
 * works behind a reverse proxy and in the local Compose deployment.
 */

export interface CelldSnapshot<Model> {
  id: string;
  revision: number;
  model: Model;
  name?: string;
}

export interface CelldSyncMessage<Model> {
  type: 'snapshot' | 'change';
  revision: number;
  model: Model;
  id: string;
  name?: string;
}

export interface ModelReplacement<Model> {
  type: 'replace_state';
  state: Model;
}

export interface ModelUpdateBatch<Model> {
  expectedRevision: number;
  idempotencyKey: string;
  operations: Array<ModelReplacement<Model>>;
}

export class CelldRevisionConflict<Model> extends Error {
  readonly canonical: CelldSnapshot<Model> | null;

  constructor(canonical: CelldSnapshot<Model> | null) {
    super('The diagram changed on the server. The canonical snapshot was loaded.');
    this.name = 'CelldRevisionConflict';
    this.canonical = canonical;
  }
}

type FetchLike = typeof fetch;
type WebSocketLike = new (url: string) => WebSocket;

const isObject = (value: unknown): value is Record<string, any> => {
  return typeof value === 'object' && value !== null;
};

const isFossflowModel = (value: unknown): boolean => {
  return (
    isObject(value) &&
    Array.isArray(value.icons) &&
    Array.isArray(value.colors) &&
    Array.isArray(value.items) &&
    Array.isArray(value.views)
  );
};

const asRevision = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
};

function findRevision(value: unknown): number {
  if (!isObject(value)) return 0;

  // Do not treat FossFLOW's model `version` field as the celld revision.
  for (const key of ['revision', 'rev', 'sequence']) {
    const revision = asRevision(value[key]);
    if (revision !== null) return revision;
  }

  for (const key of ['snapshot', 'change', 'data', 'payload']) {
    if (isObject(value[key])) {
      const revision = findRevision(value[key]);
      if (revision > 0) return revision;
    }
  }

  return 0;
}

function findModel(value: unknown, depth = 0): any | null {
  if (isFossflowModel(value)) return value;
  if (!isObject(value) || depth > 3) return null;

  for (const key of [
    'model',
    'data',
    'state',
    'diagram',
    'snapshot',
    'change',
    'replacement',
    'fullModel',
    'value',
    'payload'
  ]) {
    const candidate = findModel(value[key], depth + 1);
    if (candidate) return candidate;
  }

  // A change batch may contain a replacement/upsert operation rather than a
  // direct model field.  Only accept an operation that carries a complete
  // FossFLOW model; partial patches must never be guessed at client-side.
  for (const key of ['changes', 'operations', 'upserts', 'batch']) {
    const operations = value[key];
    if (!Array.isArray(operations)) continue;
    for (const operation of operations) {
      const candidate = findModel(operation, depth + 1);
      if (candidate) return candidate;
    }
  }

  return null;
}

export function normalizeCelldSnapshot<Model>(
  payload: unknown,
  id: string
): CelldSnapshot<Model> {
  const model = findModel(payload);
  if (!model) {
    throw new Error('The celld response did not contain a FossFLOW model.');
  }

  const source = isObject(payload) ? payload : {};
  const name = typeof source.name === 'string' ? source.name : undefined;

  return {
    id,
    revision: findRevision(payload),
    model: model as Model,
    name
  };
}

export function normalizeCelldMessage<Model>(
  payload: unknown,
  id: string
): CelldSyncMessage<Model> | null {
  if (!isObject(payload)) return null;

  const rawType = typeof payload.type === 'string' ? payload.type : '';
  const type =
    rawType === 'diagram.snapshot'
      ? 'snapshot'
      : rawType === 'diagram.patch'
        ? 'change'
        : rawType;
  if (type !== 'snapshot' && type !== 'change') return null;

  const model = findModel(payload);
  if (!model) return null;

  return {
    type,
    id,
    revision: findRevision(payload),
    model: model as Model,
    name: typeof payload.name === 'string' ? payload.name : undefined
  };
}

export function makeIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto as Crypto & {
    randomUUID?: () => string;
  };

  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  return `isoforge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function modelFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function buildModelUpdateBatch<Model>(
  model: Model,
  expectedRevision: number,
  idempotencyKey = makeIdempotencyKey()
): ModelUpdateBatch<Model> {
  return {
    expectedRevision,
    idempotencyKey,
    operations: [{ type: 'replace_state', state: model }]
  };
}

export class CelldDiagramClient<Model> {
  private readonly id: string;
  private readonly fetchImpl: FetchLike;
  private readonly webSocketFactory: WebSocketLike;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private messageHandler: ((message: CelldSyncMessage<Model>) => void) | null = null;

  constructor(
    id: string,
    options: {
      fetchImpl?: FetchLike;
      webSocketFactory?: WebSocketLike;
    } = {}
  ) {
    this.id = id;
    // Browser fetch performs a Web-IDL receiver check. Binding it here avoids
    // an illegal invocation when it is later called as this.fetchImpl(...).
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.webSocketFactory = options.webSocketFactory || WebSocket;
  }

  onMessage(handler: (message: CelldSyncMessage<Model>) => void): () => void {
    this.messageHandler = handler;
    return () => {
      if (this.messageHandler === handler) this.messageHandler = null;
    };
  }

  async loadSnapshot(): Promise<CelldSnapshot<Model>> {
    const response = await this.fetchImpl(
      `/api/diagrams/${encodeURIComponent(this.id)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to load diagram ${this.id}: ${response.status}`);
    }

    return normalizeCelldSnapshot<Model>(await response.json(), this.id);
  }

  async submitModel(
    model: Model,
    expectedRevision: number
  ): Promise<CelldSnapshot<Model> | null> {
    const idempotencyKey = makeIdempotencyKey();
    const batch = buildModelUpdateBatch(model, expectedRevision, idempotencyKey);
    const request = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(batch)
    };

    let response = await this.fetchImpl(
      `/api/diagrams/${encodeURIComponent(this.id)}/operations`,
      request
    );

    // Keep compatibility with the legacy FossFLOW backend that exposes PUT on
    // the diagram resource. Both URLs remain same-origin and relative.
    if (response.status === 404 || response.status === 405) {
      response = await this.fetchImpl(
        `/api/diagrams/${encodeURIComponent(this.id)}`,
        {
          method: 'PUT',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(model)
        }
      );
    }

    if (response.status === 409) {
      let canonical: CelldSnapshot<Model> | null = null;
      try {
        const body = await response.json();
        canonical = normalizeCelldSnapshot<Model>(body, this.id);
      } catch {
        // Some adapters return an empty conflict response. The GET below is
        // the authoritative fallback required by the sync contract.
      }

      if (!canonical) canonical = await this.loadSnapshot();
      throw new CelldRevisionConflict(canonical);
    }

    if (!response.ok) {
      throw new Error(`Failed to update diagram ${this.id}: ${response.status}`);
    }

    if (response.status === 204) return null;

    try {
      return normalizeCelldSnapshot<Model>(await response.json(), this.id);
    } catch {
      // A successful write may acknowledge with no snapshot. The websocket
      // broadcast remains the source of the committed revision.
      return null;
    }
  }

  connect(): void {
    if (this.stopped || this.socket) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/diagrams/${encodeURIComponent(this.id)}`;
    const socket = new this.webSocketFactory(url);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
    };
    socket.onmessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(String(event.data));
        const message = normalizeCelldMessage<Model>(payload, this.id);
        if (message) this.messageHandler?.(message);
      } catch (error) {
        console.warn('IsoForge sync received an invalid WebSocket message', error);
      }
    };
    socket.onerror = () => {
      // onclose owns reconnect scheduling; browsers commonly emit both.
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
