/**
 * One-time backfill of the per-session device columns
 * (browser/browserVersion/os/osVersion/device/deviceModel) for sessions
 * ingested before they existed.
 *
 * Why it's needed: those facts used to live ONLY on EndUser, where they're
 * last-write-wins across every device a person uses — so a user on web + mobile
 * had their whole history stamped with whichever app posted last. The ingest
 * path now writes each session's own device, but historical rows are NULL, and
 * a NULL never matches the Recordings device/browser filter. This re-derives
 * them from data already on the row:
 *   - web    → the raw `userAgent` we've always stored
 *   - mobile → the `$device` blob the SDK sent at /start (customProps.$device)
 * using the SAME helpers the live ingest path uses (common/device-facts), so
 * backfilled rows can't disagree with new ones.
 *
 * Safe to re-run: only touches rows whose `device` is still NULL, and the
 * derivation is pure. Walks by keyset (id ASC) in bounded pages — never loads
 * the table into memory — and writes each page as one batched transaction.
 *
 *   npm run build && npm run backfill:session-devices
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { getPostgresClient, disconnectPostgres } from "@replay/db-postgres";
import { webDeviceFacts, mobileDeviceFacts } from "./common/device-facts";

loadEnv();
loadEnv({ path: ".env.local", override: true });

const PAGE = 1000;

/** The mobile SDK's /start payload, stashed under a reserved `$device` key. */
type DeviceBlob = {
  model?: string | null;
  type?: string | null;
  osVersion?: string | null;
  timezone?: string | null;
  city?: string | null;
  country?: string | null;
  flag?: string | null;
};

function blobOf(customProps: unknown): DeviceBlob | null {
  if (!customProps || typeof customProps !== "object") return null;
  const d = (customProps as { $device?: unknown }).$device;
  return d && typeof d === "object" ? (d as DeviceBlob) : null;
}

async function main() {
  const db = getPostgresClient();
  let cursor = 0;
  let scanned = 0;
  let filled = 0;

  for (;;) {
    // Keyset page over the PK — bounded memory, scales to any table size.
    // Select only rows still missing something we can actually derive, so
    // re-runs stay cheap and converge: any row without device facts, plus
    // mobile rows without geo (recoverable from $device). A WEB row with no geo
    // is deliberately NOT selected — its own IP was never stored, so there is
    // nothing to derive and re-scanning it every run would be pure waste.
    const page = await db.session.findMany({
      where: {
        id: { gt: cursor },
        OR: [
          { device: null },
          { AND: [{ platform: { in: ["ios", "android"] } }, { country: null }] },
        ],
      },
      orderBy: { id: "asc" },
      take: PAGE,
      select: {
        id: true,
        platform: true,
        userAgent: true,
        viewport: true,
        customProps: true,
        device: true,
      },
    });
    if (page.length === 0) break;

    // Web rows get device facts only; mobile rows can also recover their geo.
    type SessionFacts = ReturnType<typeof webDeviceFacts> &
      Partial<{ city: string; country: string; flag: string; timezone: string }>;
    const updates: { id: number; facts: SessionFacts }[] = [];
    for (const s of page) {
      const isMobile =
        (s.platform ?? "").toLowerCase() === "ios" ||
        (s.platform ?? "").toLowerCase() === "android";
      if (isMobile) {
        const d = blobOf(s.customProps);
        // Mobile geo IS recoverable — the SDK sent it at /start and we stashed
        // it in the same blob. (Web's isn't: we never stored the session's own
        // IP, so those rows keep falling back to the user row.)
        const geo = {
          ...(d?.city ? { city: d.city } : {}),
          ...(d?.country ? { country: d.country } : {}),
          ...(d?.flag ? { flag: d.flag } : {}),
          ...(d?.timezone ? { timezone: d.timezone } : {}),
        };
        // Nothing left to derive: device facts are already there and this row
        // carries no geo to recover (it predates the $device stash). The WHERE
        // can't see inside the blob, so it re-selects these every run — skip the
        // write so a re-run costs reads only, never a pointless UPDATE.
        if (s.device && Object.keys(geo).length === 0) continue;
        updates.push({
          id: s.id,
          facts: {
            ...mobileDeviceFacts({
              platform: s.platform,
              deviceType: d?.type,
              deviceModel: d?.model,
              osVersion: d?.osVersion,
            }),
            ...geo,
          },
        });
      } else if (s.userAgent && !s.device) {
        // Viewport is stored as "WxH" — the width is the desktop/mobile hint
        // inferDevice uses when the UA doesn't declare a device type.
        const width = Number((s.viewport ?? "").split("x")[0]) || undefined;
        updates.push({ id: s.id, facts: webDeviceFacts(s.userAgent, width) });
      }
      // else: a web session with no UA — nothing to derive, leave it NULL.
    }

    if (updates.length) {
      // One transaction per page, not one round-trip per row.
      await db.$transaction(
        updates.map((u) =>
          db.session.update({ where: { id: u.id }, data: u.facts }),
        ),
      );
      filled += updates.length;
    }
    scanned += page.length;
    cursor = page[page.length - 1].id;
    process.stdout.write(
      `  scanned ${scanned}, filled ${filled} (cursor ${cursor})\n`,
    );
  }

  process.stdout.write(
    `\nBackfill complete: ${filled} of ${scanned} sessions given per-session device facts\n`,
  );
  await disconnectPostgres();
}

main().catch(async (e) => {
  process.stderr.write(
    `Backfill failed: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  await disconnectPostgres();
  process.exit(1);
});
