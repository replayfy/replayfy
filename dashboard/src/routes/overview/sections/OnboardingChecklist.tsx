import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { useApi } from "@/api/useApi";
import { useAuth } from "@/lib/auth";
import {
  Cohorts,
  Dashboard,
  Integrations,
  Workspaces,
  type WorkspaceSummary,
} from "@/api/endpoints";
import { OnboardingHero } from "./OnboardingHero";
import { onbStore, ONB_STEP_KEYS, type OnbStepKey } from "../onboarding.store";

type Props = {
  /** Counts already fetched by Overview (Dashboard.counts) — passed in so the
   *  checklist doesn't refetch them. */
  recordings: number;
  funnels: number;
  /** Compact = a dismissible banner shown above a populated dashboard; full =
   *  the first-run surface shown when the workspace has no data yet. */
  compact?: boolean;
  onDismiss?: () => void;
  /** Full mode only: the user chose to leave setup (after the SDK step). */
  onSkip?: () => void;
};

type RawCohort = { id: number };
type RawIntegration = { provider: string; connected?: boolean };

type ChecklistItem = {
  key: OnbStepKey;
  label: string;
  desc: string;
  done: boolean;
  cta: string;
  to: string;
};

/* First-run onboarding checklist. Every step reflects REAL completion state
   derived from existing endpoints — recordings/funnels come from the counts
   Overview already loaded; cohorts/team/integration are read here (only when a
   new workspace renders this, so no cost on populated dashboards). The SDK step
   detects the first event LIVE: while it isn't done it polls the workspace event
   counter (GET /v1/dashboard/counts — one indexed aggregate) every 5s and flips
   the moment a genuine recording lands, exactly like the Settings → Install
   banner and the Recordings empty state — no simulation. Styled with inline
   design tokens + the frozen .btn classes; sharp corners per the app's own
   chrome rule (buttons keep their radius). */
export function OnboardingChecklist({
  recordings,
  funnels,
  compact,
  onDismiss,
  onSkip,
}: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const { workspaceId } = useAuth();
  const { data: cohorts } = useApi<RawCohort[]>(
    () => Cohorts.list<RawCohort[]>(),
    [],
  );
  const { data: workspaces } = useApi<WorkspaceSummary[]>(
    () => Workspaces.list(),
    [],
  );
  const { data: integrations } = useApi<RawIntegration[]>(
    () => Integrations.list<RawIntegration[]>(),
    [],
  );

  // Team size = the CURRENT workspace's member count (owner = 1). memberships
  // from useAuth is the user's OWN workspace list, so it must NOT be used here.
  const memberCount =
    workspaces?.find((w) => w.id === workspaceId)?.memberCount ?? 1;

  // ── Real first-event detection. `recordings` is the count Overview already
  //    loaded; while the SDK step isn't done we ALSO poll GET /v1/dashboard/counts
  //    every 5s (a fresh workspace only — a cheap indexed aggregate) so the step
  //    flips the instant a genuine recording lands, whether or not the user opened
  //    the install page. Reacts to an actual live recording — no simulation, no
  //    timer. `install-opened` (set by the Install CTA) only decides whether the
  //    row reads "Listening for the first event…".
  const installOpened = onbStore.get(workspaceId, "install-opened") === "1";
  const [liveRecordings, setLiveRecordings] = useState(0);
  const sdkDone = recordings > 0 || liveRecordings > 0;
  const listening = installOpened && !sdkDone;
  const announcedRef = useRef(false);
  useEffect(() => {
    if (sdkDone) return; // already have real data — nothing left to watch
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await Dashboard.counts<{ recordings: number }>();
        if (cancelled) return;
        if ((r.data.recordings ?? 0) > 0) {
          setLiveRecordings(r.data.recordings);
          if (!announcedRef.current) {
            announcedRef.current = true;
            toast &&
              toast("First event received — sessions are landing", {
                kind: "ok",
              });
          }
        }
      } catch {
        /* transient network/backend blip — keep polling */
      }
    };
    poll(); // check immediately, then every 5s until the first event lands
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sdkDone, toast]);

  const items: ChecklistItem[] = [
    {
      key: "sdk",
      label: "Install the SDK",
      desc: "Drop the snippet into your app — sessions start landing in ~30 seconds.",
      done: sdkDone,
      cta: "Install",
      to: "/settings/install",
    },
    {
      key: "funnel",
      label: "Create your first funnel",
      desc: "Track a signup or checkout and see exactly where users drop off.",
      done: funnels > 0,
      cta: "New funnel",
      to: "/funnels/new",
    },
    {
      key: "cohort",
      label: "Build a cohort",
      desc: "Save a segment like “power users” and filter every screen to it.",
      done: (cohorts?.length ?? 0) > 0,
      cta: "New cohort",
      to: "/cohorts?new=1",
    },
    {
      key: "team",
      label: "Invite your team",
      desc: "Bring teammates in to review sessions and share findings.",
      done: memberCount > 1,
      cta: "Invite",
      to: "/settings/team",
    },
    {
      key: "integration",
      label: "Connect an integration",
      desc: "Route issues to Slack, Linear, or PagerDuty automatically.",
      done: (integrations?.length ?? 0) > 0,
      cta: "Connect",
      to: "/settings/integrations",
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  const pct = Math.round((doneCount / items.length) * 100);
  const stepFlags = useMemo(
    () =>
      Object.fromEntries(items.map((i) => [i.key, i.done])) as Record<
        OnbStepKey,
        boolean
      >,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items.map((i) => (i.done ? "1" : "0")).join("")],
  );

  // ── Celebration sequencing: any step whose completion we haven't celebrated
  //    yet (persisted per workspace) fires the hero one-shot — one at a time,
  //    whether it completed live on this page or while the user was away.
  const [fired, setFired] = useState<OnbStepKey | null>(null);
  const queueRef = useRef<OnbStepKey[]>([]);
  const playingRef = useRef(false);
  useEffect(() => {
    const doneKeys = ONB_STEP_KEYS.filter((k) => stepFlags[k]);
    const raw = onbStore.get(workspaceId, "seen");
    if (raw === null) {
      // First render of this surface for the workspace — record without firing.
      onbStore.set(workspaceId, "seen", JSON.stringify(doneKeys));
      return;
    }
    let seen: string[] = [];
    try {
      seen = JSON.parse(raw) as string[];
    } catch {
      seen = [];
    }
    const fresh = doneKeys.filter((k) => !seen.includes(k));
    if (!fresh.length) return;
    onbStore.set(workspaceId, "seen", JSON.stringify(doneKeys));
    queueRef.current.push(...fresh);
    if (playingRef.current) return;
    playingRef.current = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const playNext = (delay: number) => {
      const k = queueRef.current.shift();
      if (!k) {
        playingRef.current = false;
        return;
      }
      timers.push(
        setTimeout(() => {
          setFired(k);
          timers.push(
            setTimeout(() => {
              setFired(null);
              playNext(280);
            }, 1450),
          );
        }, delay),
      );
    };
    playNext(350);
    return () => {
      timers.forEach(clearTimeout);
      playingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepFlags, workspaceId]);

  const card: CSSProperties = {
    maxWidth: compact ? "none" : 640,
    margin: compact ? "0 0 20px" : "48px auto",
    border: "1px solid var(--line)",
    background: "var(--surface)",
    padding: compact ? "18px 20px" : 0,
    overflow: "hidden",
  };

  const skipSetup = () => {
    onbStore.set(workspaceId, "skipped", "1");
    onSkip?.();
  };

  const body = (
    <>
      <div
        style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-12)", marginBottom: "var(--sp-4)" }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: compact ? 14 : 17,
              fontWeight: "var(--fw-semibold)",
              letterSpacing: "-.01em",
              color: "var(--text)",
            }}
          >
            {doneCount === items.length
              ? "You're all set 🎉"
              : "Get started with Replayfy"}
          </div>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--t3)", marginTop: "var(--sp-4)" }}>
            {doneCount} of {items.length} complete — finish setup to get the most
            out of your workspace.
          </div>
        </div>
        {compact && onDismiss && (
          <button
            className="ibtn"
            onClick={onDismiss}
            aria-label="Dismiss setup checklist"
            title="Dismiss"
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 4,
          background: "var(--line-2)",
          margin: "var(--sp-12) 0 var(--sp-18)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: pct + "%",
            height: "100%",
            background: "var(--accent)",
            transition: "width 300ms cubic-bezier(0.23,1,0.32,1)",
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        {items.map((it) => (
          <div
            key={it.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--sp-12)",
              padding: "var(--sp-10) 0",
              borderTop: "1px solid var(--line)",
              opacity: it.done ? 0.62 : 1,
            }}
          >
            <span
              style={{
                flexShrink: 0,
                width: 20,
                height: 20,
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                background: it.done ? "var(--accent)" : "transparent",
                border: it.done ? "none" : "1.5px solid var(--line-strong)",
                color: "#fff",
              }}
            >
              {it.done && <Icon name="check" size={12} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: "var(--text-base)",
                  fontWeight: "var(--fw-medium)",
                  color: "var(--text)",
                  textDecoration: it.done ? "line-through" : "none",
                }}
              >
                {it.label}
              </div>
              {!compact && (
                <div style={{ fontSize: "var(--text-xs)", color: "var(--t3)", marginTop: "var(--sp-2)" }}>
                  {it.key === "sdk" && listening ? (
                    <span style={{ color: "var(--text)" }}>
                      <span className="rf-onb-listen" aria-hidden="true" />
                      Listening for the first event…
                    </span>
                  ) : (
                    it.desc
                  )}
                </div>
              )}
            </div>
            {!it.done && (
              <button
                className="btn sm"
                onClick={() => {
                  if (it.key === "sdk")
                    onbStore.set(workspaceId, "install-opened", "1");
                  navigate(it.to);
                }}
                style={{ flexShrink: 0 }}
              >
                {it.cta}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Once the SDK step is done, everything else can wait — people can get
          to their recordings and finish setup later from the dashboard banner.
          The gate watches sdkDone, which is now the REAL first-event signal
          (recordings > 0, live-polled), so it appears exactly when the workspace
          has actually started receiving sessions. */}
      {!compact && sdkDone && (
        <div
          style={{
            display: "flex",
            justifyContent: doneCount === items.length ? "flex-end" : "center",
            marginTop: "var(--sp-16)",
            paddingTop: "var(--sp-14)",
            borderTop: "1px solid var(--line)",
          }}
        >
          {doneCount === items.length ? (
            <button className="btn primary" onClick={skipSetup}>
              Go to your dashboard
            </button>
          ) : (
            <button
              className="btn sm q"
              onClick={() => {
                onbStore.set(workspaceId, "skipped", "1");
                onSkip?.();
                navigate("/recordings");
              }}
              title="Finish the remaining steps later from the dashboard"
            >
              Skip for now — go to your recordings →
            </button>
          )}
        </div>
      )}
    </>
  );

  if (compact) return <div style={card}>{body}</div>;

  return (
    <div style={card}>
      <div
        style={{
          background: "linear-gradient(120deg,#F7F8FF,#EFF1FE)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <OnboardingHero power={doneCount} steps={stepFlags} fired={fired} />
      </div>
      <div style={{ padding: "var(--sp-20) var(--sp-28) var(--sp-24)" }}>{body}</div>
    </div>
  );
}
