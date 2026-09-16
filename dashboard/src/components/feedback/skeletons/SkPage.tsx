import { SkStats } from "./SkStats";
import { SkChart } from "./SkChart";
import { SkList } from "./SkList";
import { SkTable } from "./SkTable";

type SkPageProps = { kind?: string };

/* full-page compositions keyed by page */
export function SkPage({ kind = 'table' }: SkPageProps) {
  if (kind === 'dashboard') return <div className="sk-page"><SkStats /><SkChart /><div style={{ height: 24 }} /><SkList rows={4} /></div>;
  if (kind === 'funnels') return <div className="sk-page"><SkStats n={5} /><SkChart h={280} /></div>;
  if (kind === 'list') return <div className="sk-page"><SkList /></div>;
  return <div className="sk-page"><SkStats /><SkTable /></div>;
}
