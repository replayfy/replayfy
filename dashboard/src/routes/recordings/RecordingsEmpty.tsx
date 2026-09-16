import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Prism from "prismjs";
// Grammars for the SNIP snippets (order matters: dependants load last).
import "prismjs/components/prism-markup";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-dart";
import "prismjs/components/prism-go";
import "prismjs/components/prism-python";
import { Icon, Select, type SelectOption } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Dashboard } from "@/api/endpoints";
import { relTime } from "@/lib/format";
import { PLATFORMS, SNIP } from "@/routes/settings/settings.data";

/* SNIP `lang` label → Prism grammar key (falls back to clike). */
const PRISM_LANG: Record<string, string> = {
  HTML: "markup",
  TSX: "tsx",
  TS: "typescript",
  Swift: "swift",
  Kotlin: "kotlin",
  Dart: "dart",
  Go: "go",
  Python: "python",
  JS: "javascript",
};

type DashCounts = {
  recordings: number;
  live: number;
  lastEventAt: string | null;
  lastEventDomain: string | null;
};

type Props = {
  /** Refetch the recordings list — called when the user chooses to view the
   *  sessions that just started arriving. */
  onEventLanded: () => void;
};

/* Recordings first-run onboarding. The page is wide, so instead of a lone
   "Install the SDK" button it shows the real install editor (every SDK) beside
   the illustration, plus a LIVE "waiting for your first event" status that polls
   the workspace event counter (GET /v1/dashboard/counts — one indexed aggregate,
   no scan) every few seconds and flips to a success state the moment a session
   lands. Reuses the frozen .ins-* editor/banner styles; layout via .rvo-*. */
export function RecordingsEmpty({ onEventLanded }: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState("web");
  const [copied, setCopied] = useState(false);
  const [counts, setCounts] = useState<DashCounts | null>(null);
  const [landed, setLanded] = useState(false);
  const landedRef = useRef(false);

  // Live poll for the first event. Stops as soon as one arrives. Cheap: a single
  // cached per-workspace counter, not a session scan.
  useEffect(() => {
    let stopped = false;
    const timer = setInterval(poll, 5000);
    async function poll() {
      try {
        const r = await Dashboard.counts<DashCounts>();
        if (stopped) return;
        setCounts(r.data);
        if ((r.data.recordings ?? 0) > 0 && !landedRef.current) {
          landedRef.current = true;
          setLanded(true);
          clearInterval(timer);
        }
      } catch {
        /* transient — keep polling */
      }
    }
    poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const snip = SNIP[tab];
  const lang = PRISM_LANG[snip.lang] ?? "clike";

  const platOptions: SelectOption[] = [
    { header: "Web" },
    ...PLATFORMS.filter((p) => p.group === "Web").map((p) => ({
      value: p.id,
      label: p.label,
    })),
    { divider: true },
    { header: "Mobile" },
    ...PLATFORMS.filter((p) => p.group === "Mobile").map((p) => ({
      value: p.id,
      label: p.label,
    })),
  ];

  const copyCode = () => {
    try {
      navigator.clipboard?.writeText(snip.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast && toast("Couldn't copy", { kind: "err" });
    }
  };

  return (
    <div className="rvo-root">
      <div className="rvo-grid">
        {/* LEFT — illustration + copy */}
        <div className="rvo-left">
          <img src="/illustrations/recordings.svg" alt="" className="rvo-illo" />
          <h1
            style={{
              fontSize: "var(--text-2xl)",
              fontWeight: "var(--fw-semibold)",
              letterSpacing: "-.02em",
              margin: 0,
            }}
          >
            Recordings
          </h1>
          <p
            style={{
              fontSize: "var(--text-md)",
              color: "var(--t2)",
              lineHeight: "var(--lh-loose)",
              margin: "var(--sp-10) 0 0",
              maxWidth: "48ch",
            }}
          >
            Replayable sessions of real users in your app — every click, page,
            console error and network call, indexed so you can jump straight to
            the moment that matters. Add the SDK and they start landing here live.
          </p>
        </div>

        {/* RIGHT — live status ON TOP of the real install editor (every SDK) */}
        <div className="rvo-right">
          {landed ? (
            <div style={{ marginBottom: "var(--sp-18)" }}>
              <div className="ins-banner ok">
                <span className="ins-banner-ic">
                  <span className="ins-banner-dot" />
                </span>
                <div className="ins-banner-txt">
                  <b>Your first event just arrived</b>
                  <span>
                    Replay is active
                    {counts?.lastEventDomain && (
                      <>
                        {" "}
                        · <span className="mono">{counts.lastEventDomain}</span>
                      </>
                    )}
                    . Sessions are ready to watch.
                  </span>
                </div>
              </div>
              <button
                className="btn primary"
                style={{ marginTop: "var(--sp-14)" }}
                onClick={onEventLanded}
              >
                <Icon name="play" size={13} fill /> View recordings
              </button>
            </div>
          ) : (
            <div className="ins-banner wait" style={{ marginBottom: "var(--sp-18)" }}>
              <span className="ins-banner-ic">
                <span className="ins-banner-pulse" />
              </span>
              <div className="ins-banner-txt">
                <b>Waiting for your first event…</b>
                <span>
                  This page is live — your first session appears within seconds of
                  installing the snippet.
                  {counts?.lastEventAt && (
                    <>
                      {" "}
                      Last checked {relTime(counts.lastEventAt)}.
                    </>
                  )}
                </span>
              </div>
            </div>
          )}

          <div style={{ marginBottom: "var(--sp-12)" }}>
            <div style={{ fontSize: "var(--text-md)", fontWeight: "var(--fw-semibold)", letterSpacing: "-.01em" }}>
              Install the SDK
            </div>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--t3)", marginTop: "var(--sp-4)" }}>
              Pick your framework and drop this into your app.
            </div>
          </div>

          <div className="ins-code">
            <div className="ins-code-h">
              <div className="ins-plat-sel">
                <Select
                  value={tab}
                  options={platOptions}
                  onChange={setTab}
                  width={168}
                  menuClass="ins-plat-menu"
                />
              </div>
              <span style={{ flex: 1 }} />
              <span className="ins-lang">{snip.lang}</span>
              <span className="ins-title mono">{snip.title}</span>
              <button className="ins-copy" onClick={copyCode} title="Copy code">
                {copied ? (
                  <>
                    <Icon name="check" size={12} /> Copied
                  </>
                ) : (
                  <>
                    <Icon name="copy" size={12} /> Copy
                  </>
                )}
              </button>
            </div>
            {/* Read-only snippet — a static Prism-highlighted <pre> (no editable
                textarea overlay, which was rendering as white blocks). */}
            <pre
              className="ins-editor"
              style={{
                margin: 0,
                padding: "var(--sp-16)",
                fontFamily: "var(--mono)",
                fontSize: "var(--text-sm)",
                lineHeight: "var(--lh-loose)",
                whiteSpace: "pre",
                overflowX: "auto",
              }}
            >
              <code
                dangerouslySetInnerHTML={{
                  __html: Prism.highlight(
                    snip.code,
                    Prism.languages[lang] || Prism.languages.clike,
                    lang,
                  ),
                }}
              />
            </pre>
          </div>

          <div style={{ marginTop: "var(--sp-16)", display: "flex", gap: "var(--sp-10)", alignItems: "center" }}>
            <button
              className="btn primary"
              onClick={() => navigate("/settings/install")}
            >
              <Icon name="doc" size={14} /> Full install guide &amp; API keys
            </button>
            <button
              className="btn"
              onClick={() =>
                window.open(
                  "https://docs.replayfy.app/products/session-replay",
                  "_blank",
                  "noopener",
                )
              }
            >
              Documentation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
