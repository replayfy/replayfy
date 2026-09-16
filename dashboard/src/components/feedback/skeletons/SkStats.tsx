import { Sk } from "./Sk";

type SkStatsProps = { n?: number };

/* stat cards row */
export function SkStats({ n = 4 }: SkStatsProps) {
  return (
    <div className="sk-stats">
      {Array.from({ length: n }).map((_, i) => (
        <div className="sk-stat" key={i}><Sk w="52%" h={10} /><Sk w="70%" h={22} style={{ marginTop: "var(--sp-12)" }} /><Sk w="40%" h={9} style={{ marginTop: "var(--sp-10)" }} /></div>
      ))}
    </div>
  );
}
