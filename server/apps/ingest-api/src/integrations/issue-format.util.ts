/**
 * Shared issue-body formatter for the external issue integrations (Linear +
 * GitHub). Renders a rich Markdown body from investigation / session evidence —
 * summary, business impact, confidence, affected release/platforms/browsers,
 * replay deep links, and next steps — so an engineer can start debugging without
 * copying anything out of Replayfy. Extracted here so BOTH the AI agent's
 * linear/github issue capabilities AND the deterministic session-issue endpoint
 * produce an IDENTICAL body + deep-link format (no drift between the two paths).
 *
 * Session ids become dashboard deep links when DASHBOARD_URL is set, else are
 * listed as `session:<id>` references. `footer` is the trailing caption and
 * defaults to the agent's wording so existing agent-filed issues are unchanged.
 */
export function buildIssueBody(
  input: Record<string, unknown>,
  footer = "_Created by Replayfy AI._",
): string {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
  const lines: string[] = [];
  if (str(input.summary)) lines.push(`## Summary\n${str(input.summary)}`);
  if (str(input.impact)) lines.push(`## Business impact\n${str(input.impact)}`);
  const facts: string[] = [];
  if (str(input.confidence)) facts.push(`**Confidence:** ${str(input.confidence)}`);
  if (str(input.release)) facts.push(`**Affected release:** ${str(input.release)}`);
  if (arr(input.platforms).length)
    facts.push(`**Platforms:** ${arr(input.platforms).join(", ")}`);
  if (arr(input.browsers).length)
    facts.push(`**Browsers:** ${arr(input.browsers).join(", ")}`);
  if (facts.length) lines.push(facts.join("\n"));
  const sessions = arr(input.sessions).slice(0, 20);
  if (sessions.length) {
    const base = (process.env.DASHBOARD_URL ?? "").replace(/\/$/, "");
    const links = sessions.map((s) =>
      base ? `- ${base}/sessions/${s}` : `- session:${s}`,
    );
    lines.push(`## Replays\n${links.join("\n")}`);
  }
  const steps = arr(input.nextSteps);
  if (steps.length)
    lines.push(`## Suggested next steps\n${steps.map((s) => `- ${s}`).join("\n")}`);
  lines.push(`\n---\n${footer}`);
  return lines.join("\n\n");
}
