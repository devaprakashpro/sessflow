import { nanoid } from 'nanoid';
import { db } from './db';
import { updateSession } from './sessions';
import type { Workspace } from './types';

const COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#ef4444', '#10b981', '#a855f7', '#ec4899', '#84cc16'];

export async function createWorkspace(name: string): Promise<Workspace> {
  const count = await db.workspaces.count();
  const ws: Workspace = {
    id: nanoid(8),
    name: name.trim() || 'New workspace',
    color: COLORS[count % COLORS.length],
    createdAt: Date.now(),
  };
  await db.workspaces.put(ws);
  return ws;
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  await db.workspaces.update(id, { name: name.trim() });
}

export async function deleteWorkspace(id: string): Promise<void> {
  // unfile its sessions, then drop the workspace
  const owned = await db.sessions.where('workspaceId').equals(id).toArray();
  for (const s of owned) await updateSession(s.id, { workspaceId: undefined });
  await db.workspaces.delete(id);
}

export async function assignToWorkspace(sessionId: string, workspaceId: string | undefined): Promise<void> {
  await updateSession(sessionId, { workspaceId });
}
