import { useMemo, useState, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, Seg, Search } from "@/components/primitives";
import { MiniSpark } from "@/components/charts";
import { useApi } from "@/api/useApi";
import { Analytics } from "@/api/endpoints";
import { rangeToken } from "@/routes/overview/overview.api";
import { SkTable } from "@/components/feedback/skeletons";
import {
  ANL_COLORS, fmtK, fmtAgo, kindLabel, typeLabel,
  sparkDelta, type EvEvent, type EvProp, type EvKind,
} from "./events.data";

/* ============================================================================
   Events (#7) — the event & property LEXICON, composed VOLUME-FIRST.

   Analytical hierarchy: context → SUBJECT → temporal behaviour → detail.
   A subject header names the catalogue and frames it by the one number that
   matters (total captured volume + the busiest event), computed from the data.
   Controls (Events/Properties + Search) recede into a quiet row on the right.
   The flat grouped table is the detailed data — its 30-day VOLUME column is the
   emphasis (the subject, mono + heavier), the sparkline the temporal behaviour,
   and a row opens the property-depth Drawer. UI-first mock (events.data.ts).
   ========================================================================== */

type Tab = "events" | "properties";
const isAuto = (key: string) => key.startsWith("$");
const isEvent = (x: EvEvent | EvProp): x is EvEvent => (x as EvEvent).kind !== undefined;
const kindClass = (k: EvKind) => "anl-ev-kind k-" + k;

/** A row's slice of captured volume — measured against the catalogue's total
    event volume (the denominator). Kept ≤100% and never "0%". */
const volShare = (v: number, total: number): string => {
  const p = total > 0 ? (v / total) * 100 : 0;
  return p >= 1 ? Math.round(p) + "%" : "<1%";
};

export function EventsExplorer({ range = "Last 30 days" }: { range?: string }) {
  const [tab, setTab] = useState<Tab>("events");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<EvEvent | EvProp | null>(null);

  // Real catalogues from ClickHouse; the seeded arrays are the placeholder (also
  // the fallback when a fresh workspace has no events yet, so the header never
  // renders a broken empty state).
  const { data: evData } = useApi<EvEvent[]>(() => Analytics.events<EvEvent[]>(rangeToken(range)), [range]);
  const { data: propData } = useApi<EvProp[]>(() => Analytics.properties<EvProp[]>(rangeToken(range)), [range]);
  const catEvents = evData ?? [];
  const catProps = propData ?? [];
  const totalEventVol = useMemo(() => catEvents.reduce((a, e) => a + e.volume, 0), [catEvents]);
  const propEventSpan = useMemo(() => Math.max(1, ...catProps.map((p) => p.eventCount)), [catProps]);

  const ql = q.trim().toLowerCase();
  const match = (k: string, n: string) => !ql || k.toLowerCase().includes(ql) || n.toLowerCase().includes(ql);
  const events = useMemo(() => catEvents.filter((e) => match(e.key, e.name)), [catEvents, ql]);
  const props = useMemo(() => catProps.filter((p) => match(p.key, p.name)), [catProps, ql]);

  const rows: (EvEvent | EvProp)[] = tab === "events" ? events : props;
  const auto = rows.filter((r) => isAuto(r.key));
  const custom = rows.filter((r) => !isAuto(r.key));
  const count = rows.length;
  const total = tab === "events" ? catEvents.length : catProps.length;
  const noun = tab === "events" ? "event" : "property";
  const nounP = tab === "events" ? "events" : "properties";

  // --- the SUBJECT: busiest item in the active catalogue, by volume ---------
  const busiest = useMemo<EvEvent | EvProp>(() => {
    const c: (EvEvent | EvProp)[] = tab === "events" ? catEvents : catProps;
    return c.length
      ? c.reduce((b, r) => (r.volume > b.volume ? r : b))
      : ({ key: "", name: "—", volume: 0 } as EvEvent);
  }, [tab, catEvents, catProps]);

  // Real catalogues from ClickHouse — skeleton until the first load resolves.
  if (!evData || !propData) {
    return (
      <div className="anl-ev" style={{ marginTop: "var(--sp-16)" }}>
        <SkTable rows={10} />
      </div>
    );
  }

  return (
    <div className="anl-ev">
      {/* ---- subject header: the catalogue framed by its volume (the "what");
              Events/Properties + Search recede to the right (the "how") ---- */}
      <header className="anl-ev-head">
        <div className="anl-ev-subject">
          <h2 className="anl-ev-h-t">{tab === "events" ? "Events" : "Properties"}</h2>
          <div className="anl-ev-h-sub">
            {tab === "events" ? (
              <>
                <b className="anl-ev-h-n">{catEvents.length}</b> events
                <span className="anl-ev-h-dot">·</span>
                <b className="anl-ev-h-vol">{fmtK(totalEventVol)}</b> occurrences captured
                <span className="anl-ev-h-dot">·</span>{range.toLowerCase()}
                <span className="anl-ev-h-dot">·</span>busiest{" "}
                <button className="anl-ev-h-hi" onClick={() => setSel(busiest)} title={`Open ${busiest.name}`}>
                  {busiest.name}
                </button>{" "}
                <span className="anl-ev-h-hin">({volShare(busiest.volume, totalEventVol)})</span>
              </>
            ) : (
              <>
                <b className="anl-ev-h-n">{catProps.length}</b> properties
                <span className="anl-ev-h-dot">·</span>seen across{" "}
                <b className="anl-ev-h-vol">{propEventSpan}</b> events
                <span className="anl-ev-h-dot">·</span>{range.toLowerCase()}
                <span className="anl-ev-h-dot">·</span>busiest{" "}
                <button className="anl-ev-h-hi" onClick={() => setSel(busiest)} title={`Open ${busiest.name}`}>
                  {busiest.name}
                </button>{" "}
                <span className="anl-ev-h-hin">({fmtK(busiest.volume)})</span>
              </>
            )}
          </div>
        </div>
        <div className="anl-ev-controls">
          <Seg value={tab} onChange={(v) => { setTab(v as Tab); setSel(null); }} options={[
            { value: "events", label: "Events" },
            { value: "properties", label: "Properties" },
          ]} />
          <Search value={q} onChange={setQ} placeholder={`Search ${nounP}…`} width={240} />
        </div>
      </header>

      {ql && (
        <div className="anl-ev-filternote">
          {count > 0
            ? <><b>{fmtK(count)}</b> of {total} {nounP} match “{q}”</>
            : <>No {nounP} match “{q}”</>}
        </div>
      )}

      {/* ---- detailed data: flat full-width grouped table; VOLUME is the emphasis ---- */}
      <table className="anl-ev-tbl">
        <thead>
          <tr>
            <th><span className="anl-ev-th"><Icon name={tab === "events" ? "bolt" : "hash"} size={13} />{tab === "events" ? "Event" : "Property"}</span></th>
            <th style={{ width: 128 }}>Type</th>
            <th style={{ width: 148 }} className="num">30-day volume</th>
            <th style={{ width: 116 }}>Trend</th>
            <th style={{ width: 150 }}>{tab === "events" ? "Seen on" : "On events"}</th>
            <th style={{ width: 116 }}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {auto.length > 0 && <GroupRow label="Autocaptured" hint="Captured automatically — no code required" />}
          {/* Key on (key,name,index): a workspace can surface the same event key
              under more than one display name (e.g. two $console variants), so the
              key alone isn't unique — the suffix keeps React keys collision-free. */}
          {tab === "events"
            ? (auto as EvEvent[]).map((e, i) => <EvRow key={`${e.key}|${e.name}|${i}`} e={e} onOpen={() => setSel(e)} total={totalEventVol} />)
            : (auto as EvProp[]).map((p, i) => <PropRow key={`${p.key}|${p.name}|${i}`} p={p} onOpen={() => setSel(p)} total={totalEventVol} />)}
          {custom.length > 0 && <GroupRow label="Custom" hint="Sent from your code via replay.track()" />}
          {tab === "events"
            ? (custom as EvEvent[]).map((e, i) => <EvRow key={`${e.key}|${e.name}|${i}`} e={e} onOpen={() => setSel(e)} total={totalEventVol} />)
            : (custom as EvProp[]).map((p, i) => <PropRow key={`${p.key}|${p.name}|${i}`} p={p} onOpen={() => setSel(p)} total={totalEventVol} />)}
          {count === 0 && (
            <tr><td colSpan={6}><div className="anl-ev-empty"><Icon name="search" size={18} /><p>No {nounP} match “{q}”.</p></div></td></tr>
          )}
        </tbody>
      </table>

      {sel && <EvDrawer item={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function GroupRow({ label, hint }: { label: string; hint: string }) {
  return (
    <tr className="anl-ev-grp"><td colSpan={6}>
      <span className="anl-ev-grp-l">{label}</span>
      <span className="anl-ev-grp-h">{hint}</span>
    </td></tr>
  );
}

/** The 30-day volume cell — the SUBJECT of the row: the count in heavy mono,
    with its share of captured volume trailing quietly beneath it. */
function VolCell({ v, total }: { v: number; total: number }) {
  return (
    <td className="num">
      <span className="anl-ev-vol">
        <span className="anl-ev-vol-n">{fmtK(v)}</span>
        <span className="anl-ev-vol-share" title="Share of captured volume">{volShare(v, total)}</span>
      </span>
    </td>
  );
}

function EvRow({ e, onOpen, total }: { e: EvEvent; onOpen: () => void; total: number }) {
  return (
    <tr className="clickable" onClick={onOpen}>
      <td><div className="anl-ev-name"><span className="anl-ev-key">{e.key}</span><span className="anl-ev-fn">{e.name}</span></div></td>
      <td><span className={kindClass(e.kind)}>{kindLabel(e.kind)}</span></td>
      <VolCell v={e.volume} total={total} />
      <td className="anl-ev-trend"><MiniSpark data={e.trend} color={ANL_COLORS[0]} w={84} h={22} /></td>
      <td className="anl-ev-sub">{e.seenPct}% of sessions</td>
      <td className="anl-ev-sub">{fmtAgo(e.minutesAgo)}</td>
    </tr>
  );
}

function PropRow({ p, onOpen, total }: { p: EvProp; onOpen: () => void; total: number }) {
  return (
    <tr className="clickable" onClick={onOpen}>
      <td><div className="anl-ev-name"><span className="anl-ev-key">{p.key}</span><span className="anl-ev-fn">{p.name}</span></div></td>
      <td><span className="anl-ev-type">{typeLabel(p.type)}</span></td>
      <VolCell v={p.volume} total={total} />
      <td />
      <td className="anl-ev-sub">{fmtK(p.eventCount)} events</td>
      <td className="anl-ev-sub">{fmtAgo(p.minutesAgo)}</td>
    </tr>
  );
}

/* Drawer helpers — the app's investigation-slide-over vocabulary (see CrashDrawer). */
function DStat({ l, v, sub, small }: { l: string; v: ReactNode; sub?: ReactNode; small?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{l}</div>
      <div className="stat-v" style={small ? { fontSize: "var(--text-md)", letterSpacing: 0 } : undefined}>{v}</div>
      {sub != null && <div className="anl-ev-dgrow">{sub}</div>}
    </div>
  );
}
function DSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="crd-sec">
      <div className="crd-sec-h"><span>{title}</span></div>
      {children}
    </div>
  );
}

function EvDrawer({ item, onClose }: { item: EvEvent | EvProp; onClose: () => void }) {
  const ev = isEvent(item);
  const s = isEvent(item) ? item.trend : [];
  const delta = sparkDelta(s);
  const up = delta >= 0;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);

  return createPortal(
    <div className="crd-scrim" onClick={onClose}>
      <aside className="crd anl-ev-crd" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={ev ? "Event detail" : "Property detail"}>
        <div className="crd-top">
          <span>{ev ? "Event" : "Property"}</span>
          <span className="crd-dot" />
          <span className="mono">{item.key}</span>
          <span className="sp" style={{ flex: 1 }} />
          <button className="ibtn" aria-label="Close" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>

        <header className="crd-head">
          <div className="co-ic"><Icon name={ev ? "bolt" : "hash"} size={14} /></div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="crd-title">{item.name}</div>
            <div className="crd-sub" style={{ whiteSpace: "normal" }}>{item.desc}</div>
          </div>
        </header>

        <div className="crd-metabar">
          {ev ? <span className={kindClass(item.kind)}>{kindLabel(item.kind)}</span> : <span className="anl-ev-type">{typeLabel(item.type)}</span>}
          <span className="cond"><span className="mono">{item.key}</span></span>
        </div>

        <div className="crd-body">
          <div className="stats crd-stats">
            <DStat l="30-day volume" v={fmtK(item.volume)} sub={
              <span className={"anl-ev-ddelta " + (up ? "up" : "down")}><Icon name={up ? "trendUp" : "trendDown"} size={11} /> {up ? "+" : ""}{delta.toFixed(0)}% vs prev</span>
            } />
            <DStat l={ev ? "Seen on" : "On events"} v={ev ? item.seenPct + "%" : fmtK(item.eventCount)} sub={ev ? "of sessions" : "distinct events"} />
            <DStat l="Last seen" v={fmtAgo(item.minutesAgo)} small />
          </div>

          <DSection title="Volume · 30 days">
            <div className="anl-ev-dspark"><MiniSpark data={s} color={ANL_COLORS[0]} w={490} h={48} /></div>
          </DSection>

          {ev ? (
            <DSection title="Top properties">
              {item.topProps.map((tp) => (
                <div className="anl-ev-prop" key={tp.name}>
                  <span className="anl-ev-pk mono">{tp.name}</span>
                  <span className="anl-ev-pvals">{tp.values.map((v) => <span className="anl-ev-chip" key={v}>{v}</span>)}</span>
                </div>
              ))}
            </DSection>
          ) : (
            <DSection title="Top values">
              {item.valueShares.map((tv) => (
                <div className="anl-ev-val" key={tv.label}>
                  <span className="anl-ev-vl">{tv.label}</span>
                  <span className="anl-ev-vbar"><span className="anl-ev-vfill" style={{ width: tv.pct * 100 + "%" }} /></span>
                  <span className="anl-ev-vp">{(tv.pct * 100).toFixed(0)}%</span>
                </div>
              ))}
            </DSection>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
