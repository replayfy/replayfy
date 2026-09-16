import { pct } from "../helpers";
import { RV_SPANS } from "../recordings.data";

// TODO(api): distributed traces — no backend endpoint exposes span/trace data
// for a session yet, so this panel stays on the fixture.
export function TracesPanel() {
  return (
    <div className="rv-panel rv-dbg rv-trace">
      <div className="rv-dbg-sec">
        Distributed trace
        <span className="sp" />
        <span className="rv-dbg-meta">7f3a…c91</span>
      </div>
      <div className="rv-trace-meta">
        <span>6 spans</span>
        <span className="dot">·</span>
        <span className="e">1 error span</span>
        <span className="dot">·</span>
        <span>184 ms total</span>
      </div>
      {RV_SPANS.map((sp, i) => (
        <div
          key={i}
          className={`rv-span d${sp[6]} ${sp[4] === "err" ? "is-err" : ""}`}
        >
          <div className="rv-span-l" style={{ paddingLeft: sp[6] * 13 }}>
            {sp[6] > 0 && <span className="rv-span-gut" />}
            <span className={`dot ${sp[4]}`} />
            <span className="nm">{sp[0]}</span>
            <span className="svc">{sp[1]}</span>
            {sp[4] === "err" && <span className="err-tag">500</span>}
          </div>
          <div className="rv-span-wf">
            <i
              className={
                sp[4] === "err" ? "err" : sp[4] === "slow" ? "slow" : ""
              }
              style={{ left: pct(sp[2]), width: pct(Math.max(4, sp[3])) }}
            />
            <span className="rv-span-d">{sp[5]}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
