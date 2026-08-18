export interface DiagramState {
  version?: string;
  title: string;
  description?: string;
  items: ModelItem[];
  views: DiagramView[];
  icons: unknown[];
  colors: unknown[];
  fitToScreen?: boolean;
  [key: string]: unknown;
}

export interface ModelItem {
  id: string;
  name: string;
  icon?: string;
  [key: string]: unknown;
}

export interface DiagramView {
  id: string;
  name?: string;
  items?: ViewItem[];
  connectors?: Connector[];
  [key: string]: unknown;
}

export interface ViewItem {
  id: string;
  tile: { x: number; y: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Connector {
  id: string;
  anchors?: Array<{ ref?: { item?: string }; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type DiagramOperation =
  | { type: 'replace_state'; state: DiagramState }
  | { type: 'upsert_item'; item: ModelItem }
  | { type: 'delete_item'; itemId: string }
  | { type: 'upsert_view'; view: DiagramView }
  | { type: 'delete_view'; viewId: string }
  | { type: 'connect'; viewId: string; connector: Connector }
  | { type: 'delete_connector'; viewId: string; connectorId: string }
  | { type: 'move_item'; viewId: string; itemId: string; tile: ViewItem['tile'] };

export interface DiagramRecord {
  id: string;
  schemaVersion: number;
  revision: number;
  state: DiagramState;
  createdAt: string;
  updatedAt: string;
}

export interface DiagramSummary {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApplyRequest {
  expectedRevision: number;
  idempotencyKey: string;
  operations: DiagramOperation[];
}

export interface ApplyResult {
  diagramId: string;
  previousRevision: number;
  revision: number;
  idempotentReplay: boolean;
  state: DiagramState;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
