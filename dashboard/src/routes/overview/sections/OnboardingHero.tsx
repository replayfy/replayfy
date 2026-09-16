import type { OnbStepKey } from "../onboarding.store";

/* ============================================================================
   OnboardingHero — the animated "power up your workspace" band above the
   first-run checklist.

   One energy circuit runs left → right: cable → plug → SDK node → session
   stream → first users → live monitor. The energised extent is COUNT-driven
   (`p0…p5` on the root — the charge front always advances coherently), while
   each scene element lights up when ITS step completes (`s-sdk`, `s-funnel`,
   `s-cohort`, `s-team`, `s-integration` — steps can finish in any order).
   `fired`/`fired-<step>` is a ~1.4s transient the checklist toggles when a
   step has JUST completed: surge pulse down the wire, cat hop, ear perk.

   All motion is CSS on named groups (transform/opacity/dash only — no SVG
   filters, no JS timers in here) and every loop dies under
   prefers-reduced-motion. Art source: Documents/Replayfy Illustrations/
   onboarding-band.svg — keep geometry changes in sync with that master.
   ========================================================================== */

type Props = {
  /** Completed-step count 0–5 — drives how far the energy front reaches. */
  power: number;
  /** Per-step completion — drives which scene elements are lit. */
  steps: Record<OnbStepKey, boolean>;
  /** Step that just completed (transient) — plays the one-shot celebration. */
  fired: OnbStepKey | null;
};

const CSS = `
.onbb-root{display:block;width:100%;height:auto}
.onbb-root *{transform-box:fill-box}

/* ── wire: charge front + perpetual spark ──────────────────────────────── */
.onbb-root .cable-charge{stroke-dasharray:0 200;transition:stroke-dasharray .8s cubic-bezier(.22,1,.36,1)}
.onbb-root.s-sdk .cable-charge{stroke-dasharray:200 200}
.onbb-root .cable-spark{opacity:0}
.onbb-root.s-sdk .cable-spark{opacity:1;animation:onbb-spark 2.6s linear infinite}
.onbb-root .cable-surge{opacity:0}
.onbb-root.fired .cable-surge{animation:onbb-surge .9s cubic-bezier(.3,0,.2,1) 1}
.onbb-root .plug{fill:#B9C4DC;transform:translateX(-4px);transition:transform .45s cubic-bezier(.34,1.56,.64,1),fill .3s}
.onbb-root.s-sdk .plug{fill:url(#onbb-accent);transform:none}
.onbb-root.fired-sdk .plug{animation:onbb-flash .5s linear 1}

/* ── SDK node ──────────────────────────────────────────────────────────── */
.onbb-root .chev{stroke:#C9D3E6;transition:stroke .4s}
.onbb-root.s-sdk .chev{stroke:url(#onbb-accent)}
.onbb-root.fired-sdk .chev{animation:onbb-flash .55s linear 1}
.onbb-root .node-sparks{opacity:0;transition:opacity .4s}
.onbb-root.s-sdk .node-sparks{opacity:.85;animation:onbb-twinkle 3.4s ease-in-out infinite}

/* ── session stream: dotted guide → energised conduit ──────────────────── */
.onbb-root .stream-base{stroke:#C9D3E6;opacity:.6;transition:stroke .5s,opacity .5s}
.onbb-root.s-funnel .stream-base{stroke:#93B1F2;opacity:.75}
.onbb-root .stream-charge{stroke-dasharray:0 200;opacity:.65;transition:stroke-dasharray .8s cubic-bezier(.22,1,.36,1)}
.onbb-root.p2 .stream-charge{stroke-dasharray:80 200}
.onbb-root.p3 .stream-charge{stroke-dasharray:120 200}
.onbb-root.p4 .stream-charge{stroke-dasharray:160 200}
.onbb-root.p5 .stream-charge{stroke-dasharray:200 200}
.onbb-root .stream-spark{opacity:0}
.onbb-root.p2 .stream-spark{opacity:1;animation:onbb-sspark2 2.8s linear infinite}
.onbb-root.p3 .stream-spark{opacity:1;animation:onbb-sspark3 2.8s linear infinite}
.onbb-root.p4 .stream-spark{opacity:1;animation:onbb-sspark4 2.8s linear infinite}
.onbb-root.p5 .stream-spark{opacity:1;animation:onbb-sspark5 2.8s linear infinite}

/* ── travellers (session dots) ─────────────────────────────────────────── */
.onbb-root .travellers{opacity:.16;transition:opacity .6s}
.onbb-root.s-funnel .travellers{opacity:1}
.onbb-root.s-funnel .travellers circle{animation:onbb-dotflow 3.6s linear infinite}
.onbb-root.s-funnel .travellers circle:nth-child(2){animation-delay:-.51s}
.onbb-root.s-funnel .travellers circle:nth-child(3){animation-delay:-1.03s}
.onbb-root.s-funnel .travellers circle:nth-child(4){animation-delay:-1.54s}
.onbb-root.s-funnel .travellers circle:nth-child(5){animation-delay:-2.06s}
.onbb-root.s-funnel .travellers circle:nth-child(6){animation-delay:-2.57s}
.onbb-root.s-funnel .travellers circle:nth-child(7){animation-delay:-3.09s}

/* ── first users ───────────────────────────────────────────────────────── */
.onbb-root .pop{transform:scale(0);transform-origin:50% 50%}
.onbb-root.s-cohort .pop1{transform:scale(1);animation:onbb-pop .55s cubic-bezier(.34,1.56,.64,1) both}
.onbb-root.s-team .pop2{transform:scale(1);animation:onbb-pop .55s cubic-bezier(.34,1.56,.64,1) both}
.onbb-root .bob1{animation:onbb-bob 5.2s ease-in-out infinite}
.onbb-root .bob2{animation:onbb-bob 6s ease-in-out -1.5s infinite}

/* ── live monitor ──────────────────────────────────────────────────────── */
.onbb-root .pulse-flat{transition:opacity .5s}
.onbb-root .pulse-beat,.onbb-root .pulse-sweep{opacity:0;transition:opacity .5s}
.onbb-root.s-integration .pulse-flat{opacity:0}
.onbb-root.s-integration .pulse-beat{opacity:1}
.onbb-root.s-integration .pulse-sweep{opacity:1;animation:onbb-spark 3s linear infinite}
.onbb-root .live-dot{fill:#C3CBDC;transition:fill .4s}
.onbb-root.s-integration .live-dot{fill:#3FBF89}
.onbb-root .live-ring{opacity:0;transform-origin:50% 50%}
.onbb-root.s-integration .live-ring{animation:onbb-ping 2.4s cubic-bezier(.2,.6,.4,1) infinite}

/* ── the cat ───────────────────────────────────────────────────────────── */
.onbb-root .cat-breath{animation:onbb-breath 3.8s ease-in-out infinite;transform-origin:50% 100%}
.onbb-root .tail-anim{animation:onbb-sway 4.6s ease-in-out infinite;transform-origin:92% 55%}
.onbb-root .eyes{animation:onbb-blink 5.4s linear infinite;transform-origin:50% 50%}
.onbb-root.fired .cat-hop{animation:onbb-hop .95s cubic-bezier(.34,1.2,.5,1) 1;transform-origin:50% 100%}
.onbb-root.fired-sdk .cat-pose{animation:onbb-lean 1.15s cubic-bezier(.4,0,.2,1) 1;transform-origin:50% 100%}
.onbb-root.fired .ear-l{animation:onbb-perk-l .95s ease-out 1;transform-origin:50% 85%}
.onbb-root.fired .ear-r{animation:onbb-perk-r .95s ease-out 1;transform-origin:50% 85%}
.onbb-root .face-gaze{transition:transform .5s cubic-bezier(.22,1,.36,1)}
.onbb-root.p0 .face-gaze{transform:translate(-5px,4px)}
.onbb-root.p1 .face-gaze{transform:translate(-3px,2px)}
.onbb-root.p2 .face-gaze{transform:translate(-2px,1px)}
.onbb-root.p3 .face-gaze{transform:translate(-1px,1px)}
.onbb-root.p5 .face-gaze{transform:translate(1px,0)}
.onbb-root .celebrate{opacity:0}
.onbb-root.p5.fired .celebrate{animation:onbb-burst 1.1s ease-out 1}

@keyframes onbb-spark{from{stroke-dashoffset:200}to{stroke-dashoffset:0}}
@keyframes onbb-sspark2{0%{stroke-dashoffset:200;opacity:1}78%{opacity:1}92%{stroke-dashoffset:120;opacity:0}100%{stroke-dashoffset:120;opacity:0}}
@keyframes onbb-sspark3{0%{stroke-dashoffset:200;opacity:1}82%{opacity:1}94%{stroke-dashoffset:80;opacity:0}100%{stroke-dashoffset:80;opacity:0}}
@keyframes onbb-sspark4{0%{stroke-dashoffset:200;opacity:1}86%{opacity:1}96%{stroke-dashoffset:40;opacity:0}100%{stroke-dashoffset:40;opacity:0}}
@keyframes onbb-sspark5{from{stroke-dashoffset:200}to{stroke-dashoffset:0}}
@keyframes onbb-surge{0%{stroke-dashoffset:222;opacity:0}12%{opacity:1}88%{opacity:1}100%{stroke-dashoffset:22;opacity:0}}
@keyframes onbb-flash{0%,100%{opacity:1}25%{opacity:.25}50%{opacity:1}75%{opacity:.45}}
@keyframes onbb-twinkle{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes onbb-dotflow{0%{transform:translateX(0);opacity:0}12%{opacity:1}86%{opacity:1}100%{transform:translateX(32px);opacity:0}}
@keyframes onbb-pop{0%{transform:scale(0)}70%{transform:scale(1.14)}100%{transform:scale(1)}}
@keyframes onbb-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes onbb-ping{0%{transform:scale(.5);opacity:.6}75%{transform:scale(1.7);opacity:0}100%{transform:scale(1.7);opacity:0}}
@keyframes onbb-breath{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.015)}}
@keyframes onbb-sway{0%,100%{transform:rotate(0)}50%{transform:rotate(4deg)}}
@keyframes onbb-blink{0%,95.5%,99.5%,100%{transform:scaleY(1)}96.5%,98.5%{transform:scaleY(.08)}}
@keyframes onbb-hop{0%{transform:translateY(0)}26%{transform:translateY(-9px) scale(.99,1.02)}46%{transform:translateY(0) scale(1.05,.94)}64%{transform:translateY(-4px)}80%{transform:translateY(0) scale(1.01,.99)}100%{transform:none}}
@keyframes onbb-lean{0%{transform:none}28%{transform:translateX(5px) rotate(2.5deg)}52%{transform:translateX(5px) rotate(2.5deg)}100%{transform:none}}
@keyframes onbb-perk-l{0%,100%{transform:rotate(0)}30%,70%{transform:rotate(11deg)}}
@keyframes onbb-perk-r{0%,100%{transform:rotate(0)}30%,70%{transform:rotate(-11deg)}}
@keyframes onbb-burst{0%{opacity:0;transform:scale(.5)}30%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.25)}}
@keyframes onbb-listen{0%,100%{opacity:.35}50%{opacity:1}}
.rf-onb-listen{display:inline-block;width:7px;height:7px;border-radius:50%;background:#3FBF89;animation:onbb-listen 1.6s ease-in-out infinite;margin-right:6px;vertical-align:1px}

@media (prefers-reduced-motion: reduce){
  .onbb-root *,.rf-onb-listen{animation:none!important;transition:none!important}
}
`;

export function OnboardingHero({ power, steps, fired }: Props) {
  const cls = [
    "onbb-root",
    `p${Math.max(0, Math.min(5, power))}`,
    steps.sdk && "s-sdk",
    steps.funnel && "s-funnel",
    steps.cohort && "s-cohort",
    steps.team && "s-team",
    steps.integration && "s-integration",
    fired && "fired",
    fired && `fired-${fired}`,
  ]
    .filter(Boolean)
    .join(" ");

  const cable = "M8 192 C 60 188 96 170 128 138 C 140 127 156 123 176 122";
  const stream =
    "M262 122 C 320 112 360 118 420 124 C 470 129 520 130 558 128";
  const beat =
    "M672 128 H 704 L 712 128 L 719 112 L 727 140 L 735 128 H 760";

  return (
    <svg
      className={cls}
      viewBox="0 0 800 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`Workspace powering up — ${power} of 5 setup steps complete`}
    >
      <style>{CSS}</style>
      <defs>
        <radialGradient id="onbb-shadow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#3D4A6B" stopOpacity="0.14" />
          <stop offset="0.65" stopColor="#3D4A6B" stopOpacity="0.06" />
          <stop offset="1" stopColor="#3D4A6B" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="onbb-panel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#F4F6FB" />
        </linearGradient>
        <linearGradient id="onbb-accent" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6D9BFF" />
          <stop offset="1" stopColor="#4066F0" />
        </linearGradient>
        <linearGradient id="onbb-cat-indigo" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7E8BFA" />
          <stop offset="1" stopColor="#5F6CEC" />
        </linearGradient>
        <radialGradient id="onbb-soft-indigo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#EDEFFF" stopOpacity="0.95" />
          <stop offset="0.7" stopColor="#EDEFFF" stopOpacity="0.8" />
          <stop offset="1" stopColor="#EDEFFF" stopOpacity="0" />
        </radialGradient>
        <path
          id="onbb-ear"
          d="M -16 14 Q -20 17 -17.5 10 L -4.5 -14 Q 0 -21 4.5 -14 L 17.5 10 Q 20 17 16 14 Q 0 7 -16 14 Z"
        />
        <g id="onbb-minicat">
          <path
            d="M -9.5 -9 L -4 -15.5 Q -1.6 -18 0 -15.5 L 4.5 -9 Z"
            fill="currentColor"
            transform="translate(-7 -6) rotate(-18)"
          />
          <path
            d="M -4.5 -9 L 0 -15.5 Q 1.6 -18 4 -15.5 L 9.5 -9 Z"
            fill="currentColor"
            transform="translate(7 -6) rotate(18)"
          />
          <path
            d="M-15 1.5 C -15 -8 -8.5 -13.5 0 -13.5 C 8.5 -13.5 15 -8 15 1.5 C 15 9.5 8 14 0 14 C -8 14 -15 9.5 -15 1.5 Z"
            fill="currentColor"
          />
          <ellipse cx="-5.2" cy="-1" rx="2.4" ry="3.1" fill="#262B45" />
          <ellipse cx="5.2" cy="-1" rx="2.4" ry="3.1" fill="#262B45" />
          <circle cx="-4.2" cy="-2.2" r="0.9" fill="#FFFFFF" />
          <circle cx="6.2" cy="-2.2" r="0.9" fill="#FFFFFF" />
          <path
            d="M-1.4 4.6 L 1.4 4.6 Q 2.4 4.8 1.7 5.9 L 0.7 7 Q 0 7.7 -0.7 7 L -1.7 5.9 Q -2.4 4.8 -1.4 4.6 Z"
            fill="#3A3F5F"
          />
        </g>
      </defs>

      <g strokeLinecap="round">
        <circle cx="368" cy="38" r="4.5" stroke="#C8D2ED" strokeWidth="2.5" />
        <path d="M552 38v12M546 44h12" stroke="#D5CBF7" strokeWidth="2.5" />
        <circle cx="40" cy="56" r="3" fill="#D9E2F5" />
        <circle cx="480" cy="176" r="3.5" fill="#CBE8DC" />
      </g>

      {/* wire */}
      <path
        className="cable-base"
        d={cable}
        stroke="#A5B1C7"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <path
        className="cable-charge"
        d={cable}
        pathLength={200}
        stroke="url(#onbb-accent)"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <path
        className="cable-spark"
        d={cable}
        pathLength={200}
        stroke="#FFFFFF"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="14 186"
      />
      <path
        className="cable-surge"
        d={cable}
        pathLength={200}
        stroke="#DCE9FF"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray="22 178"
      />
      <rect
        className="plug"
        x="178"
        y="112"
        width="26"
        height="20"
        rx="5"
        fill="url(#onbb-accent)"
      />

      {/* SDK node */}
      <ellipse cx="228" cy="168" rx="40" ry="6" fill="url(#onbb-shadow)" />
      <rect
        x="196"
        y="90"
        width="64"
        height="64"
        rx="16"
        fill="url(#onbb-panel)"
        stroke="#E3E8F3"
        strokeWidth="1.5"
      />
      <path
        className="chev"
        d="M220 112 l-8 10 8 10"
        stroke="url(#onbb-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="chev"
        d="M236 112 l8 10 -8 10"
        stroke="url(#onbb-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g
        className="node-sparks"
        stroke="#A5AFF7"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <path d="M268 80 l3 -3" />
        <path d="M276 94 h4" />
      </g>

      {/* session stream */}
      <path
        className="stream-base"
        d={stream}
        stroke="#93B1F2"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="1 8"
      />
      <path
        className="stream-charge"
        d={stream}
        pathLength={200}
        stroke="url(#onbb-accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        className="stream-spark"
        d={stream}
        pathLength={200}
        stroke="#FFFFFF"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="12 188"
      />
      <g className="travellers">
        <circle cx="292" cy="117" r="4.5" fill="#7E8BFA" />
        <circle cx="324" cy="114" r="4.5" fill="#F0BE7E" />
        <circle cx="356" cy="116" r="4.5" fill="#8FD7BA" />
        <circle cx="388" cy="121" r="4.5" fill="#B9C4DC" />
        <circle cx="420" cy="124" r="4.5" fill="#B9A6F5" />
        <circle cx="452" cy="127" r="4.5" fill="#6D9BFF" />
        <circle cx="484" cy="128" r="4.5" fill="#7E8BFA" />
      </g>

      {/* first users */}
      <g transform="translate(596 106)">
        <g className="pop pop1">
          <g className="bob bob1">
            <ellipse cx="0" cy="22" rx="17" ry="3.5" fill="url(#onbb-shadow)" />
            <circle r="15" fill="#FFFFFF" stroke="#E6EAF4" strokeWidth="1.5" />
            <use
              href="#onbb-minicat"
              color="#EDBE7F"
              transform="translate(0 1) scale(0.75)"
            />
          </g>
        </g>
      </g>
      <g transform="translate(628 150)">
        <g className="pop pop2">
          <g className="bob bob2">
            <ellipse cx="0" cy="20" rx="16" ry="3.5" fill="url(#onbb-shadow)" />
            <circle r="14" fill="#FFFFFF" stroke="#E6EAF4" strokeWidth="1.5" />
            <use
              href="#onbb-minicat"
              color="#B39DF2"
              transform="translate(0 1) scale(0.7)"
            />
          </g>
        </g>
      </g>

      {/* live monitor */}
      <ellipse cx="722" cy="168" rx="56" ry="7" fill="url(#onbb-shadow)" />
      <rect
        x="660"
        y="74"
        width="124"
        height="84"
        rx="14"
        fill="url(#onbb-panel)"
        stroke="#E3E8F3"
        strokeWidth="1.5"
      />
      <rect x="674" y="88" width="56" height="7" rx="3.5" fill="#C9D3E6" />
      <path
        className="pulse-flat"
        d="M672 128 H 760"
        stroke="#C9D3E6"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        className="pulse-beat"
        d={beat}
        stroke="url(#onbb-accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="pulse-sweep"
        d={beat}
        pathLength={200}
        stroke="#FFFFFF"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="16 184"
      />
      <circle
        className="live-ring"
        cx="766"
        cy="128"
        r="7"
        stroke="#3FBF89"
        strokeWidth="1.5"
      />
      <circle
        className="live-dot"
        cx="766"
        cy="128"
        r="4"
        fill="#3FBF89"
        stroke="#FFFFFF"
        strokeWidth="2"
      />

      {/* the cat */}
      <ellipse cx="100" cy="178" rx="60" ry="9" fill="url(#onbb-shadow)" />
      <g transform="translate(96 78) scale(0.72) rotate(2)">
        <g className="cat-pose">
          <g className="cat-hop">
            <g className="cat-breath">
              <g className="tail-anim">
                <path
                  d="M-32 106 C -66 116 -88 106 -92 82 C -94.5 68 -82 64 -79 76 C -76 90 -62 98 -36 94 Z"
                  fill="#5F6CEC"
                />
                <circle cx="-86.5" cy="72" r="7" fill="#EDEFFF" />
              </g>
              <g transform="translate(-33 -45) rotate(-26)">
                <g className="ear-anim ear-l">
                  <use href="#onbb-ear" fill="#6874F0" />
                  <use
                    href="#onbb-ear"
                    fill="#D9CFFF"
                    transform="translate(0 -1.5) scale(0.52)"
                  />
                </g>
              </g>
              <g transform="translate(33 -45) rotate(26)">
                <g className="ear-anim ear-r">
                  <use href="#onbb-ear" fill="#6874F0" />
                  <use
                    href="#onbb-ear"
                    fill="#D9CFFF"
                    transform="translate(0 -1.5) scale(0.52)"
                  />
                </g>
              </g>
              <path
                d="M-40 110 C -40 58 -22 34 0 34 C 22 34 40 58 40 110 C 40 124 28 130 0 130 C -28 130 -40 124 -40 110 Z"
                fill="url(#onbb-cat-indigo)"
              />
              <ellipse cx="0" cy="43" rx="23" ry="8" fill="#4A55CF" opacity="0.1" />
              <ellipse cx="-2" cy="94" rx="15" ry="21" fill="url(#onbb-soft-indigo)" />
              <rect x="-25" y="108" width="18" height="24" rx="9" fill="#EDEFFF" />
              <path
                d="M-19 125v5M-13 125v5"
                stroke="#C9CDF4"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path
                d="M-52 4 C -52 -28 -30 -46 0 -46 C 28 -46 52 -28 52 4 C 52 32 28 48 0 48 C -28 48 -52 32 -52 4 Z"
                fill="url(#onbb-cat-indigo)"
              />
              <g className="face-gaze">
                <g transform="translate(7 -6)">
                  <ellipse cx="1" cy="16" rx="19" ry="11.5" fill="url(#onbb-soft-indigo)" />
                  <g className="eyes">
                    <ellipse cx="-18" cy="-6" rx="8" ry="10.5" fill="#262B45" />
                    <ellipse cx="20" cy="-6" rx="8" ry="10.5" fill="#262B45" />
                    <circle cx="-15" cy="-10" r="3" fill="#FFFFFF" />
                    <circle cx="23" cy="-10" r="3" fill="#FFFFFF" />
                    <circle cx="-21" cy="-2" r="1.2" fill="#FFFFFF" opacity="0.6" />
                    <circle cx="17" cy="-2" r="1.2" fill="#FFFFFF" opacity="0.6" />
                  </g>
                  <path
                    d="M-3 10 L 5 10 Q 7.4 10.5 6 13 L 3 16.2 Q 1 17.8 -1 16.2 L -4 13 Q -5.4 10.5 -3 10 Z"
                    fill="#3A3F5F"
                  />
                  <path
                    d="M1 17.5 Q 1 21 -2.6 21.8 M1 17.5 Q 1 21 4.6 21.8"
                    stroke="#3A3F5F"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    fill="none"
                  />
                  <ellipse cx="-30" cy="10" rx="6" ry="3.6" fill="#F19BB4" opacity="0.3" />
                  <ellipse cx="32" cy="10" rx="6" ry="3.6" fill="#F19BB4" opacity="0.3" />
                  <g
                    stroke="#4A55CF"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    opacity="0.4"
                  >
                    <path d="M-33 6 L -50 2" />
                    <path d="M-33 12 L -49 12" />
                    <path d="M37 6 L 53 2" />
                    <path d="M37 12 L 52 12" />
                  </g>
                </g>
              </g>
              <g className="cat-arm">
                <rect
                  x="20"
                  y="47"
                  width="52"
                  height="17"
                  rx="8.5"
                  transform="rotate(14 20 55)"
                  fill="url(#onbb-cat-indigo)"
                />
                <circle cx="68" cy="64" r="8" fill="#EDEFFF" />
              </g>
              <g
                className="celebrate"
                stroke="#8FD7BA"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M-24 -86 l-4 -5" />
                <path d="M2 -96 v-7" />
                <path d="M28 -86 l4 -5" />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
