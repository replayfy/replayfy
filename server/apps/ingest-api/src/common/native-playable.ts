import type { Prisma } from "@replay/db-postgres";

/**
 * Which sessions a session LIST may show: everything except a native session
 * that is still LIVE. Shared by the Recordings list (SessionsService
 * buildListWhere, and with it the funnel and incident drill-downs), a user's
 * page (EndUsersService: the session list, the activity feed, and the
 * header's count, average duration and last session) and AUTO playlist
 * membership (PlaylistsService.filterToWhere), so they cannot disagree about
 * which sessions exist yet.
 *
 * A native (iOS/Android — incl. Flutter & React Native, which keep the
 * ios/android platform) session can't be replayed until its frames archive is
 * gzip-streamed to R2 at session end. The frames finalizer flips it
 * LIVE→COMPLETED in the same write that records that archive, and the
 * per-minute LIVE sweep leaves a native row LIVE while that finalize is still
 * to come (RetentionService.sweepLiveSessions), so a COMPLETED native session
 * is playable — or has no frames at all (an event-only session, which the
 * sweep completes once nativeSweepGraceMs passes with no frames), or its
 * finalize kept failing past FINALIZE_OVERDUE_MAX_MS. Web sessions replay
 * immediately from the rrweb DOM stream, so any status is fine. The reference
 * tracker's session lists likewise hold ended sessions only.
 *
 * NULL-safe: `platform NOT IN (...)` is NULL for a legacy / unknown-platform
 * row, which is treated as web-like (shown), hence its own arm.
 *
 * Native means ios/android: MobileService writes one of the two for every
 * native session, wrappers included. The LIVE sweep's
 * RetentionService.NATIVE_PLATFORMS also names react_native and flutter,
 * which no row carries; if a wrapper ever reports its own platform, add it
 * here too, or these lists would show its sessions while they are LIVE.
 *
 * Lives in common/ rather than as a private member because it genuinely has
 * callers in three modules. Callers AND it into an otherwise index-bounded
 * query: it is a residual filter that only skips LIVE native rows (a small,
 * transient set: recording now, or ended within the last few minutes and not
 * yet finalized), so it never widens a scan.
 */
export const NATIVE_PLAYABLE_FILTER: Prisma.SessionWhereInput = {
  OR: [
    { platform: { notIn: ["ios", "android"] } },
    { platform: null },
    { status: "COMPLETED" },
  ],
};
