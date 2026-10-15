/* ===========================================================================
   Mobile replay timeline model — pure (no DOM, no React) so it can be unit
   tested in isolation (mobileTimeline.test.ts, `yarn test`).

   Ported from the reference player's mobile playback mechanics:
     • Total length is the SESSION's duration from its metadata, grown to cover
       anything recorded past it — never the last frame's time. Frames only
       exist while the screen was being captured (app in the foreground, not on
       an excluded screen, upload not lost), so a session whose capture stopped
       at 0:21 still runs to its real 6:27 end while its events keep playing.
     • Time → frame is "the last frame at or before t". Past the last frame the
       last frame simply holds.
     • Skip inactivity is the reference ActivityManager: gaps between user
       interactions (taps / swipes / input) of at least 10% of the session,
       measured from 0, plus the trailing tail to the end.
     • "background" performance events (1 = backgrounded, 0 = foreground) tell
       whether the app was in the background at t — the reference shows its
       "In Background" badge from that alone, frames or not.
   On top of that, stretches with no frame at all are first-class: the ones
   long enough to matter are skippable like inactivity (and so painted on the
   scrubber), and the player says "no screen recorded" for any frameless
   stretch instead of passing a stale frame off as the live screen.

   Every time here is an ms offset from the session start — the base the
   timeline's `offsetMs` and the frames archive (`frame ts − device start`,
   where the /frames descriptor already folds in the device clock skew) share.

   The /timeline list can be CUT (see TIMELINE_ROW_CAP): past its last row
   nothing is known — not the next tap, not the app coming back from the
   background — so everything read off it takes a "known until" horizon and
   claims nothing beyond it.
   ========================================================================== */

/** A [start, end] range in ms from the session start. */
export type Interval = { start: number; end: number };

/** The slice of a /timeline event this model reads (structurally a subset of
 *  ApiTimelineEvent, so the API payload is passed straight through). */
export type TimelineMark = {
  kind: string;
  offsetMs: number;
  eventType?: string;
  level?: string;
  metric?: string;
  value?: number;
};

/** One app focus change: `background` true from `time` until the next mark. */
export type BackgroundMark = { time: number; background: boolean };

/** A background stretch. `end` is null when the list was cut before the app
 *  came back, so how long it stayed there is unknown. */
export type BackgroundSpan = { start: number; end: number | null };

/** Reference ActivityManager: a stretch counts as inactive once it is at least
 *  this fraction of the whole session. */
export const SKIP_MIN_FRACTION = 0.1;

/** A stretch with no captured frame for at least this long is "no screen
 *  recorded". The SDK captures 1–30 fps (3 by default), so a healthy recording
 *  never goes more than ~1 s between frames; 5 s leaves room for main-thread
 *  stalls delaying a capture without flagging them as missing screen. */
export const FRAME_GAP_MS = 5000;

/** The most rows /timeline returns. The API reads the session's events
 *  `ORDER BY timestamp ASC LIMIT 2000` (sessions.service timeline()) and does
 *  not say when it cut the list, so a full page has to be read as "maybe cut".
 *  A long session hits it quickly: the SDK's CPU / memory / battery samples
 *  alone are ~20 rows a minute, before any network or console row. */
export const TIMELINE_ROW_CAP = 2000;

/** How far into the session (ms) the /timeline list is complete. A list under
 *  the cap is the whole session (Infinity). A full one may have been cut:
 *  every row up to its last one is there, nothing after it is known. Rows are
 *  cut on their timestamp, and `offsetMs` is that same device time minus the
 *  device start, so the latest offset is where the known part ends. */
export function timelineHorizonMs(
  events: ReadonlyArray<TimelineMark> | undefined,
): number {
  if (!events || events.length < TIMELINE_ROW_CAP) return Infinity;
  let last = 0;
  for (const e of events)
    if (Number.isFinite(e.offsetMs) && e.offsetMs > last) last = e.offsetMs;
  return last;
}

/** Total playable length (ms). The reference sets it to the session's own
 *  duration and only ever grows it to cover later content; here that content
 *  is the last frame and, for legacy sessions, the replay-event span. Missing,
 *  non-finite or negative inputs are ignored rather than trusted. */
export function mobileDurationMs(parts: {
  sessionMs?: number | null;
  lastFrameMs?: number | null;
  eventSpanMs?: number | null;
}): number {
  let total = 0;
  for (const v of [parts.sessionMs, parts.lastFrameMs, parts.eventSpanMs]) {
    if (typeof v === "number" && Number.isFinite(v) && v > total) total = v;
  }
  return total;
}

/** Index of the last frame whose `time` is at or before `t` (-1 before the
 *  first frame). `frames` is time-sorted (parseFrames guarantees it). A binary
 *  search, like the reference's findLast: a long session at a few fps holds
 *  thousands of frames and this runs on every playhead tick. */
export function frameIndexAt(
  frames: ReadonlyArray<{ time: number }>,
  t: number,
): number {
  let lo = 0;
  let hi = frames.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return idx;
}

/** Offsets of the user interactions the reference counts as activity: taps and
 *  swipes (our `tap` rows, which also carry long-press / pinch gestures) and
 *  text input (a `custom` row typed `input`). Sorted ascending. Screens,
 *  network, logs and performance samples are NOT activity — an app polling in
 *  the background would otherwise never look idle. */
export function userActivityOffsets(
  events: ReadonlyArray<TimelineMark> | undefined,
): number[] {
  if (!events) return [];
  const out: number[] = [];
  for (const e of events) {
    const isInput =
      e.kind === "custom" && (e.eventType === "input" || e.level === "input");
    if ((e.kind === "tap" || isInput) && Number.isFinite(e.offsetMs))
      out.push(e.offsetMs);
  }
  return out.sort((a, b) => a - b);
}

/** The app's background / foreground transitions, from the SDK's "background"
 *  performance events (value 1 = went to background, 0 = came back). The
 *  timeline scales perf values down by 1000, so any value above 0 is "1".
 *  Only real changes are kept, starting from the foreground (the reference
 *  performance track drops a repeat of the current state the same way), so
 *  each background mark is followed by the foreground mark that ends it. */
export function backgroundMarks(
  events: ReadonlyArray<TimelineMark> | undefined,
): BackgroundMark[] {
  if (!events) return [];
  const raw: BackgroundMark[] = [];
  for (const e of events) {
    if (e.kind !== "perf" || e.metric !== "background") continue;
    if (!Number.isFinite(e.offsetMs)) continue;
    raw.push({ time: e.offsetMs, background: (e.value ?? 0) > 0 });
  }
  raw.sort((a, b) => a.time - b.time);
  const out: BackgroundMark[] = [];
  let background = false;
  for (const m of raw) {
    if (m.background === background) continue;
    out.push(m);
    background = m.background;
  }
  return out;
}

/** Whether the app was in the background at `t`: the last focus change at or
 *  before t decides (reference appFocusTracker). Foreground before the first.
 *  Past `knownUntilMs` the marks may be cut — a "came back" mark could be the
 *  very row that fell off — so nothing is claimed there. */
export function inBackgroundAt(
  marks: ReadonlyArray<BackgroundMark>,
  t: number,
  knownUntilMs: number = Infinity,
): boolean {
  return backgroundSpanAt(marks, t, Infinity, knownUntilMs) !== null;
}

/** The background stretch the playhead is in, or null in the foreground (and
 *  past `knownUntilMs`, see inBackgroundAt). It runs from the mark that sent
 *  the app to the background to the one that brought it back — never wider:
 *  frames can stop well before the app leaves the foreground, and that loss
 *  must not be blamed on it. With no "came back" mark it lasts to the session
 *  end if the list is complete, else its end is unknown (null). */
export function backgroundSpanAt(
  marks: ReadonlyArray<BackgroundMark>,
  t: number,
  durationMs: number,
  knownUntilMs: number = Infinity,
): BackgroundSpan | null {
  if (t > knownUntilMs) return null;
  const idx = frameIndexAt(marks, t);
  if (idx < 0 || !marks[idx].background) return null;
  const start = marks[idx].time;
  const back = marks[idx + 1];
  if (back) return { start, end: Math.min(back.time, durationMs) };
  return { start, end: knownUntilMs < durationMs ? null : durationMs };
}

/** Reference ActivityManager. Walks the (sorted) activity offsets from 0 and
 *  records every gap of at least 10% of the session, then the tail from the
 *  last activity to the end. A session with NO interaction at all gets no
 *  ranges: the reference would emit one [0, end] range, which with the toggle
 *  on ends playback the instant it starts (the web player guards the same
 *  case for the same reason).
 *
 *  `knownUntilMs`: the activity list is only complete up to there (a cut
 *  /timeline). The tail then stops there instead of running to the end — the
 *  next interaction is simply not in the list, and skipping on to the end
 *  would jump over it. Up to there, a stretch of 10% or more with no
 *  interaction is idle whatever comes after, so that much still skips. */
export function inactivityIntervals(
  activity: ReadonlyArray<number>,
  durationMs: number,
  knownUntilMs: number = Infinity,
): Interval[] {
  if (!(durationMs > 0) || activity.length === 0) return [];
  const minInterval = durationMs * SKIP_MIN_FRACTION;
  const out: Interval[] = [];
  let lastActivity = 0;
  for (const t of activity) {
    if (t - lastActivity >= minInterval)
      out.push({ start: lastActivity, end: t });
    lastActivity = t;
  }
  const tailEnd = Math.min(durationMs, knownUntilMs);
  if (tailEnd - lastActivity >= minInterval)
    out.push({ start: lastActivity, end: tailEnd });
  return out;
}

/** Stretches of at least `minGapMs` with no captured frame: before the first
 *  frame, between two frames, and after the last frame up to the end. Frame
 *  times are clamped into [0, duration] (a frame stamped just before the
 *  session start belongs at 0). */
export function framelessGaps(
  frameTimes: ReadonlyArray<number>,
  durationMs: number,
  minGapMs: number,
): Interval[] {
  if (frameTimes.length === 0 || !(durationMs > 0) || !(minGapMs > 0))
    return [];
  const out: Interval[] = [];
  let prev = 0;
  for (const raw of frameTimes) {
    const t = Math.min(Math.max(raw, 0), durationMs);
    if (t - prev >= minGapMs) out.push({ start: prev, end: t });
    if (t > prev) prev = t;
  }
  if (durationMs - prev >= minGapMs)
    out.push({ start: prev, end: durationMs });
  return out;
}

/** Sort and coalesce overlapping or touching ranges, so a skip lands at the
 *  end of the whole idle stretch in one jump. */
export function mergeIntervals(list: ReadonlyArray<Interval>): Interval[] {
  const sorted = list
    .filter((iv) => iv.end > iv.start)
    .map((iv) => ({ ...iv }))
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push(iv);
  }
  return out;
}

/** `iv` minus every range in `cut` (sorted, non-overlapping), as the pieces
 *  left over in order. */
export function subtractIntervals(
  iv: Interval,
  cut: ReadonlyArray<Interval>,
): Interval[] {
  const out: Interval[] = [];
  let from = iv.start;
  for (const c of cut) {
    if (c.end <= from) continue;
    if (c.start >= iv.end) break;
    if (c.start > from) out.push({ start: from, end: c.start });
    from = Math.max(from, c.end);
    if (from >= iv.end) break;
  }
  if (from < iv.end) out.push({ start: from, end: iv.end });
  return out;
}

/** True when `intervals` (merged) leave nothing of [0, duration] to play. */
function coversAll(intervals: ReadonlyArray<Interval>, durationMs: number) {
  return intervals.some((iv) => iv.start <= 0 && iv.end >= durationMs);
}

/** The ranges "Skip inactivity" fast-forwards over (and the scrubber paints).
 *  Two kinds, merged:
 *   • frameless stretches of at least 10% of the session (never under
 *     FRAME_GAP_MS) — there is no screen to watch;
 *   • the reference user-inactivity ranges — but only the part of each that
 *     has a screen, and only where that part is itself 10% of the session.
 *     A user-idle range must not borrow its length from a frameless stretch
 *     (that stretch is already skipped on its own): capture stopping at 0:21
 *     with the next tap at 1:00 makes 0:01→1:00 "idle", yet the 20 s of it
 *     that WAS recorded are not 10% of a 6:27 session, so they play. Within
 *     the captured footage this is exactly the reference rule, so recorded
 *     screen with no interaction for 10%+ of the session is still skipped.
 *  `activityKnownUntilMs` is the /timeline horizon (timelineHorizonMs): no
 *  user-idle range reaches past it. If the ranges would leave nothing at all
 *  to play (skip on would end playback the instant it starts), only the
 *  frameless ones are kept; if even those cover everything, nothing is. */
export function mobileSkipIntervals(input: {
  activity: ReadonlyArray<number>;
  frameTimes: ReadonlyArray<number>;
  durationMs: number;
  activityKnownUntilMs?: number;
}): Interval[] {
  const { activity, frameTimes, durationMs } = input;
  if (!(durationMs > 0)) return [];
  const minInterval = durationMs * SKIP_MIN_FRACTION;
  const frameless = mergeIntervals(
    framelessGaps(
      frameTimes,
      durationMs,
      Math.max(minInterval, FRAME_GAP_MS),
    ),
  );
  const userIdle = inactivityIntervals(
    activity,
    durationMs,
    input.activityKnownUntilMs ?? Infinity,
  )
    // Clamped to the session: an interaction stamped past the duration must
    // not paint a band off the end of the scrubber.
    .map((iv) => ({
      start: Math.max(0, iv.start),
      end: Math.min(durationMs, iv.end),
    }))
    .flatMap((iv) => subtractIntervals(iv, frameless))
    .filter((iv) => iv.end - iv.start >= minInterval);
  const merged = mergeIntervals([...userIdle, ...frameless]);
  if (!coversAll(merged, durationMs)) return merged;
  return coversAll(frameless, durationMs) ? [] : frameless;
}

/** The skip range the playhead is inside, or null. Open at both ends, like the
 *  reference SkipInterval.contains: landing exactly on a range's end (where a
 *  skip puts you) must not count as inside it again. */
export function skipTargetAt(
  intervals: ReadonlyArray<Interval>,
  t: number,
): Interval | null {
  return intervals.find((iv) => t > iv.start && t < iv.end) ?? null;
}

/** The frameless stretch (at least `minGapMs`) the playhead is in, or null
 *  while a captured frame is still current. Read straight off the frames so
 *  each edge is right: at a frame's own time that frame is real; just after
 *  it, a long silence until the next frame (or the session end) is a gap; and
 *  before the first frame the lead-in is a gap when the first frame is late.
 *  The trailing gap stays reported at and past the end, where playback parks. */
export function screenGapAt(
  frames: ReadonlyArray<{ time: number }>,
  t: number,
  durationMs: number,
  minGapMs: number = FRAME_GAP_MS,
): Interval | null {
  if (frames.length === 0) return null;
  const idx = frameIndexAt(frames, t);
  if (idx < 0) {
    const first = frames[0].time;
    return first >= minGapMs ? { start: 0, end: first } : null;
  }
  const cur = frames[idx].time;
  if (t <= cur) return null;
  const next = idx + 1 < frames.length ? frames[idx + 1].time : null;
  const end = next ?? Math.max(durationMs, cur);
  return end - cur >= minGapMs ? { start: cur, end } : null;
}

/** Whether the timeline has an event the Events panel lists in [start, end].
 *  Performance samples don't count — the panel drops that telemetry — so a
 *  stretch holding only those has nothing to show "still playing". */
export function hasEventsBetween(
  events: ReadonlyArray<TimelineMark> | undefined,
  start: number,
  end: number,
): boolean {
  if (!events) return false;
  return events.some(
    (e) => e.kind !== "perf" && e.offsetMs >= start && e.offsetMs <= end,
  );
}

/** Why a frameless session has no frames, for the empty state: a session
 *  shorter than the SDK's first capture window (~500 ms after foreground,
 *  rounded up) versus one long enough that capture should have produced some. */
export function noFramesReason(durationMs: number): "too-short" | "not-captured" {
  return durationMs < 2000 ? "too-short" : "not-captured";
}
