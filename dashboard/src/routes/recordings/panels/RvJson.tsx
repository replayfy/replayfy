/* ---- JSON response viewer: pretty-printed, collapsible tree (handles long bodies) ---- */
import { useState } from "react";

function RvPrim({ value }: { value: any }) {
  if (typeof value === "string") return <span className="js">"{value}"</span>;
  if (typeof value === "number")
    return <span className="jn">{String(value)}</span>;
  return <span className="jb">{String(value)}</span>; // boolean | null
}
function RvJsonNode({
  kk,
  value,
  depth,
  isLast,
}: {
  kk: any;
  value: any;
  depth: number;
  isLast: boolean;
}) {
  const isObj = value !== null && typeof value === "object";
  const arr = Array.isArray(value);
  const entries: any = isObj
    ? arr
      ? value.map((v: any, i: number) => [i, v])
      : Object.entries(value)
    : null;
  // collapse deep / large nodes by default so long responses stay scannable
  const big = isObj && (entries.length > 12 || depth >= 3);
  const [open, setOpen] = useState(isObj ? depth < 2 && !big : false);
  const pad = { paddingLeft: depth * 13 + "px" };
  const keyLabel =
    typeof kk === "string" ? (
      <>
        <span className="jk">"{kk}"</span>
        <span className="jp">: </span>
      </>
    ) : null;
  const comma = !isLast ? <span className="jp">,</span> : null;
  if (!isObj)
    return (
      <div className="jline" style={pad}>
        <span className="jcaret none" />
        {keyLabel}
        <RvPrim value={value} />
        {comma}
      </div>
    );
  const openB = arr ? "[" : "{",
    closeB = arr ? "]" : "}";
  if (!open)
    return (
      <div className="jline fold" style={pad} onClick={() => setOpen(true)}>
        <span className="jcaret">▸</span>
        {keyLabel}
        <span className="jp">{openB}</span>
        <span className="jpv">
          {" "}
          {entries.length} {arr ? "items" : "keys"}{" "}
        </span>
        <span className="jp">{closeB}</span>
        {comma}
      </div>
    );
  return (
    <>
      <div className="jline fold" style={pad} onClick={() => setOpen(false)}>
        <span className="jcaret">▾</span>
        {keyLabel}
        <span className="jp">{openB}</span>
      </div>
      {entries.map(([ck, cv]: any, i: number) => (
        <RvJsonNode
          key={ck}
          kk={arr ? ck * 1 : ck}
          value={cv}
          depth={depth + 1}
          isLast={i === entries.length - 1}
        />
      ))}
      <div className="jline" style={pad}>
        <span className="jcaret none" />
        <span className="jp">{closeB}</span>
        {comma}
      </div>
    </>
  );
}
export function RvJson({ src }: { src: string }) {
  let parsed,
    ok = true;
  try {
    parsed = JSON.parse(src);
  } catch (e) {
    ok = false;
  }
  if (!ok || typeof parsed !== "object")
    return <pre className="rv-json rv-json-dark plain">{src}</pre>;
  return (
    <div className="rv-json rv-json-dark">
      <RvJsonNode kk={null} value={parsed} depth={0} isLast />
    </div>
  );
}
