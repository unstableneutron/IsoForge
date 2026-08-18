import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CelldDiagramClient,
  CelldRevisionConflict,
  CelldSnapshot,
  CelldSyncMessage,
  modelFingerprint
} from '../services/celldSyncService';

export type CelldSyncStatus =
  | 'idle'
  | 'connecting'
  | 'synchronized'
  | 'saving'
  | 'offline'
  | 'conflict';

export interface CelldDiagramSyncOptions<Model> {
  diagramId?: string;
  enabled?: boolean;
  readOnly?: boolean;
  onCanonicalModel: (model: Model, snapshot: CelldSnapshot<Model>) => void;
}

export interface CelldDiagramSyncState {
  revision: number;
  status: CelldSyncStatus;
  error: string | null;
}

export function useCelldDiagramSync<Model>({
  diagramId,
  enabled = true,
  readOnly = false,
  onCanonicalModel
}: CelldDiagramSyncOptions<Model>) {
  const callbackRef = useRef(onCanonicalModel);
  const clientRef = useRef<CelldDiagramClient<Model> | null>(null);
  const revisionRef = useRef(0);
  const hasSnapshotRef = useRef(false);
  const canonicalModelRef = useRef<Model | null>(null);
  const pendingModelRef = useRef<Model | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeTokenRef = useRef<symbol | null>(null);
  const flushPendingRef = useRef<() => void>(() => undefined);
  const [state, setState] = useState<CelldDiagramSyncState>({
    revision: 0,
    status: 'idle',
    error: null
  });

  useEffect(() => {
    callbackRef.current = onCanonicalModel;
  }, [onCanonicalModel]);

  useEffect(() => {
    if (!diagramId || !enabled) {
      clientRef.current?.disconnect();
      clientRef.current = null;
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
      pendingModelRef.current = null;
      writeTokenRef.current = null;
      revisionRef.current = 0;
      hasSnapshotRef.current = false;
      canonicalModelRef.current = null;
      setState({ revision: 0, status: 'idle', error: null });
      return;
    }

    let active = true;
    const client = new CelldDiagramClient<Model>(diagramId);
    clientRef.current = client;
    revisionRef.current = 0;
    hasSnapshotRef.current = false;
    canonicalModelRef.current = null;
    pendingModelRef.current = null;
    writeTokenRef.current = null;
    setState({ revision: 0, status: 'connecting', error: null });

    const acceptSnapshot = (
      snapshot: CelldSnapshot<Model>,
      source: 'http' | 'websocket'
    ) => {
      if (!active || clientRef.current !== client) return;

      // Revision zero is a real authoritative celld revision. The initial
      // HTTP load and WebSocket snapshot commonly race, so deduplicate zero
      // exactly like every later revision rather than inventing a revision.
      if (hasSnapshotRef.current && snapshot.revision <= revisionRef.current) {
        return;
      }

      const revision = snapshot.revision;

      revisionRef.current = Math.max(revisionRef.current, revision);
      hasSnapshotRef.current = true;
      canonicalModelRef.current = snapshot.model;
      pendingModelRef.current = null;
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
      setState({ revision: revisionRef.current, status: 'synchronized', error: null });

      callbackRef.current(snapshot.model, {
        ...snapshot,
        revision
      });
      void source;
    };

    const unsubscribe = client.onMessage((message: CelldSyncMessage<Model>) => {
      acceptSnapshot(message, 'websocket');
    });

    client.connect();
    client
      .loadSnapshot()
      .then((snapshot) => {
        acceptSnapshot(snapshot, 'http');
      })
      .catch((error: Error) => {
        if (!active || clientRef.current !== client) return;
        setState((current) => ({
          ...current,
          status: 'offline',
          error: error.message
        }));
      });

    return () => {
      active = false;
      unsubscribe();
      client.disconnect();
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
      pendingModelRef.current = null;
      writeTokenRef.current = null;
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [diagramId, enabled]);

  flushPendingRef.current = () => {
    if (writeTokenRef.current) return;
    const nextModel = pendingModelRef.current;
    const client = clientRef.current;
    if (!nextModel || !client) return;

    pendingModelRef.current = null;
    const token = Symbol('celld-write');
    writeTokenRef.current = token;
    setState((current) => ({ ...current, status: 'saving', error: null }));
    client
      .submitModel(nextModel, revisionRef.current)
      .then((snapshot) => {
        if (!snapshot || clientRef.current !== client) return;
        // The WebSocket broadcast can arrive before the HTTP acknowledgement.
        // Only apply a response that advances the canonical revision.
        if (
          hasSnapshotRef.current &&
          snapshot.revision <= revisionRef.current
        ) {
          return;
        }
        revisionRef.current = snapshot.revision;
        hasSnapshotRef.current = true;
        canonicalModelRef.current = snapshot.model;
        setState({
          revision: snapshot.revision,
          status: 'synchronized',
          error: null
        });
        callbackRef.current(snapshot.model, snapshot);
      })
      .catch((error: Error) => {
        if (clientRef.current !== client) return;
        if (error instanceof CelldRevisionConflict && error.canonical) {
          const canonical = error.canonical;
          revisionRef.current = canonical.revision;
          hasSnapshotRef.current = true;
          canonicalModelRef.current = canonical.model;
          // A queued model was derived from the losing revision. Do not
          // silently overwrite the freshly loaded canonical state.
          pendingModelRef.current = null;
          setState({
            revision: canonical.revision,
            status: 'conflict',
            error: error.message
          });
          callbackRef.current(canonical.model, canonical);
          return;
        }
        setState((current) => ({
          ...current,
          status: 'offline',
          error: error.message
        }));
      })
      .finally(() => {
        if (writeTokenRef.current !== token) return;
        writeTokenRef.current = null;
        if (pendingModelRef.current) flushPendingRef.current();
        else {
          setState((current) =>
            current.status === 'saving'
              ? { ...current, status: 'synchronized' }
              : current
          );
        }
      });
  };

  const submitLocalModel = useCallback(
    (model: Model) => {
      if (!diagramId || !enabled || readOnly) return;

      // The first REST snapshot establishes the server revision. Do not let
      // FossFLOW's initial render overwrite an authoritative diagram while it
      // is still being loaded.
      if (!hasSnapshotRef.current) return;

      // FossFLOW can report the model again while it is applying a new
      // initialData prop. Do not turn that canonical apply into a write echo.
      if (
        canonicalModelRef.current &&
        modelFingerprint(canonicalModelRef.current) === modelFingerprint(model)
      ) {
        return;
      }

      pendingModelRef.current = model;
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = setTimeout(() => {
        pendingTimerRef.current = null;
        flushPendingRef.current();
      }, 150);
    },
    [diagramId, enabled, readOnly]
  );

  return {
    ...state,
    submitLocalModel
  };
}
