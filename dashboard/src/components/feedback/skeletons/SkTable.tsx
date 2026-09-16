import { Sk } from "./Sk";

type SkTableProps = {
  rows?: number;
  cols?: (number | string)[];
};

/* table rows (recordings, users, crashes) */
export function SkTable({ rows = 8, cols }: SkTableProps) {
  const c = cols || [22, '38%', '18%', '14%', 60];
  return (
    <div className="sk-table">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="sk-tr" key={i}>
          {c.map((w, j) => <Sk key={j} w={typeof w === 'number' ? w : w} h={j === 0 ? 22 : 11} r={j === 0 ? 6 : 4} />)}
        </div>
      ))}
    </div>
  );
}
