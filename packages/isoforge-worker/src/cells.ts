import { applyOperations, canonicalJson, DomainError, sha256, validateDiagramState } from './domain';
import { errorResponse, json, readJson } from './http';
import type { ApplyRequest, ApplyResult, DiagramRecord, DiagramState, DiagramSummary } from './types';

interface DiagramRow {
  id: string;
  schema_version: number;
  revision: number;
  state_json: string;
  created_at: string;
  updated_at: string;
}

interface IdempotencyRow {
  request_hash: string;
  response_json: string;
}

function recordFromRow(row: DiagramRow): DiagramRecord {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    revision: row.revision,
    state: JSON.parse(row.state_json) as DiagramState,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class DiagramCell {
  private readonly sql: SqlStorage;

  constructor(private readonly state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS diagram (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS changes (
      revision INTEGER PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      resulting_state_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

  private getRecord(): DiagramRecord {
    const rows = this.sql.exec('SELECT id, schema_version, revision, state_json, created_at, updated_at FROM diagram WHERE singleton = 1').toArray() as unknown as DiagramRow[];
    if (!rows[0]) throw new DomainError('DIAGRAM_NOT_FOUND', 'Diagram not found', 404);
    return recordFromRow(rows[0]);
  }

  private async create(request: Request): Promise<Response> {
    const body = await readJson<{ id: string; state: DiagramState }>(request);
    if (!body.id?.trim()) throw new DomainError('INVALID_DIAGRAM_ID', 'Diagram id is required');
    validateDiagramState(body.state);
    const now = new Date().toISOString();
    try {
      this.sql.exec(
        'INSERT INTO diagram(singleton, id, schema_version, revision, state_json, created_at, updated_at) VALUES (1, ?, 1, 0, ?, ?, ?)',
        body.id,
        canonicalJson(body.state),
        now,
        now
      );
    } catch (error) {
      if (String(error).toLowerCase().includes('unique')) {
        const record = this.getRecord();
        if (record.id === body.id) return json(record, 200);
        throw new DomainError('DIAGRAM_EXISTS', 'This diagram cell is already initialized', 409);
      }
      throw error;
    }
    return json(this.getRecord(), 201);
  }

  private async apply(request: Request): Promise<Response> {
    const body = await readJson<ApplyRequest>(request);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
      throw new DomainError('INVALID_EXPECTED_REVISION', 'expectedRevision must be a non-negative integer');
    }
    if (!body.idempotencyKey?.trim() || body.idempotencyKey.length > 200) {
      throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must contain 1-200 characters');
    }
    const requestHash = await sha256({ expectedRevision: body.expectedRevision, operations: body.operations });
    const replayRows = this.sql.exec('SELECT request_hash, response_json FROM idempotency WHERE key = ?', body.idempotencyKey).toArray() as unknown as IdempotencyRow[];
    if (replayRows[0]) {
      if (replayRows[0].request_hash !== requestHash) {
        throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used for a different request', 409);
      }
      const replay = JSON.parse(replayRows[0].response_json) as ApplyResult;
      return json({ ...replay, idempotentReplay: true });
    }

    const current = this.getRecord();
    if (current.revision !== body.expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', `Expected revision ${body.expectedRevision}, current revision is ${current.revision}`, 409, {
        expectedRevision: body.expectedRevision,
        currentRevision: current.revision
      });
    }
    const nextState = applyOperations(current.state, body.operations);
    const now = new Date().toISOString();
    const revision = current.revision + 1;
    const result: ApplyResult = {
      diagramId: current.id,
      previousRevision: current.revision,
      revision,
      idempotentReplay: false,
      state: nextState
    };
    const responseJson = canonicalJson(result);
    this.state.storage.transactionSync(() => {
      this.sql.exec('UPDATE diagram SET revision = ?, state_json = ?, updated_at = ? WHERE singleton = 1 AND revision = ?', revision, canonicalJson(nextState), now, current.revision);
      this.sql.exec(
        'INSERT INTO changes(revision, idempotency_key, request_hash, operations_json, resulting_state_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        revision, body.idempotencyKey, requestHash, canonicalJson(body.operations), canonicalJson(nextState), now
      );
      this.sql.exec(
        'INSERT INTO idempotency(key, request_hash, revision, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
        body.idempotencyKey, requestHash, revision, responseJson, now
      );
    });

    const event = JSON.stringify({ type: 'diagram.patch', diagramId: current.id, previousRevision: current.revision, revision, operations: body.operations, state: nextState });
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(event); } catch { /* host removes closed sockets */ }
    }
    return json(result);
  }

  private webSocket(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      throw new DomainError('WEBSOCKET_UPGRADE_REQUIRED', 'WebSocket upgrade required', 426);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const record = this.getRecord();
    server.send(JSON.stringify({ type: 'diagram.snapshot', diagramId: record.id, revision: record.revision, state: record.state }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === 'string' && message === 'ping') socket.send('pong');
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path === '/internal/create') return await this.create(request);
      if (request.method === 'GET' && path === '/internal/record') return json(this.getRecord());
      if (request.method === 'POST' && path === '/internal/apply') return await this.apply(request);
      if (request.method === 'GET' && path === '/internal/ws') return this.webSocket(request);
      throw new DomainError('NOT_FOUND', 'Route not found', 404);
    } catch (error) {
      return errorResponse(error);
    }
  }
}

interface SummaryRow {
  id: string;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export class DiagramCatalog {
  private readonly sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS diagrams (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/internal/list') {
        const rows = this.sql.exec('SELECT id, title, revision, created_at, updated_at FROM diagrams ORDER BY updated_at DESC, id').toArray() as unknown as SummaryRow[];
        return json(rows.map(row => ({ id: row.id, title: row.title, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } satisfies DiagramSummary)));
      }
      if (request.method === 'PUT' && path === '/internal/summary') {
        const summary = await readJson<DiagramSummary>(request);
        this.sql.exec(
          `INSERT INTO diagrams(id, title, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, revision = excluded.revision, updated_at = excluded.updated_at
           WHERE excluded.revision >= diagrams.revision`,
          summary.id, summary.title, summary.revision, summary.createdAt, summary.updatedAt
        );
        return json(summary);
      }
      throw new DomainError('NOT_FOUND', 'Route not found', 404);
    } catch (error) {
      return errorResponse(error);
    }
  }
}
