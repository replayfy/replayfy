import { Injectable } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";

/**
 * Heatmaps — the standard rage + dead-click style. v1 is rage + dead click only; those are
 * the events the SDK already captures with x/y coordinates, so we get a
 * working overlay without touching the SDK or adding a new ingestion path.
 *
 * Data lives in Mongo: each replay batch holds an array of rrweb-shaped
 * events including custom events with `data.kind === "rage_click" |
 * "dead_click"` and `data.x`, `data.y`, `data.selector`. We scan recent
 * batches whose `page.url` matches the requested URL and aggregate.
 *
 * Coordinates are normalised to 0-1 using the SDK-reported viewport so the
 * dashboard can render against an arbitrary stage size. We bin into a
 * 50×50 grid to keep payloads small and to produce nice clustered blobs
 * instead of noisy dots.
 */

const RANGES: Record<string, number> = {
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

const GRID = 50;
const MAX_BATCHES = 1_500; // hard cap to keep query latency predictable

interface HeatPoint {
  x: number; // 0..1 normalised viewport-relative
  y: number; // 0..1
  weight: number;
  kind: "rage_click" | "dead_click";
  selector: string;
}

export interface HeatResponse {
  url: string;
  range: string;
  sampleCount: number;
  pages: { url: string; count: number }[];
  points: {
    x: number;
    y: number;
    intensity: number;
    kind: "rage_click" | "dead_click";
  }[];
  topSelectors: { selector: string; count: number; kind: string }[];
  // rrweb FullSnapshot + Meta of a session that matches the URL — the
  // dashboard rebuilds this into a static DOM behind the heat blobs. We
  // ship the raw rrweb event payloads; the dashboard imports `rebuild`
  // from rrweb-snapshot to materialise them. Null when nothing matches.
  snapshot: {
    width: number;
    height: number;
    // Serialized rrweb node tree (the value of FullSnapshot's `data.node`).
    node: unknown;
    // Initial scroll offset, if rrweb captured it on the FullSnapshot.
    initialOffset?: { left: number; top: number };
  } | null;
}

@Injectable()
export class HeatmapsService {
  private readonly db = getPostgresClient();
  private readonly mongo = getMongoClient();

  /** Top pages by friction (rage + dead) — drives the URL picker. */
  async topPages(workspaceId: number, range = "7d", limit = 12) {
    const windowMs = RANGES[range] ?? RANGES["7d"];
    const since = new Date(Date.now() - windowMs);
    const rows = await this.db.session.groupBy({
      by: ["startUrl"],
      where: { workspaceId, startedAt: { gte: since } },
      _sum: { rageCount: true, deadCount: true },
      _count: { _all: true },
      orderBy: { _sum: { rageCount: "desc" } },
      take: Math.min(Math.max(limit, 1), 50),
    });
    return rows
      .map((r) => ({
        url: r.startUrl ?? "(unknown)",
        rage: r._sum.rageCount ?? 0,
        dead: r._sum.deadCount ?? 0,
        sessions: r._count._all,
      }))
      .filter((r) => r.url !== "(unknown)");
  }

  async forUrl(
    workspaceId: number,
    url: string,
    range = "7d",
  ): Promise<HeatResponse> {
    const windowMs = RANGES[range] ?? RANGES["7d"];
    const since = new Date(Date.now() - windowMs);

    // 1) Find session public IDs in the window that have a path matching the
    //    URL. Use startUrl OR sessionPath join — paths capture SPA navigations
    //    where startUrl is just the landing page.
    const sessions = await this.db.session.findMany({
      where: {
        workspaceId,
        startedAt: { gte: since },
        OR: [{ startUrl: url }, { paths: { some: { url } } }],
      },
      select: { publicId: true },
      take: 500,
    });
    if (sessions.length === 0) {
      return {
        url,
        range,
        sampleCount: 0,
        pages: [],
        points: [],
        topSelectors: [],
        snapshot: null,
      };
    }

    // 2) Pull recent batches for those sessions. We don't need every batch —
    //    rage/dead events are sparse, so the first MAX_BATCHES samples are
    //    enough to build a representative heatmap.
    const ids = sessions.map((s) => s.publicId);
    const batches = await this.mongo.replayBatch.findMany({
      where: {
        projectId: String(workspaceId),
        sessionId: { in: ids },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_BATCHES,
      select: { events: true, page: true },
    });

    // 3) Scan events. Keep only customs of the right kind on a batch whose
    //    page URL matches (a session can span multiple URLs). At the same
    //    time, hunt for an rrweb FullSnapshot (type 2) + Meta (type 4) on a
    //    matching batch so the dashboard can rebuild the page as the heat
    //    background. We pick the freshest one — rrweb is encoded in our
    //    schema's `rrweb` event payload (type "rrweb", data carries the
    //    underlying event_type + node tree).
    const points: HeatPoint[] = [];
    const selectorCounts = new Map<string, { count: number; kind: string }>();
    let snapshot: HeatResponse["snapshot"] = null;
    for (const b of batches) {
      const page = b.page as {
        url?: string;
        viewport?: { width?: number; height?: number };
      } | null;
      if (!page) continue;
      if (page.url !== url) continue;
      const vw = Math.max(1, page.viewport?.width ?? 1280);
      const vh = Math.max(1, page.viewport?.height ?? 800);
      const events = Array.isArray(b.events) ? (b.events as unknown[]) : [];
      for (const raw of events) {
        const ev = raw as {
          type?: string;
          data?: {
            // Custom (rage/dead click) shape.
            kind?: string;
            x?: number;
            y?: number;
            selector?: string;
            count?: number;
            // SDK wraps rrweb events as `{ recorder, rrwebEvent }` — the
            // type narrows further in the `full_snapshot` branch below.
            recorder?: string;
            rrwebEvent?: unknown;
          };
        } | null;
        if (!ev || !ev.data) continue;
        if (ev.type === "custom") {
          if (ev.data.kind !== "rage_click" && ev.data.kind !== "dead_click")
            continue;
          if (typeof ev.data.x !== "number" || typeof ev.data.y !== "number")
            continue;
          const x = Math.min(1, Math.max(0, ev.data.x / vw));
          const y = Math.min(1, Math.max(0, ev.data.y / vh));
          const weight =
            ev.data.kind === "rage_click" ? (ev.data.count ?? 3) : 1;
          points.push({
            x,
            y,
            weight,
            kind: ev.data.kind,
            selector: ev.data.selector ?? "",
          });
          if (ev.data.selector) {
            const k = `${ev.data.kind}::${ev.data.selector}`;
            const prev = selectorCounts.get(k);
            selectorCounts.set(k, {
              count: (prev?.count ?? 0) + weight,
              kind: ev.data.kind,
            });
          }
        } else if (ev.type === "full_snapshot" && snapshot === null) {
          // SDK wraps each rrweb event under `{recorder, rrwebEvent}`. The
          // inner rrwebEvent.type is 2 for FullSnapshot; data carries the
          // serialised node tree (passed straight into rrweb-snapshot's
          // `rebuild()` on the dashboard).
          const wrapper = ev.data as {
            recorder?: string;
            rrwebEvent?: {
              type?: number;
              data?: {
                node?: unknown;
                initialOffset?: { left: number; top: number };
              };
            };
          };
          const inner = wrapper?.rrwebEvent;
          if (
            wrapper?.recorder === "rrweb" &&
            inner?.type === 2 &&
            inner.data?.node
          ) {
            snapshot = {
              width: vw,
              height: vh,
              node: inner.data.node,
              initialOffset: inner.data.initialOffset,
            };
          }
        }
      }
    }

    // 4) Bin into a GRID×GRID heat grid. We bias the bin by kind: rage events
    //    count for more visual weight than dead clicks (they're the more
    //    actionable signal).
    const grid = new Array(GRID * GRID).fill(0);
    const kindMap = new Array(GRID * GRID).fill("dead_click");
    let maxBin = 0;
    for (const p of points) {
      const gx = Math.min(GRID - 1, Math.floor(p.x * GRID));
      const gy = Math.min(GRID - 1, Math.floor(p.y * GRID));
      const idx = gy * GRID + gx;
      grid[idx] += p.weight;
      if (p.kind === "rage_click") kindMap[idx] = "rage_click";
      if (grid[idx] > maxBin) maxBin = grid[idx];
    }

    const outPoints: HeatResponse["points"] = [];
    if (maxBin > 0) {
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === 0) continue;
        const gx = i % GRID;
        const gy = Math.floor(i / GRID);
        outPoints.push({
          x: (gx + 0.5) / GRID,
          y: (gy + 0.5) / GRID,
          intensity: grid[i] / maxBin,
          kind: kindMap[i] as "rage_click" | "dead_click",
        });
      }
    }

    const topSelectors = Array.from(selectorCounts.entries())
      .map(([k, v]) => ({
        selector: k.split("::")[1],
        count: v.count,
        kind: v.kind,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // 5) Top URLs seen across the scanned batches — gives the dashboard a
    //    hint of other pages worth heatmapping.
    const pageCounts = new Map<string, number>();
    for (const b of batches) {
      const u = (b.page as { url?: string } | null)?.url;
      if (!u) continue;
      pageCounts.set(u, (pageCounts.get(u) ?? 0) + 1);
    }
    const pages = Array.from(pageCounts.entries())
      .map(([u, count]) => ({ url: u, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      url,
      range,
      sampleCount: points.length,
      pages,
      points: outPoints,
      topSelectors,
      snapshot,
    };
  }
}
