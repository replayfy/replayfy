import { Sk } from "./Sk";

type SkListProps = { rows?: number };

/* list rows (comments, insights, playlists) */
export function SkList({ rows = 6 }: SkListProps) {
  return (
    <div className="sk-list">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="sk-li" key={i}>
          <Sk w={30} h={30} r={8} />
          <div style={{ flex: 1 }}><Sk w={`${50 + (i % 3) * 12}%`} h={12} /><Sk w={`${30 + (i % 4) * 10}%`} h={10} style={{ marginTop: "var(--sp-8)" }} /></div>
          <Sk w={54} h={22} r={7} />
        </div>
      ))}
    </div>
  );
}
