import type { Dispatch, SetStateAction } from "react";
import {
  adaptProps,
  type ApiSessionDetail,
} from "../recordings.data";

type PropertiesPanelProps = {
  detail?: ApiSessionDetail;
  propShut: Record<string, boolean>;
  setPropShut: Dispatch<SetStateAction<Record<string, boolean>>>;
  copyVal: (k: string, v: string) => void;
  copied: string | null;
};

/* Custom properties — built from the opened session's real detail (endUser
   traits + customProperties + device/session facts). Fixture until it loads. */
export function PropertiesPanel({
  detail,
  propShut,
  setPropShut,
  copyVal,
  copied,
}: PropertiesPanelProps) {
  /* No fixture fallback: RV_PROPS put maria@acme.io / Pro / u_8841c2 under
     whichever session was open, which is the most convincing lie in the app —
     invented identity rendered as this user's properties. adaptProps already
     maps every group from ApiSessionDetail. */
  const groups = detail ? adaptProps(detail) : {};
  if (!Object.keys(groups).length)
    return (
      <div className="rv-panel rv-dbg rv-prop">
        <div className="rv-prop-empty">
          No properties for this recording yet.
        </div>
      </div>
    );
  return (
    <div className="rv-panel rv-dbg rv-prop">
      {Object.entries(groups).map(([g, rows]) => {
        const shut = propShut[g];
        return (
          <div key={g} className="rv-prop-g">
            <button
              className={`rv-prop-h ${shut ? "shut" : ""}`}
              onClick={() => setPropShut((p) => ({ ...p, [g]: !p[g] }))}
            >
              <svg width="9" height="9" viewBox="0 0 10 10" className="tri">
                <path d="M3 2l4 3-4 3z" fill="currentColor" />
              </svg>
              {g}
              <span className="ct">{rows.length}</span>
            </button>
            {!shut && rows.length === 0 && (
              <div className="rv-prop-empty">
                No custom properties on this session. Send them with
                setSessionProperty() or identify().
              </div>
            )}
            {!shut &&
              rows.map((r) => (
                <div
                  key={r[0]}
                  className="rv-prow"
                  onClick={() => copyVal(g + r[0], String(r[1]))}
                >
                  <span className="k">{r[0]}</span>
                  <span className={`v ${r[2] ? "acc" : ""}`}>{r[1]}</span>
                  <span className="cp">
                    {copied === g + r[0] ? "copied" : "copy"}
                  </span>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
