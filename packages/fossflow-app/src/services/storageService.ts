import { Model } from 'fossflow/dist/types';
import {
  buildModelUpdateBatch,
  makeIdempotencyKey,
  normalizeCelldSnapshot
} from './celldSyncService';

export interface DiagramInfo {
  id: string;
  name: string;
  lastModified: Date;
  size?: number;
}

export interface StorageService {
  isAvailable(): Promise<boolean>;
  listDiagrams(): Promise<DiagramInfo[]>;
  loadDiagram(id: string): Promise<Model>;
  saveDiagram(id: string, data: Model): Promise<void>;
  deleteDiagram(id: string): Promise<void>;
  createDiagram(data: Model): Promise<string>;
}

// Server Storage Implementation
class ServerStorage implements StorageService {
  // The app and celld are deployed behind the same origin. Keeping this
  // relative is important for local Compose, reverse proxies, and hosted
  // subpaths alike.
  private readonly baseUrl = '';
  private available: boolean | null = null;
  private availabilityCheckedAt: number | null = null;
  private readonly AVAILABILITY_CACHE_MS = 60000; // Re-check every 60 seconds
  private readonly revisions = new Map<string, number>();

  async isAvailable(): Promise<boolean> {
    // Re-check availability if cache is stale
    const now = Date.now();
    if (this.available !== null &&
        this.availabilityCheckedAt !== null &&
        (now - this.availabilityCheckedAt) < this.AVAILABILITY_CACHE_MS) {
      return this.available;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/diagrams`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });
      this.available = response.ok;
      this.availabilityCheckedAt = Date.now();
      console.log(`Server storage availability: ${this.available}`);
      return this.available ?? false;
    } catch (error) {
      console.log('Server storage not available:', error);
      this.available = false;
      this.availabilityCheckedAt = Date.now();
      return false;
    }
  }

  async listDiagrams(): Promise<DiagramInfo[]> {
    console.log(`Fetching diagrams from: ${this.baseUrl}/api/diagrams`);
    const response = await fetch(`${this.baseUrl}/api/diagrams`);
    console.log(`Response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to list diagrams:', errorText);
      throw new Error(`Failed to list diagrams: ${response.status} ${errorText}`);
    }

    const payload = await response.json();
    const diagrams = Array.isArray(payload) ? payload : payload.diagrams || [];
    console.log(`Received ${diagrams.length} diagrams from server:`, diagrams);

    return diagrams.map((d: any) => ({
      ...d,
      name: d.name || d.title || 'Untitled Diagram',
      lastModified: new Date(d.lastModified || d.updatedAt)
    }));
  }

  async loadDiagram(id: string): Promise<Model> {
    console.log(`ServerStorage: Loading diagram ${id} from ${this.baseUrl}/api/diagrams/${id}`);
    try {
      const response = await fetch(`${this.baseUrl}/api/diagrams/${id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`ServerStorage: Failed to load diagram ${id}: ${response.status} ${errorText}`);
        throw new Error(`Failed to load diagram: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      console.log(
        `ServerStorage: Successfully loaded diagram ${id}, items: ${data.items?.length || data.model?.items?.length || 0}`
      );
      // celld returns a revisioned snapshot while the legacy backend returns
      // the FossFLOW model directly. Accept both at this storage boundary.
      try {
        const snapshot = normalizeCelldSnapshot<Model>(data, id);
        this.revisions.set(id, snapshot.revision);
        return snapshot.model;
      } catch {
        return data;
      }
    } catch (error) {
      console.error(`ServerStorage: Error loading diagram ${id}:`, error);
      throw error;
    }
  }

  async saveDiagram(id: string, data: Model): Promise<void> {
    console.log(`ServerStorage: Saving diagram ${id}`);
    try {
      const idempotencyKey = makeIdempotencyKey();
      const revision = this.revisions.get(id) ?? 0;
      let response = await fetch(`${this.baseUrl}/api/diagrams/${id}/operations`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(
          buildModelUpdateBatch(data, revision, idempotencyKey)
        ),
        signal: AbortSignal.timeout(15000) // 15 second timeout for saves
      });

      // The old FossFLOW backend has no revisioned operation endpoint.
      if (response.status === 404 || response.status === 405) {
        response = await fetch(`${this.baseUrl}/api/diagrams/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(15000)
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`ServerStorage: Failed to save diagram ${id}: ${response.status} ${errorText}`);
        throw new Error(`Failed to save diagram: ${response.status}`);
      }

      try {
        const result = await response.json();
        const snapshot = normalizeCelldSnapshot<Model>(result, id);
        this.revisions.set(id, snapshot.revision);
      } catch {
        // Legacy PUT may acknowledge with { success: true }.
      }

      console.log(`ServerStorage: Successfully saved diagram ${id}`);
    } catch (error) {
      console.error(`ServerStorage: Error saving diagram ${id}:`, error);
      throw error;
    }
  }

  async deleteDiagram(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/diagrams/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) throw new Error('Failed to delete diagram');
  }

  async createDiagram(data: Model): Promise<string> {
    const title = (data as any).name || data.title;
    const response = await fetch(`${this.baseUrl}/api/diagrams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        id: (data as any).id,
        title,
        state: { ...data, title }
      })
    });
    if (!response.ok) throw new Error('Failed to create diagram');
    const result = await response.json();
    return result.id;
  }
}

// Session Storage Implementation (existing functionality)
class SessionStorage implements StorageService {
  private readonly KEY_PREFIX = 'fossflow_diagram_';
  private readonly LIST_KEY = 'fossflow_diagrams';

  async isAvailable(): Promise<boolean> {
    return true; // Session storage is always available
  }

  async listDiagrams(): Promise<DiagramInfo[]> {
    const listStr = sessionStorage.getItem(this.LIST_KEY);
    if (!listStr) return [];
    
    const list = JSON.parse(listStr);
    return list.map((item: any) => ({
      ...item,
      lastModified: new Date(item.lastModified)
    }));
  }

  async loadDiagram(id: string): Promise<Model> {
    const data = sessionStorage.getItem(`${this.KEY_PREFIX}${id}`);
    if (!data) throw new Error('Diagram not found');
    return JSON.parse(data);
  }

  async saveDiagram(id: string, data: Model): Promise<void> {
    sessionStorage.setItem(`${this.KEY_PREFIX}${id}`, JSON.stringify(data));
    
    // Update list
    const list = await this.listDiagrams();
    const existing = list.findIndex(d => d.id === id);
    const info: DiagramInfo = {
      id,
      name: (data as any).name || 'Untitled Diagram',
      lastModified: new Date(),
      size: JSON.stringify(data).length
    };
    
    if (existing >= 0) {
      list[existing] = info;
    } else {
      list.push(info);
    }
    
    sessionStorage.setItem(this.LIST_KEY, JSON.stringify(list));
  }

  async deleteDiagram(id: string): Promise<void> {
    sessionStorage.removeItem(`${this.KEY_PREFIX}${id}`);
    
    // Update list
    const list = await this.listDiagrams();
    const filtered = list.filter(d => d.id !== id);
    sessionStorage.setItem(this.LIST_KEY, JSON.stringify(filtered));
  }

  async createDiagram(data: Model): Promise<string> {
    const id = `diagram_${Date.now()}`;
    await this.saveDiagram(id, data);
    return id;
  }
}

// Storage Manager - decides which storage to use
class StorageManager {
  private serverStorage: ServerStorage;
  private sessionStorage: SessionStorage;
  private activeStorage: StorageService | null = null;

  constructor() {
    this.serverStorage = new ServerStorage();
    this.sessionStorage = new SessionStorage();
  }

  async initialize(): Promise<StorageService> {
    // Try server storage first
    if (await this.serverStorage.isAvailable()) {
      console.log('Using server storage');
      this.activeStorage = this.serverStorage;
    } else {
      console.log('Using session storage');
      this.activeStorage = this.sessionStorage;
    }
    return this.activeStorage;
  }

  getStorage(): StorageService {
    if (!this.activeStorage) {
      throw new Error('Storage not initialized. Call initialize() first.');
    }
    return this.activeStorage;
  }

  isServerStorage(): boolean {
    return this.activeStorage === this.serverStorage;
  }
}

// Export singleton instance
export const storageManager = new StorageManager();
