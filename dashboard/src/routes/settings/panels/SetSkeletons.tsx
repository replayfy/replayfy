import { Sk } from "@/components/feedback";

/* ============================================================================
   Loading skeletons for the Settings panels.

   Every panel here reads its own endpoint, and each one used to paint its
   settled state while that read was still in flight — not a blank, a wrong
   answer that happens to resolve: Team rendered "No members yet." over a
   staffed workspace, Install rendered "No API keys yet." under a "Waiting for
   your first event…" banner on a workspace that has been ingesting for months,
   AI rendered "$0.00 / 0 tokens · No AI usage recorded" and lit the PLATFORM
   provider card for a workspace that is on BYOK. Each of those is the zero
   value of a number nobody has counted yet. These stand in until the panel's
   own read reports.

   Each piece wears the real markup's own class names (.set-team-member,
   .ins-banner, .ai-cfg, .set-ai-usage …) so it occupies the true geometry and
   needs no CSS of its own — .sk-box already carries the shimmer and already
   honours prefers-reduced-motion. Widths vary deterministically off the row
   index so a table reads as a list of distinct rows rather than a stack of
   identical bars; never Math.random(), which would reshuffle on every
   re-render.

   The table pieces render <tr>s only, never their own <table>: the real thead
   is static chrome and keeps rendering, so the column widths it declares stay
   in force and the rows don't re-lay-out when the data lands.

   Panels gate these on `loading || stale` and never on `syncing` — refetching
   after a save reconciles the SAME key, and blinking a skeleton over rows that
   are already correct would be a downgrade (see useApi.ts).
   ========================================================================== */

/** Members table rows — the .set-team-tbl body while GET .../members resolves. */
export function SkTeamRows({ n = 4 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <tr key={i}>
          <td style={{ paddingLeft: "var(--sp-16)" }}>
            <div className="set-team-member">
              {/* .u-av's geometry (30px round) without its per-name hue fill —
                  uhue() is derived from the name, which is what's loading. */}
              <Sk w={30} h={30} r={99} />
              <div style={{ minWidth: 0, display: "grid", gap: "var(--sp-6)" }}>
                <Sk w={92 + ((i * 23) % 44)} h={10} />
                <Sk w={128 + ((i * 19) % 52)} h={8} />
              </div>
            </div>
          </td>
          {/* Role — the owner's static .tag badge and everyone else's Select are
              the same control-sized block until we know which row is which. */}
          <td>
            <Sk w={64} h={17} r={5} />
          </td>
          <td>
            <Sk w={52 + ((i * 13) % 24)} h={9} />
          </td>
          <td />
        </tr>
      ))}
    </>
  );
}

/** Pending-invite rows. This table has no thead, so the rows carry the same
 *  column widths the real ones do or the table re-lays-out when they land. */
export function SkInviteRows({ n = 2 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <tr key={i}>
          <td style={{ paddingLeft: "var(--sp-16)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-10)" }}>
              <Sk w={28} h={28} r={99} />
              <div style={{ display: "grid", gap: "var(--sp-6)" }}>
                <Sk w={132 + ((i * 29) % 46)} h={9} />
                <Sk w={88 + ((i * 17) % 30)} h={8} />
              </div>
            </div>
          </td>
          <td style={{ width: 110 }}>
            <Sk w={52} h={16} r={5} />
          </td>
          <td style={{ width: 180, paddingRight: "var(--sp-12)" }}>
            <div
              style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-6)" }}
            >
              <Sk w={68} h={24} r={7} />
              <Sk w={26} h={24} r={7} />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

/** API-key rows (Key / Scope / Created / Last used / Last rotated / •••). */
export function SkKeyRows({ n = 2 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <tr key={i}>
          <td style={{ paddingLeft: "var(--sp-16)" }}>
            <div style={{ display: "grid", gap: "var(--sp-6)" }}>
              <Sk w={104 + ((i * 21) % 40)} h={10} />
              <Sk w={148 + ((i * 17) % 36)} h={8} />
            </div>
          </td>
          <td>
            <Sk w={46} h={16} r={5} />
          </td>
          <td>
            <Sk w={58 + ((i * 11) % 18)} h={8} />
          </td>
          <td>
            <Sk w={54 + ((i * 19) % 22)} h={8} />
          </td>
          <td>
            <Sk w={56 + ((i * 13) % 20)} h={8} />
          </td>
          <td />
        </tr>
      ))}
    </>
  );
}

/** Allowed-hosts rows — one mono host per row + its remove button's column. */
export function SkHostRows({ n = 2 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <tr key={i}>
          <td style={{ paddingLeft: "var(--sp-16)" }}>
            <Sk w={140 + ((i * 31) % 72)} h={9} />
          </td>
          <td style={{ width: 44 }} />
        </tr>
      ))}
    </>
  );
}

/** The install status banner. Deliberately the BASE .ins-banner with no .ok /
 *  .wait modifier and no dot/pulse: which of the two it is — "Replay is active"
 *  vs "Waiting for your first event…" — is the entire question the counts read
 *  answers, and guessing wrong is what this replaces. */
export function SkInstallBanner() {
  return (
    <div className="ins-banner">
      <span className="ins-banner-ic">
        <Sk w={9} h={9} r={99} />
      </span>
      {/* gap widened from the real 2px to stand the two lines off at roughly the
          heights their 13px / 11.5px type occupies, so the snippet below doesn't
          jump when the banner resolves. */}
      <div className="ins-banner-txt" style={{ gap: "var(--sp-12)" }}>
        <Sk w={132} h={11} />
        <Sk w={244} h={9} />
      </div>
    </div>
  );
}

/** The AI Configuration block. Which block is the real one — PLATFORM's status
 *  rows or BYOK's provider + key form — is itself what the llm read decides, so
 *  this stands in for the shape they share: a bordered card of label + value
 *  rows, at PLATFORM's three. */
export function SkAiCfg() {
  return (
    <div className="ai-cfg">
      {[168, 196, 132].map((w, i) => (
        <div className="ai-cfg-row" key={i}>
          <span className="ai-cfg-k">
            <Sk w={44 + ((i * 17) % 20)} h={8} />
          </span>
          <Sk w={w} h={10} />
        </div>
      ))}
    </div>
  );
}

/** The 30-day AI usage summary: three stat tiles over the per-surface breakdown. */
export function SkAiUsage({ rows = 4 }: { rows?: number }) {
  return (
    <div className="set-ai-usage">
      <div className="set-ai-usage-stats">
        {Array.from({ length: 3 }, (_, i) => (
          <div className="set-ai-stat" key={i}>
            <Sk w={64 + ((i * 23) % 30)} h={20} />
            <Sk w={44 + ((i * 13) % 18)} h={8} />
          </div>
        ))}
      </div>
      <div className="set-ai-breakdown">
        {Array.from({ length: rows }, (_, i) => (
          <div className="set-ai-brow" key={i}>
            <span className="set-ai-brow-l">
              <Sk w={56 + ((i * 19) % 44)} h={9} />
            </span>
            {/* Inside the real track, so the bar keeps its 6px rail — a shimmer
                fill rather than the accent gradient, which at a made-up width
                would read as a measurement. */}
            <span className="set-ai-brow-track">
              <Sk w={`${34 + ((i * 23) % 52)}%`} h={6} r={3} />
            </span>
            <span className="set-ai-brow-v">
              <Sk w={40} h={8} style={{ marginLeft: "auto" }} />
            </span>
            <span className="set-ai-brow-c">
              <Sk w={34} h={8} style={{ marginLeft: "auto" }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
