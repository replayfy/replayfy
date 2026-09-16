import { useMemo, useState } from "react";
import { Icon } from "@/components/primitives";
import {
  FN_TEMPLATES,
  FN_TEMPLATE_CATEGORIES,
  loadUserFunnelTemplates,
  type FunnelTemplate,
} from "./funnel-templates.data";

type Props = {
  onScratch: () => void;
  onPick: (id: string) => void;
  onBack: () => void;
};

/* The "create a funnel" gallery — start from scratch, or pick a ready-made
   conversion journey. Mirrors the Integrations catalog design (cloned .fnt-*
   classes): a search bar, a prominent scratch hero, then categorised template
   cards with a topic icon + one-line description. */
export function FunnelTemplateGallery({ onScratch, onPick, onBack }: Props) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  // Built-in templates + the user's own saved-as-template funnels (localStorage).
  const all = useMemo(() => [...loadUserFunnelTemplates(), ...FN_TEMPLATES], []);
  const filtered = useMemo(
    () =>
      !needle
        ? all
        : all.filter(
            (t) =>
              t.name.toLowerCase().includes(needle) ||
              t.tagline.toLowerCase().includes(needle) ||
              t.category.toLowerCase().includes(needle),
          ),
    [needle, all],
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
            Funnels
          </button>
          <h1>Create a funnel</h1>
          <div className="sub">
            Start from scratch, or pick a template to prefill the steps.
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
            aria-label="Search funnel templates"
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
                Build a funnel step by step — choose your own pages, events, and
                conversion window.
              </span>
              <span className="btn primary sm fnt-hero-cta">
                <Icon name="plus" size={12} /> New blank funnel
              </span>
            </span>
            <span className="fnt-hero-art" aria-hidden>
              <img
                src="/illustrations/funnels-hero.svg"
                alt=""
                style={{ width: "100%", maxWidth: 360, height: "auto", display: "block" }}
              />
            </span>
          </button>
        )}

        {FN_TEMPLATE_CATEGORIES.map((cat) => {
          const inCat = filtered.filter((t) => t.category === cat);
          if (!inCat.length) return null;
          return (
            <section className="fnt-group" key={cat}>
              <div className="fnt-group-h">{cat}</div>
              <div className="fnt-grid">
                {inCat.map((t) => (
                  <FnTemplateCard
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

function FnTemplateCard({
  tpl,
  onOpen,
}: {
  tpl: FunnelTemplate;
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
            {tpl.steps.length} steps
          </span>
        </span>
        <span className="fnt-card-d">{tpl.tagline}</span>
      </span>
      <Icon name="arrowR" size={13} className="fnt-card-go" />
    </button>
  );
}
