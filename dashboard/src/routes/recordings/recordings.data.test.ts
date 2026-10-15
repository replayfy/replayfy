/* Unit test for the API → row mapping the players read (`yarn test`). The
   mobile player dates its load-error copy ("still being processed" vs
   "Session not found.") by the session's own server-side start, and both the
   Recordings page and the share page hand it `adaptSession(...).startedAtMs`:
   without it the copy falls back to the archive descriptor's device-clock
   start, and a device whose clock ran days behind reads "Session not found."
   for a session that started minutes ago. */
import { describe, expect, test } from "vitest";
import { adaptSession, type ApiSession } from "./recordings.data";

const API: ApiSession = {
  id: 1,
  publicId: "ses_mobile_627",
  status: "COMPLETED",
  startedAt: "2026-10-01T10:00:00.000Z",
  endedAt: "2026-10-01T10:06:27.000Z",
  durationMs: 387_000,
  pageCount: 0,
  clickCount: 0,
  rageCount: 0,
  deadCount: 0,
  errorCount: 0,
  startUrl: null,
  platform: "ios",
  endUser: null,
};

describe("adaptSession startedAtMs", () => {
  test("is the session's start as epoch ms", () => {
    expect(adaptSession(API).startedAtMs).toBe(
      Date.UTC(2026, 9, 1, 10, 0, 0),
    );
  });

  test("is the same on the public share surface", () => {
    expect(adaptSession(API, true).startedAtMs).toBe(
      Date.UTC(2026, 9, 1, 10, 0, 0),
    );
  });

  test("is absent, not 0 or NaN, when the start does not parse", () => {
    // 0 would date the copy to 1970 ("Session not found."); absent lets the
    // player fall back to the descriptor's start.
    expect(adaptSession({ ...API, startedAt: "" }).startedAtMs).toBeUndefined();
    expect(
      adaptSession({ ...API, startedAt: "not a date" }).startedAtMs,
    ).toBeUndefined();
  });
});
