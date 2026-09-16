import {
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Icon } from "@/components/primitives";
import { useEscapeKey, useOutsideClick } from "@/hooks";

/* ============================================================================
   CountryFilter — a searchable country lens for the activity chart. Every
   ISO 3166 region, named via Intl.DisplayNames, flagged via regional
   indicators; type to filter. Hover rides the app's continuity highlight.
   ========================================================================== */

const ISO =
  "AD AE AF AG AI AL AM AO AR AS AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS YE ZA ZM ZW".split(
    " ",
  );

const flagOf = (code: string) =>
  code.replace(/./g, (ch) =>
    String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65),
  );

export type CountryOption = { code: string; label: string; flag: string };

const NAMES = new Intl.DisplayNames(["en"], { type: "region" });
export const ALL_COUNTRIES: CountryOption[] = ISO.map((code) => ({
  code,
  label: NAMES.of(code) || code,
  flag: flagOf(code),
})).sort((a, b) => a.label.localeCompare(b.label));

export function countryLabel(code: string): string {
  return code === "all" ? "All countries" : NAMES.of(code) || code;
}

type CountryFilterProps = { value: string; onChange: (code: string) => void };

export function CountryFilter({ value, onChange }: CountryFilterProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);
  const close = () => {
    setOpen(false);
    setQ("");
    setHl(null);
  };
  useOutsideClick(wrap, close, open);
  useEscapeKey(close, open);

  const onEnterRow = (e: ReactMouseEvent<HTMLElement>) => {
    const w = list.current;
    if (!w) return;
    const wr = w.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    setHl({ top: r.top - wr.top + w.scrollTop, height: r.height });
  };

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return ALL_COUNTRIES;
    return ALL_COUNTRIES.filter(
      (c) =>
        c.label.toLowerCase().includes(needle) ||
        c.code.toLowerCase() === needle,
    );
  }, [q]);

  const cur =
    value === "all" ? null : ALL_COUNTRIES.find((c) => c.code === value);

  return (
    <div className="ox-ddwrap" ref={wrap}>
      <button
        className="sel-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) return close();
          setOpen(true);
          requestAnimationFrame(() => inp.current?.focus());
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--sp-6)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {cur ? (
            <>
              {cur.flag} {cur.label}
            </>
          ) : (
            <>
              <Icon name="globe" size={12} /> All countries
            </>
          )}
        </span>
        <Icon name="chev" size={11} />
      </button>
      {open && (
        <div
          className="ox-dd ox-cs"
          role="listbox"
          aria-label="Filter by country"
        >
          <div className="ox-cs-search">
            <Icon name="search" size={12} />
            <input
              ref={inp}
              placeholder="Search countries…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div
            className="ox-cs-list"
            ref={list}
            onMouseLeave={() => setHl(null)}
          >
            <span
              className={"ox-dd-hl" + (hl ? " on" : "")}
              style={
                hl
                  ? { transform: `translateY(${hl.top}px)`, height: hl.height }
                  : { height: 0 }
              }
              aria-hidden="true"
            />
            <button
              className={"ox-dd-opt" + (value === "all" ? " on" : "")}
              role="option"
              aria-selected={value === "all"}
              onMouseEnter={onEnterRow}
              onClick={() => {
                onChange("all");
                close();
              }}
            >
              <span className="l">
                <span
                  className="flag"
                  style={{
                    display: "inline-flex",
                    justifyContent: "center",
                    color: "var(--t3)",
                  }}
                >
                  <Icon name="globe" size={13} />
                </span>
                All countries
              </span>
              {value === "all" && <span className="dot" />}
            </button>
            {results.map((c) => (
              <button
                key={c.code}
                className={"ox-dd-opt" + (value === c.code ? " on" : "")}
                role="option"
                aria-selected={value === c.code}
                onMouseEnter={onEnterRow}
                onClick={() => {
                  onChange(c.code);
                  close();
                }}
              >
                <span className="l">
                  <span className="flag">{c.flag}</span>
                  {c.label}
                </span>
                {value === c.code && <span className="dot" />}
              </button>
            ))}
            {!results.length && (
              <div className="ox-cs-none">No countries match “{q}”</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
