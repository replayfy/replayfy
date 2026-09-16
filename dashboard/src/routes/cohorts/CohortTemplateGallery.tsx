import { useMemo, useState } from "react";
import { Icon } from "@/components/primitives";
import {
  CO_TEMPLATES,
  CO_TEMPLATE_CATEGORIES,
  type CohortTemplate,
} from "./cohort-templates.data";

type Props = {
  onScratch: () => void;
  onPick: (id: string) => void;
  onBack: () => void;
};

/* The "create a cohort" gallery — start from scratch, or pick a ready-made
   audience. Mirrors the funnel template gallery (FunnelTemplateGallery) and
   reuses the same frozen .fnt-* CSS classes verbatim: a search bar, a prominent
   scratch hero, then categorised template cards with a topic icon + one-line
   description. */
export function CohortTemplateGallery({ onScratch, onPick, onBack }: Props) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      !needle
        ? CO_TEMPLATES
        : CO_TEMPLATES.filter(
            (t) =>
              t.name.toLowerCase().includes(needle) ||
              t.tagline.toLowerCase().includes(needle) ||
              t.category.toLowerCase().includes(needle),
          ),
    [needle],
  );

  return (
    <div className="wrap rd-page">
      <div className="head" style={{ marginBottom: "var(--sp-18)" }}>
        <div className="head-l">
          <button
            onClick={onBack}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--sp-6)",
              background: "none",
              border: "none",
              color: "var(--t2)",
              fontSize: "var(--text-sm)",
              fontWeight: "var(--fw-medium)",
              cursor: "pointer",
              padding: "var(--sp-2) 0",
              marginBottom: "var(--sp-6)",
            }}
          >
            <Icon name="chev" size={12} style={{ transform: "rotate(90deg)" }} />{" "}
            Cohorts
          </button>
          <h1>Create a cohort</h1>
          <div className="sub">
            Start from scratch, or pick a template to prefill the rules.
          </div>
        </div>
      </div>

      <div className="fnt">
        <div className="fnt-search">
          <Icon name="search" size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search templates…"
            aria-label="Search cohort templates"
          />
          {q && (
            <button
              className="fnt-search-x"
              onClick={() => setQ("")}
              aria-label="Clear"
            >
              <Icon name="x" size={13} />
            </button>
          )}
        </div>

        {/* Start from scratch — the featured, blank path (hidden while searching). */}
        {!needle && (
          <button className="fnt-hero" onClick={onScratch}>
            <span className="fnt-hero-l">
              <span className="fnt-hero-top">
                <span className="fnt-logo lg">
                  <Icon name="plus" size={22} />
                </span>
                <span className="tag info" style={{ fontSize: "var(--text-2xs)" }}>
                  Blank
                </span>
              </span>
              <span className="fnt-hero-t">Start from scratch</span>
              <span className="fnt-hero-d">
                Build an audience rule by rule — choose your own conditions on
                behaviour, plan, device, and more.
              </span>
              <span className="btn primary sm fnt-hero-cta">
                <Icon name="plus" size={12} /> New blank cohort
              </span>
            </span>
            <span className="fnt-hero-art" aria-hidden>
              <img
                src="/illustrations/cohorts-hero.svg"
                alt=""
                style={{ width: "100%", maxWidth: 360, height: "auto", display: "block" }}
              />
            </span>
          </button>
        )}

        {CO_TEMPLATE_CATEGORIES.map((cat) => {
          const inCat = filtered.filter((t) => t.category === cat);
          if (!inCat.length) return null;
          return (
            <section className="fnt-group" key={cat}>
              <div className="fnt-group-h">{cat}</div>
              <div className="fnt-grid">
                {inCat.map((t) => (
                  <CoTemplateCard
                    key={t.id}
                    tpl={t}
                    onOpen={() => onPick(t.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}

        {filtered.length === 0 && (
          <div className="fnt-empty">
            <Icon name="search" size={15} /> No templates match “{q}”.
          </div>
        )}
      </div>
    </div>
  );
}

function CoTemplateCard({
  tpl,
  onOpen,
}: {
  tpl: CohortTemplate;
  onOpen: () => void;
}) {
  return (
    <button
      className="fnt-card"
      onClick={onOpen}
      aria-label={`${tpl.name} — ${tpl.tagline}`}
    >
      <span className="fnt-logo">
        <Icon name={tpl.icon} size={19} />
      </span>
      <span className="fnt-card-b">
        <span className="fnt-card-t">
          {tpl.name}
          <span
            className="tag"
            style={{ marginLeft: "auto", fontSize: "var(--text-2xs)", whiteSpace: "nowrap", flexShrink: 0 }}
          >
            {tpl.rules.length === 1 ? "1 rule" : `${tpl.rules.length} rules`}
          </span>
        </span>
        <span className="fnt-card-d">{tpl.tagline}</span>
      </span>
      <Icon name="arrowR" size={13} className="fnt-card-go" />
    </button>
  );
}
