import { DomainError, emptyDiagram, validateDiagramState } from './domain';
import type { ApplyRequest, ApplyResult, DiagramRecord, DiagramState, DiagramSummary } from './types';

export interface IsoForgeEnv {
  DIAGRAMS: CellNamespace;
  CATALOG: CellNamespace;
  ASSETS?: Fetcher;
  MCP_BEARER_TOKEN?: string;
  ALLOWED_HOSTS?: string;
  ALLOWED_ORIGINS?: string;
}

interface CellStub {
  fetch(request: Request): Promise<Response>;
}

interface CellNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): CellStub;
}

async function decode<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
  if (!response.ok) {
    throw new DomainError(body.error?.code ?? 'UPSTREAM_ERROR', body.error?.message ?? `Request failed with status ${response.status}`, response.status, body.error?.details);
  }
  return body;
}

export class DiagramService {
  constructor(private readonly env: IsoForgeEnv) {}

  private diagram(id: string): CellStub {
    return this.env.DIAGRAMS.get(this.env.DIAGRAMS.idFromName(id));
  }

  private catalog(): CellStub {
    return this.env.CATALOG.get(this.env.CATALOG.idFromName('catalog'));
  }

  async create(input: { id?: string; title: string; description?: string; state?: DiagramState }): Promise<DiagramRecord> {
    const id = input.id?.trim() || crypto.randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new DomainError('INVALID_DIAGRAM_ID', 'Diagram id must be 1-128 URL-safe characters');
    }
    const state = input.state ?? emptyDiagram(input.title, input.description);
    validateDiagramState(state);
    const response = await this.diagram(id).fetch(new Request('http://cell/internal/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, state })
    }));
    const record = await decode<DiagramRecord>(response);
    await this.updateCatalog(record);
    return record;
  }

  async get(id: string): Promise<DiagramRecord> {
    return decode(await this.diagram(id).fetch(new Request('http://cell/internal/record')));
  }

  async list(): Promise<DiagramSummary[]> {
    return decode(await this.catalog().fetch(new Request('http://catalog/internal/list')));
  }

  async apply(id: string, request: ApplyRequest): Promise<ApplyResult> {
    const response = await this.diagram(id).fetch(new Request('http://cell/internal/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
    }));
    const result = await decode<ApplyResult>(response);
    await this.updateCatalog(await this.get(id));
    return result;
  }

  async webSocket(id: string, request: Request): Promise<Response> {
    const internal = new URL(request.url);
    internal.pathname = '/internal/ws';
    return this.diagram(id).fetch(new Request(internal, request));
  }

  private async updateCatalog(record: DiagramRecord): Promise<void> {
    const previous = (await this.list()).find(item => item.id === record.id);
    const summary: DiagramSummary = {
      id: record.id,
      title: record.state.title,
      revision: record.revision,
      createdAt: record.createdAt || previous?.createdAt || record.updatedAt,
      updatedAt: record.updatedAt
    };
    await decode(await this.catalog().fetch(new Request('http://catalog/internal/summary', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary)
    })));
  }
}
