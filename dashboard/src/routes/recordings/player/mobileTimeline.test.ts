/* Unit tests for the mobile replay timeline model (`yarn test`). Times are ms
   offsets from the session start, as in the player. The recurring fixture is
   the session that exposed the bug: 6:27 long, frames only in its first 21 s,
   events running to the end. */
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  FRAME_GAP_MS,
  TIMELINE_ROW_CAP,
  backgroundMarks,
  backgroundSpanAt,
  frameIndexAt,
  framelessGaps,
  hasEventsBetween,
  inBackgroundAt,
  inactivityIntervals,
  mergeIntervals,
  mobileDurationMs,
  mobileSkipIntervals,
  noFramesReason,
  screenGapAt,
  skipTargetAt,
  subtractIntervals,
  timelineHorizonMs,
  userActivityOffsets,
  type TimelineMark,
} from "./mobileTimeline";

const SESSION_MS = 387_000; // 6:27
/** Frames every 250 ms from 0.5 s to 21 s — capture stopped at 0:21. */
const EARLY_FRAMES = Array.from({ length: 83 }, (_, i) => ({
  time: 500 + i * 250,
}));
const EARLY_TIMES = EARLY_FRAMES.map((f) => f.time);
const LAST_FRAME = EARLY_TIMES[EARLY_TIMES.length - 1];

test("fixture: the last frame is at 0:21", () => {
  assert.equal(LAST_FRAME, 21_000);
});

test("duration is the session's length, not the last frame's time", () => {
  assert.equal(
    mobileDurationMs({ sessionMs: SESSION_MS, lastFrameMs: LAST_FRAME }),
    SESSION_MS,
  );
});

test("duration grows to cover content recorded past the session length", () => {
  assert.equal(mobileDurationMs({ sessionMs: 10_000, lastFrameMs: 12_500 }), 12_500);
  // Legacy sessions (no archive): the replay-event span can extend it too.
  assert.equal(mobileDurationMs({ sessionMs: 4_000, eventSpanMs: 9_000 }), 9_000);
});

test("duration ignores missing, non-finite and negative inputs", () => {
  assert.equal(mobileDurationMs({}), 0);
  assert.equal(
    mobileDurationMs({ sessionMs: null, lastFrameMs: NaN, eventSpanMs: -5 }),
    0,
  );
  assert.equal(mobileDurationMs({ sessionMs: Infinity, lastFrameMs: 3 }), 3);
});

test("frameIndexAt: the last frame at or before t", () => {
  const frames = [{ time: 100 }, { time: 200 }, { time: 300 }];
  assert.equal(frameIndexAt(frames, 0), -1);
  assert.equal(frameIndexAt(frames, 99), -1);
  assert.equal(frameIndexAt(frames, 100), 0);
  assert.equal(frameIndexAt(frames, 250), 1);
  assert.equal(frameIndexAt(frames, 300), 2);
  // Past the last frame the last frame holds.
  assert.equal(frameIndexAt(frames, 1e9), 2);
  assert.equal(frameIndexAt([], 50), -1);
  // Equal timestamps: the later one wins, as a forward walk would.
  assert.equal(frameIndexAt([{ time: 5 }, { time: 5 }, { time: 9 }], 5), 1);
});

test("frameIndexAt agrees with a forward walk on every probe", () => {
  const times = [-40, 0, 0, 3, 17, 17, 18, 250, 251, 900];
  const frames = times.map((time) => ({ time }));
  for (let t = -60; t <= 1000; t += 1) {
    let walk = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].time <= t) walk = i;
      else break;
    }
    assert.equal(frameIndexAt(frames, t), walk, `t=${t}`);
  }
});

test("scrubbing past the last frame reports the no-screen stretch to the end", () => {
  const at = (t: number) => screenGapAt(EARLY_FRAMES, t, SESSION_MS);
  assert.equal(at(10_000), null);
  // The last frame itself is a real frame.
  assert.equal(at(LAST_FRAME), null);
  assert.deepEqual(at(LAST_FRAME + 1), { start: LAST_FRAME, end: SESSION_MS });
  assert.deepEqual(at(200_000), { start: LAST_FRAME, end: SESSION_MS });
  // Parked at (or past) the end, where playback stops.
  assert.deepEqual(at(SESSION_MS), { start: LAST_FRAME, end: SESSION_MS });
  assert.deepEqual(at(SESSION_MS + 50), { start: LAST_FRAME, end: SESSION_MS });
});

test("screenGapAt: interior gaps, short gaps and the lead-in", () => {
  const frames = [{ time: 1_000 }, { time: 10_000 }, { time: 40_000 }, { time: 42_000 }];
  assert.deepEqual(screenGapAt(frames, 20_000, 60_000), { start: 10_000, end: 40_000 });
  assert.equal(screenGapAt(frames, 40_000, 60_000), null);
  // 2 s between frames is ordinary capture cadence, not missing screen.
  assert.equal(screenGapAt(frames, 41_000, 60_000), null);
  // Lead-in: a frame 1 s in is the normal first-capture delay...
  assert.equal(screenGapAt(frames, 0, 60_000), null);
  // ...one 8 s in means nothing was recorded until then.
  const late = [{ time: 8_000 }, { time: 8_500 }];
  assert.deepEqual(screenGapAt(late, 0, 9_000), { start: 0, end: 8_000 });
  assert.deepEqual(screenGapAt(late, 7_999, 9_000), { start: 0, end: 8_000 });
  // A short tail (the session ended 0.5 s after the last frame) holds the frame.
  assert.equal(screenGapAt(late, 9_000, 9_000), null);
  assert.equal(screenGapAt([], 100, 1_000), null);
});

test("screenGapAt agrees with framelessGaps inside every gap", () => {
  const frames = [{ time: 2_000 }, { time: 9_000 }, { time: 9_400 }, { time: 30_000 }];
  const gaps = framelessGaps(frames.map((f) => f.time), 50_000, FRAME_GAP_MS);
  assert.deepEqual(gaps, [
    { start: 2_000, end: 9_000 },
    { start: 9_400, end: 30_000 },
    { start: 30_000, end: 50_000 },
  ]);
  for (const g of gaps) {
    const mid = (g.start + g.end) / 2;
    assert.deepEqual(screenGapAt(frames, mid, 50_000), g);
  }
});

const TIMELINE: TimelineMark[] = [
  { kind: "screen", offsetMs: 400 },
  { kind: "tap", eventType: "click", offsetMs: 2_000 },
  { kind: "network", offsetMs: 2_100 },
  { kind: "tap", eventType: "swipe", offsetMs: 9_000 },
  { kind: "custom", eventType: "input", level: "input", offsetMs: 15_000 },
  { kind: "perf", metric: "memoryUsage", value: 512, offsetMs: 16_000 },
  { kind: "perf", metric: "background", value: 0.001, offsetMs: 21_200 },
  { kind: "console", offsetMs: 120_000 },
  { kind: "perf", metric: "background", value: 0, offsetMs: 380_000 },
  { kind: "tap", eventType: "gesture", offsetMs: 381_000 },
];

test("user activity = taps, swipes, gestures and input only", () => {
  assert.deepEqual(userActivityOffsets(TIMELINE), [2_000, 9_000, 15_000, 381_000]);
  assert.deepEqual(userActivityOffsets(undefined), []);
  // Unsorted input comes back sorted; input is recognised by level alone too.
  assert.deepEqual(
    userActivityOffsets([
      { kind: "tap", offsetMs: 50 },
      { kind: "custom", level: "input", offsetMs: 10 },
      { kind: "custom", level: "rage", offsetMs: 30 },
    ]),
    [10, 50],
  );
});

test("background marks: value above 0 is backgrounded, 0 is foreground", () => {
  const marks = backgroundMarks(TIMELINE);
  assert.deepEqual(marks, [
    { time: 21_200, background: true },
    { time: 380_000, background: false },
  ]);
  assert.equal(inBackgroundAt(marks, 0), false);
  assert.equal(inBackgroundAt(marks, 21_199), false);
  assert.equal(inBackgroundAt(marks, 21_200), true);
  assert.equal(inBackgroundAt(marks, 200_000), true);
  assert.equal(inBackgroundAt(marks, 380_000), false);
  assert.equal(inBackgroundAt([], 5), false);
});

test("inactivity: gaps of 10%+ between interactions, measured from 0, plus the tail", () => {
  // 100 s session → 10 s threshold.
  assert.deepEqual(inactivityIntervals([5_000, 50_000, 55_000], 100_000), [
    { start: 5_000, end: 50_000 },
    { start: 55_000, end: 100_000 },
  ]);
  // The lead-in counts from 0, as in the reference.
  assert.deepEqual(inactivityIntervals([30_000, 35_000], 100_000), [
    { start: 0, end: 30_000 },
    { start: 35_000, end: 100_000 },
  ]);
  // Exactly 10% is inactive (>=).
  assert.deepEqual(inactivityIntervals([10_000, 90_000], 100_000), [
    { start: 0, end: 10_000 },
    { start: 10_000, end: 90_000 },
    { start: 90_000, end: 100_000 },
  ]);
  assert.deepEqual(inactivityIntervals([], 100_000), []);
  assert.deepEqual(inactivityIntervals([1_000], 0), []);
});

test("framelessGaps: lead-in, interior and tail; negative frame times clamp to 0", () => {
  assert.deepEqual(framelessGaps(EARLY_TIMES, SESSION_MS, 38_700), [
    { start: LAST_FRAME, end: SESSION_MS },
  ]);
  assert.deepEqual(framelessGaps([-200, 20_000], 30_000, 5_000), [
    { start: 0, end: 20_000 },
    { start: 20_000, end: 30_000 },
  ]);
  assert.deepEqual(framelessGaps([], 30_000, 5_000), []);
  assert.deepEqual(framelessGaps([1_000], 30_000, 0), []);
});

test("mergeIntervals coalesces overlapping and touching ranges", () => {
  const input = [
    { start: 50, end: 60 },
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 15, end: 30 },
    { start: 40, end: 40 },
  ];
  assert.deepEqual(mergeIntervals(input), [
    { start: 0, end: 30 },
    { start: 50, end: 60 },
  ]);
  // Input is left untouched.
  assert.deepEqual(input[1], { start: 0, end: 10 });
});

test("skip: the frameless tail after 0:21 is skippable even with no taps", () => {
  assert.deepEqual(
    mobileSkipIntervals({ activity: [], frameTimes: EARLY_TIMES, durationMs: SESSION_MS }),
    [{ start: LAST_FRAME, end: SESSION_MS }],
  );
});

/** Frames every second from 0.5 s up to (not including) `until`. */
function framesUntil(until: number): number[] {
  const out: number[] = [];
  for (let t = 500; t < until; t += 1_000) out.push(t);
  return out;
}

test("skip: user inactivity and frameless stretches are merged", () => {
  // 100 s session (10 s threshold), screen captured until 49.5 s, a tap every
  // few seconds until 20 s: the 29.5 s of recorded screen after the last tap
  // are idle on their own, and run straight into the frameless tail — one
  // jump to the end.
  assert.deepEqual(
    mobileSkipIntervals({
      activity: [1_000, 8_000, 15_000, 20_000],
      frameTimes: framesUntil(50_000),
      durationMs: 100_000,
    }),
    [{ start: 20_000, end: 100_000 }],
  );
});

test("skip: a user-idle range never borrows its length from a frameless stretch", () => {
  // Taps at 2 s, 9 s, 15 s: the reference tail [15 s, end] is 6:12 long, but
  // all of it past 0:21 is the frameless tail (skipped on its own). The 6 s of
  // recorded screen left are nowhere near 10% of 6:27, so they play.
  assert.deepEqual(
    mobileSkipIntervals({
      activity: [2_000, 9_000, 15_000],
      frameTimes: EARLY_TIMES,
      durationMs: SESSION_MS,
    }),
    [{ start: LAST_FRAME, end: SESSION_MS }],
  );
  // No tap until 100 s, after capture stopped: user idle [0, 100 s] is 21 s
  // of recorded screen plus 79 s of no screen — the recorded part plays.
  assert.deepEqual(
    mobileSkipIntervals({
      activity: [100_000, 101_000, 102_000],
      frameTimes: EARLY_TIMES,
      durationMs: SESSION_MS,
    }),
    [{ start: LAST_FRAME, end: SESSION_MS }],
  );
});

test("skip: one early tap does not flip the recorded 0:21 from playing to skipped", () => {
  // Review case: taps at 1 s, 60 s and 61 s. The reference range [1 s, 60 s]
  // got its 59 s from the no-screen time after 0:21; merged with the
  // frameless tail it swallowed 0:01→6:27 and only 1 s of the session played.
  const withTap = mobileSkipIntervals({
    activity: [1_000, 60_000, 61_000],
    frameTimes: EARLY_TIMES,
    durationMs: SESSION_MS,
  });
  assert.deepEqual(withTap, [{ start: LAST_FRAME, end: SESSION_MS }]);
  // ...the same as without that first tap.
  assert.deepEqual(
    mobileSkipIntervals({
      activity: [60_000, 61_000],
      frameTimes: EARLY_TIMES,
      durationMs: SESSION_MS,
    }),
    withTap,
  );
});

test("skip: recorded screen with no interaction for 10%+ is still skipped", () => {
  // The reference rule holds inside the footage: 60 s recorded, 100 s session,
  // taps at 5 s and 50 s → 45 s of recorded screen with no interaction.
  assert.deepEqual(
    mobileSkipIntervals({
      activity: [5_000, 50_000],
      frameTimes: framesUntil(60_000),
      durationMs: 100_000,
    }),
    [
      { start: 5_000, end: 50_000 },
      { start: 59_500, end: 100_000 },
    ],
  );
});

test("skip: never leaves nothing to play", () => {
  // One tap in the middle of the recorded minute: both halves are 10%+ idle
  // and the rest has no screen, so together they cover the session. Skip on
  // would end playback at once — only the frameless tail is kept.
  assert.deepEqual(
    mobileSkipIntervals({
      activity: [30_000],
      frameTimes: framesUntil(60_000),
      durationMs: 100_000,
    }),
    [{ start: 59_500, end: 100_000 }],
  );
  // One frame at 0 and nothing else: the frameless stretch IS the session, so
  // there is nothing to skip to.
  assert.deepEqual(
    mobileSkipIntervals({ activity: [], frameTimes: [0], durationMs: 100_000 }),
    [],
  );
  // One frame mid-session: the two frameless halves touch — still everything.
  assert.deepEqual(
    mobileSkipIntervals({ activity: [], frameTimes: [50_000], durationMs: 100_000 }),
    [],
  );
});

/** Frames every second from 0.5 s to 29.5 s, minus the [from, to) hole. */
function framesWithHole(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = 500; t < 30_000; t += 1_000) if (t < from || t >= to) out.push(t);
  return out;
}
/** A tap every 2 s: never 10% idle in a 30 s session. */
const BUSY_TAPS = Array.from({ length: 15 }, (_, i) => 1_000 + i * 2_000);

test("skip: frameless stretches under max(10%, 5 s) are not skippable", () => {
  // 30 s session: 10% is 3 s, but the floor is FRAME_GAP_MS (5 s).
  assert.deepEqual(
    mobileSkipIntervals({ activity: BUSY_TAPS, frameTimes: framesWithHole(3_000, 6_000), durationMs: 30_000 }),
    [], // 2.5 s → 6.5 s: a 4 s hole
  );
  assert.deepEqual(
    mobileSkipIntervals({ activity: BUSY_TAPS, frameTimes: framesWithHole(3_000, 8_000), durationMs: 30_000 }),
    [{ start: 2_500, end: 8_500 }], // a 6 s hole
  );
  // 100 s session: a 7 s hole is "no screen" on the stage but under 10%, so
  // it is not inactivity to skip.
  const frames = [500, 1_500, 2_500, 9_500, 10_500, 99_500];
  assert.deepEqual(screenGapAt(frames.map((time) => ({ time })), 5_000, 100_000), {
    start: 2_500,
    end: 9_500,
  });
  const skips = mobileSkipIntervals({ activity: [], frameTimes: frames, durationMs: 100_000 });
  assert.deepEqual(skips, [{ start: 10_500, end: 99_500 }]);
  assert.equal(skipTargetAt(skips, 5_000), null);
  assert.deepEqual(
    mobileSkipIntervals({ activity: [1], frameTimes: [1], durationMs: 0 }),
    [],
  );
});

test("skip: ranges are clamped to the session", () => {
  // An interaction stamped past the duration (100 s) still closes the idle
  // stretch, but the range stops at the end of the scrubber.
  assert.deepEqual(
    mobileSkipIntervals({ activity: [5_000, 130_000], frameTimes: [], durationMs: 100_000 }),
    [{ start: 5_000, end: 100_000 }],
  );
});

test("skipTargetAt is open at both ends, like the reference contains()", () => {
  const ivs = [{ start: 10, end: 20 }];
  assert.equal(skipTargetAt(ivs, 10), null);
  assert.deepEqual(skipTargetAt(ivs, 10.5), { start: 10, end: 20 });
  assert.equal(skipTargetAt(ivs, 20), null);
  assert.equal(skipTargetAt([], 5), null);
});

test("no-frames empty state is judged on the session's duration", () => {
  // The /events stream of a native session is empty, so its span is 0; the
  // session's own 6:27 must decide, not that 0.
  const duration = mobileDurationMs({ sessionMs: SESSION_MS, eventSpanMs: 0 });
  assert.equal(noFramesReason(duration), "not-captured");
  assert.equal(noFramesReason(1_200), "too-short");
});

test("subtractIntervals leaves the pieces outside the cut ranges", () => {
  const cut = [
    { start: 10, end: 20 },
    { start: 30, end: 40 },
  ];
  assert.deepEqual(subtractIntervals({ start: 0, end: 50 }, cut), [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
    { start: 40, end: 50 },
  ]);
  assert.deepEqual(subtractIntervals({ start: 12, end: 35 }, cut), [
    { start: 20, end: 30 },
  ]);
  assert.deepEqual(subtractIntervals({ start: 12, end: 18 }, cut), []);
  assert.deepEqual(subtractIntervals({ start: 0, end: 5 }, []), [
    { start: 0, end: 5 },
  ]);
});

/* ── A capped /timeline ──────────────────────────────────────────────────── */

const HOUR_MS = 3_600_000;
/** What /timeline returns for a busy, fully recorded hour: perf samples plus
 *  network / console rows (~100 a minute) and a tap every 5 s. The API keeps
 *  the first 2000 rows by time (`ORDER BY timestamp LIMIT 2000`), which run
 *  out at ~18 minutes — every row after that, taps included, is cut. */
function cappedHourTimeline(): TimelineMark[] {
  const rows: TimelineMark[] = [];
  for (let t = 0; t < HOUR_MS; t += 600) rows.push({ kind: "network", offsetMs: t });
  for (let t = 2_000; t < HOUR_MS; t += 5_000)
    rows.push({ kind: "tap", eventType: "click", offsetMs: t });
  rows.sort((a, b) => a.offsetMs - b.offsetMs);
  return rows.slice(0, TIMELINE_ROW_CAP);
}

test("timelineHorizonMs: complete under the cap, cut at its last row when full", () => {
  assert.equal(timelineHorizonMs(undefined), Infinity);
  assert.equal(timelineHorizonMs([{ kind: "tap", offsetMs: 5 }]), Infinity);
  const rows = cappedHourTimeline();
  assert.equal(rows.length, TIMELINE_ROW_CAP);
  const horizon = timelineHorizonMs(rows);
  assert.equal(horizon, Math.max(...rows.map((r) => r.offsetMs)));
  assert.ok(horizon > 1_000_000 && horizon < 1_800_000, `horizon=${horizon}`);
});

test("skip: a capped timeline never makes the rest of the session idle", () => {
  const rows = cappedHourTimeline();
  const activity = userActivityOffsets(rows);
  const frameTimes = Array.from({ length: 3_600 }, (_, i) => i * 1_000 + 500);
  // Read as complete, the last tap that survived the cap starts a "tail" to
  // the end — 40 minutes of real taps and screen skipped in one jump.
  assert.notDeepEqual(
    mobileSkipIntervals({ activity, frameTimes, durationMs: HOUR_MS }),
    [],
  );
  assert.deepEqual(
    mobileSkipIntervals({
      activity,
      frameTimes,
      durationMs: HOUR_MS,
      activityKnownUntilMs: timelineHorizonMs(rows),
    }),
    [],
  );
});

test("inactivity: the tail stops where a capped list stops", () => {
  // Known until 50 s: [1 s, 50 s] has no tap and is 10%+ — idle whatever
  // comes next — but nothing past 50 s is known, so the tail ends there.
  assert.deepEqual(inactivityIntervals([1_000], 100_000, 50_000), [
    { start: 1_000, end: 50_000 },
  ]);
  // Under 10% between the last tap and the cut: not known to be idle, so not
  // skipped (the lead-in before that tap still is).
  assert.deepEqual(inactivityIntervals([45_000], 100_000, 50_000), [
    { start: 0, end: 45_000 },
  ]);
});

test("background: nothing is claimed past where a capped list stops", () => {
  // Backgrounded at 10 min; the list is cut at 20 min, so the row that brought
  // the app back may be among the ones cut off.
  const marks = backgroundMarks([
    { kind: "perf", metric: "background", value: 0.001, offsetMs: 600_000 },
  ]);
  const cut = 1_200_000;
  assert.equal(inBackgroundAt(marks, 900_000, cut), true);
  assert.deepEqual(backgroundSpanAt(marks, 900_000, HOUR_MS, cut), {
    start: 600_000,
    end: null,
  });
  assert.equal(inBackgroundAt(marks, 1_800_000, cut), false);
  assert.equal(backgroundSpanAt(marks, 1_800_000, HOUR_MS, cut), null);
  // A complete list with no "came back" mark: background to the end.
  assert.deepEqual(backgroundSpanAt(marks, 1_800_000, HOUR_MS), {
    start: 600_000,
    end: HOUR_MS,
  });
});

test("background span is the background stretch, not the wider frameless one", () => {
  // Review case: frames stop at 0:21 (capture / upload loss), the app goes to
  // the background at 3:00 and comes back at 5:00, frames never resume.
  const marks = backgroundMarks([
    { kind: "perf", metric: "background", value: 0.001, offsetMs: 180_000 },
    { kind: "perf", metric: "background", value: 0, offsetMs: 300_000 },
  ]);
  assert.deepEqual(screenGapAt(EARLY_FRAMES, 240_000, SESSION_MS), {
    start: LAST_FRAME,
    end: SESSION_MS,
  });
  assert.deepEqual(backgroundSpanAt(marks, 240_000, SESSION_MS), {
    start: 180_000,
    end: 300_000,
  });
  assert.equal(backgroundSpanAt(marks, 120_000, SESSION_MS), null);
  assert.equal(backgroundSpanAt(marks, 330_000, SESSION_MS), null);
});

test("background marks keep only real changes, starting from the foreground", () => {
  const marks = backgroundMarks([
    { kind: "perf", metric: "background", value: 0, offsetMs: 100 },
    { kind: "perf", metric: "background", value: 0.001, offsetMs: 200 },
    { kind: "perf", metric: "background", value: 0.001, offsetMs: 300 },
    { kind: "perf", metric: "background", value: 0, offsetMs: 400 },
    { kind: "perf", metric: "background", value: 0, offsetMs: 500 },
  ]);
  assert.deepEqual(marks, [
    { time: 200, background: true },
    { time: 400, background: false },
  ]);
  // A repeated "background" must not restart the stretch.
  assert.deepEqual(backgroundSpanAt(marks, 350, 1_000), { start: 200, end: 400 });
});

test("hasEventsBetween: listed events only, inside the range", () => {
  const events: TimelineMark[] = [
    { kind: "perf", metric: "memoryUsage", offsetMs: 50 },
    { kind: "network", offsetMs: 120 },
  ];
  assert.equal(hasEventsBetween(events, 100, 200), true);
  assert.equal(hasEventsBetween(events, 0, 100), false); // perf sample only
  assert.equal(hasEventsBetween(events, 130, 200), false);
  assert.equal(hasEventsBetween(undefined, 0, 1e9), false);
});
