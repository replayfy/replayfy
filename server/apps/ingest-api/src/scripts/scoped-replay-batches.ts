import type { PrismaClient as MongoClient } from "@replay/db-mongo";

/** A Session row of the page being processed. */
export interface PageSession {
  id: number;
  publicId: string;
  workspaceId: number;
}

/** One Mongo replay batch of a page session. */
export interface ScopedBatch {
  sequence: number;
  events: unknown;
}

/**
 * The Mongo replay batches of one page of Session rows, by Session id, sorted
 * by sequence. Tenant-scoped: a batch belongs to a session only under that
 * session's own workspace (projectId) — session ids are client-chosen, so
 * another workspace can hold batches under the same id.
 *
 * Access pattern: ONE query per page — an $or with one branch per workspace in
 * the page, each projectId equality + sessionId $in, so each is an index range
 * on [projectId, sessionId]. Replaces one unscoped query per session (an N+1,
 * and a collection scan each, since no index starts with sessionId). Memory is
 * bounded by the caller's page size: every batch's events are loaded.
 */
export async function loadScopedBatches(
  mongo: MongoClient,
  sessions: PageSession[],
): Promise<Map<number, ScopedBatch[]>> {
  const out = new Map<number, ScopedBatch[]>();
  if (sessions.length === 0) return out;
  const idsByWorkspace = new Map<number, string[]>();
  const rowIdByKey = new Map<string, number>();
  for (const s of sessions) {
    const ids = idsByWorkspace.get(s.workspaceId) ?? [];
    ids.push(s.publicId);
    idsByWorkspace.set(s.workspaceId, ids);
    rowIdByKey.set(`${s.workspaceId}\0${s.publicId}`, s.id);
  }
  const batches = await mongo.replayBatch.findMany({
    where: {
      OR: [...idsByWorkspace].map(([workspaceId, ids]) => ({
        projectId: String(workspaceId),
        sessionId: { in: ids },
      })),
    },
    select: { projectId: true, sessionId: true, sequence: true, events: true },
  });
  for (const b of batches) {
    const rowId = rowIdByKey.get(`${b.projectId}\0${b.sessionId}`);
    if (rowId === undefined) continue;
    const list = out.get(rowId) ?? [];
    list.push({ sequence: b.sequence, events: b.events });
    out.set(rowId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.sequence - b.sequence);
  return out;
}
