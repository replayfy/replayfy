import { AiBadge, Icon, NumberFlow, Popover } from "@/components/primitives";
import type { FnListItem } from "../funnels.data";

type FunnelRowProps = {
  f: FnListItem;
  onOpen: () => void;
  onDuplicate?: () => void;
  onSaveTemplate?: () => void;
  onDelete?: () => void;
};

export function FunnelRow({ f, onOpen, onDuplicate, onSaveTemplate, onDelete }: FunnelRowProps) {
  const cls = f.conv >= 50 ? "good" : f.conv >= 30 ? "neutral" : "poor";
  return (
    <div className={`fnx-row ${f.archived ? "arch" : ""}`} onClick={onOpen}>
      <div className="fnx-main">
        <div className="fnx-name">
          <span className="fnx-name-t">{f.name}</span>
          {f.createdByAi && <AiBadge />}
          {f.archived && <span className="fnx-arch">Archived</span>}
        </div>
        <div className="fnx-desc">{f.desc}</div>
      </div>
      <div className={`fnx-conv ${cls}`}>
        <span className="v">
          <NumberFlow value={f.conv} decimals={1} />
          <span className="pct">%</span>
        </span>
        {f.trend !== 0 && (
          <span className={`tr ${f.trend > 0 ? "up" : "dn"}`}>
            {f.trend > 0 ? "↗" : "↘"}
            <NumberFlow value={Math.abs(f.trend)} decimals={1} />
          </span>
        )}
      </div>
      <div className="fnx-sess">
        <NumberFlow value={f.sessions} />
      </div>
      <div className="fnx-steps">
        <NumberFlow value={f.steps} /> steps
      </div>
      <div className="fnx-upd">{f.updated}</div>
      <div className="fnx-actions" onClick={(e) => e.stopPropagation()}>
        <Popover
          align="right"
          trigger={
            <button className="fnx-more" aria-label="Actions">
              <Icon name="more" size={15} />
            </button>
          }
        >
          {({ close }: { close: () => void }) => (
            <div className="fnx-menu">
              <button onClick={onOpen}>
                <Icon name="arrowR" size={13} /> Open
              </button>
              <button
                onClick={() => {
                  close();
                  onDuplicate?.();
                }}
              >
                <Icon name="copy" size={13} /> Duplicate
              </button>
              <button
                onClick={() => {
                  close();
                  onSaveTemplate?.();
                }}
              >
                <Icon name="plus" size={13} /> Save as template
              </button>
              <div className="fnx-menu-sep" />
              <button
                className="danger"
                onClick={() => {
                  close();
                  onDelete?.();
                }}
              >
                <Icon name="trash" size={13} /> Delete
              </button>
            </div>
          )}
        </Popover>
      </div>
    </div>
  );
}
