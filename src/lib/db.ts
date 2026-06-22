import Dexie, { type Table } from 'dexie';
import type { Schedule, Session, Workspace } from './types';

/**
 * Local-first store. Sessions live in IndexedDB (via Dexie) so we can hold
 * thousands of sessions/tabs without hitting chrome.storage quotas.
 */
export class SessflowDB extends Dexie {
  sessions!: Table<Session, string>;
  workspaces!: Table<Workspace, string>;
  schedules!: Table<Schedule, string>;

  constructor() {
    super('sessflow');
    this.version(1).stores({
      // indexed fields for fast querying / sorting
      sessions: 'id, name, kind, createdAt, updatedAt, deletedAt, *tags, dirty',
    });
    this.version(2).stores({
      sessions: 'id, name, kind, createdAt, updatedAt, deletedAt, workspaceId, favorite, *tags, dirty',
      workspaces: 'id, name, createdAt',
      schedules: 'id, sessionId, enabled',
    });
  }
}

export const db = new SessflowDB();
