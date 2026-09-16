import { useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { Icon } from "./Icon";
import { Popover } from "./Popover";
import { resolveDateRange } from "@/lib/date-ranges";

type DatePickerProps = {
  value?: string;
  onChange?: (v: string) => void;
  align?: "left" | "right";
  icon?: string;
  /** Preset labels to offer. Defaults to the classic rolling windows; callers
   *  (e.g. funnels) can pass the richer FN_DATE_PRESETS. Any label the shared
   *  resolveDateRange() understands highlights correctly on the calendar.
   *  Accepts a readonly tuple (e.g. an `as const` array). */
  presets?: readonly string[];
  /** When false the calendar is read-only — presets only. Callers whose backend
   *  accepts only named rolling windows (Overview, User detail) pass this so a
   *  hand-painted custom range can't silently fall back to a default window. */
  allowCustom?: boolean;
  /** When `onCompareChange` is provided, a "Compare to previous period" toggle
   *  renders at the top of the popover (funnels). Omit ⇒ no compare row, so the
   *  other call sites (Overview / User detail) are untouched. The toggle applies
   *  immediately — the date range still commits via Apply/Cancel. */
  compare?: boolean;
  onCompareChange?: (v: boolean) => void;
  /** Greys out the compare toggle where a comparison isn't meaningful (e.g. the
   *  funnel Breakdown view) and shows this hint on hover. */
  compareDisabled?: boolean;
  compareDisabledHint?: string;
  compareLabel?: string;
};

const MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DEFAULT_PRESETS = ['Today','Yesterday','Last 7 days','Last 14 days','Last 30 days','Last 3 months','Last 12 months'];

/* Map react-day-picker's internal parts to OUR class names, so the calendar is
   themed entirely by public/styles/pages.css (.dp-*) — we never import the rdp
   stylesheet. This keeps our own look owning every pixel and confines any
   library-upgrade churn to these keys (the SelectionState/DayFlag/UI names).
   `nav` is force-hidden: we render our own prev/next in the .dp-cal-top bar. */
const RDP_CLASSNAMES = {
  months: "dp-months",
  month: "dp-month",
  month_caption: "dp-mcap",
  caption_label: "dp-mcap-l",
  month_grid: "dp-grid",
  weekdays: "dp-dow-row",
  weekday: "dp-dow",
  week: "dp-week",
  day: "dp-cell",
  day_button: "dp-d",
  range_start: "is-start",
  range_middle: "is-mid",
  range_end: "is-end",
  selected: "is-sel",
  today: "is-today",
  outside: "is-outside",
  disabled: "is-disabled",
  hidden: "is-hidden",
  nav: "dp-rdp-nav",
};

/** Single-letter weekday header (S M T W T F S) to match the original design. */
const weekdayLetter = (d: Date): string => ['S','M','T','W','T','F','S'][d.getDay()];

/* ---------- DatePicker — presets rail + react-day-picker range calendar ----------
   The calendar engine is react-day-picker (mode="range", two months); we own
   the shell (Popover), the presets side rail, the footer, and all styling. The
   preset labels resolve through the SHARED resolveDateRange() so the highlighted
   band and the window the backend queries can never drift. onChange still emits
   either a preset label or an ad-hoc "Mon D → Mon D" custom range, exactly as
   the three call sites (funnels / overview / user detail) expect. */
export function DatePicker({ value = 'Last 30 days', onChange, align = 'right', icon = 'cal', presets, allowCustom = true, compare = false, onCompareChange, compareDisabled = false, compareDisabledHint, compareLabel = 'Compare to previous period' }: DatePickerProps) {
  const PRESETS = presets ?? DEFAULT_PRESETS;

  // Resolve a preset label to a concrete inclusive {from,to}, falling back to
  // last-30-days for any label this resolver doesn't own (keeps the highlight
  // sane even for a caller's bespoke label).
  const rangeFor = (label: string): DateRange => {
    const r = resolveDateRange(label);
    if (r) return { from: r.start, to: r.end };
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 29);
    return { from, to };
  };

  const initResolved = resolveDateRange(value);
  // Active preset label, or null once the user paints a custom range on the grid.
  const [activePreset, setActivePreset] = useState<string | null>(initResolved ? value : null);
  const [range, setRange] = useState<DateRange | undefined>(
    initResolved ? { from: initResolved.start, to: initResolved.end } : undefined,
  );
  const [display, setDisplay] = useState(value);
  // Controlled left-most visible month; opens on the selection's start so a
  // fixed period (Q1 / H1) is visible immediately.
  const [month, setMonth] = useState<Date>(() => {
    const base = initResolved ? initResolved.start : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const fmt = (d: Date) => `${MON[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  // Emitted custom-range string. Include the year ONLY when an endpoint isn't the
  // current year, so an in-year pick stays a short chip ("Jul 10 → Jul 15") while a
  // prior-year or New-Year-crossing pick is unambiguous ("Nov 3, 2025 → Nov 20,
  // 2025") — the year-less form silently collapsed those to the current year.
  const emitCustom = (a: Date, b: Date): string => {
    const cur = new Date().getFullYear();
    const f = a.getFullYear() === cur && b.getFullYear() === cur ? fmt : (d: Date) => `${fmt(d)}, ${d.getFullYear()}`;
    return `${f(a)} → ${f(b)}`;
  };
  const shiftMonth = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));

  const choosePreset = (label: string) => {
    const r = rangeFor(label);
    setActivePreset(label);
    setRange(r);
    if (r.from) setMonth(new Date(r.from.getFullYear(), r.from.getMonth(), 1));
  };

  const resetToValue = () => {
    const r = resolveDateRange(value);
    setActivePreset(r ? value : null);
    setRange(r ? { from: r.start, to: r.end } : undefined);
  };

  const from = range?.from;
  const to = range?.to ?? range?.from;
  const picking = !!range?.from && !range?.to; // custom selection mid-flight (start chosen, awaiting end)

  return (
    <Popover align={align}
      trigger={<button className="dp-trigger"><Icon name={icon} size={13} />{display}<Icon name="chev" size={11} /></button>}>
      {({ close }) => (
        <div className="dp-pop" onClick={(e) => e.stopPropagation()}>
          {onCompareChange && (
            <button
              type="button"
              className={`dp-compare ${compare ? 'on' : ''}`}
              disabled={compareDisabled}
              title={compareDisabled ? compareDisabledHint : undefined}
              onClick={() => onCompareChange(!compare)}
            >
              <span className="dp-compare-box"><Icon name="check" size={11} /></span>
              {compareLabel}
            </button>
          )}
          <div className="dp-body">
            <div className="dp-presets">
              {PRESETS.map((p) => (
                <button key={p} className={`dp-preset ${activePreset === p ? 'on' : ''}`} onClick={() => choosePreset(p)}>{p}</button>
              ))}
            </div>
            <div className={allowCustom ? 'dp-cal' : 'dp-cal dp-cal-locked'}>
              <div className="dp-cal-top">
                <span className="dp-resolved">
                  {from ? fmt(from) : '—'} <span className="dp-dash">→</span> {picking ? 'pick end' : to ? fmt(to) : '—'}
                </span>
                <span className="dp-nav">
                  <button onClick={() => shiftMonth(-1)} aria-label="Previous month"><Icon name="chev" size={13} style={{ transform: 'rotate(90deg)' }} /></button>
                  <button onClick={() => shiftMonth(1)} aria-label="Next month"><Icon name="chev" size={13} style={{ transform: 'rotate(-90deg)' }} /></button>
                </span>
              </div>
              <DayPicker
                mode="range"
                numberOfMonths={2}
                month={month}
                onMonthChange={setMonth}
                selected={range}
                onSelect={(next) => { if (!allowCustom) return; setRange(next); setActivePreset(null); }}
                disabled={{ after: new Date() }}
                showOutsideDays={false}
                weekStartsOn={0}
                hideNavigation
                formatters={{ formatWeekdayName: weekdayLetter }}
                classNames={RDP_CLASSNAMES}
              />
            </div>
          </div>
          <div className="dp-foot">
            <button className="dp-cancel" onClick={() => { resetToValue(); close(); }}>Cancel</button>
            <button className="btn primary dp-apply" onClick={() => {
              const out = activePreset ?? (range?.from && range?.to ? emitCustom(range.from, range.to) : value);
              setDisplay(out);
              onChange && onChange(out);
              close();
            }}>Apply range</button>
          </div>
        </div>
      )}
    </Popover>
  );
}
