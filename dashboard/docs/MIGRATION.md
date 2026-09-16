# Replayfy dashboard — rewrite contract

Prototype (`_legacy/*.jsx` + `*.css`, Babel-in-browser, `window.*` globals) →
**Vite + React 18 + TypeScript + react-router v6 + Tailwind**. This doc is the
contract every migration follows so the parallel work stays consistent.

## Golden rules

1. **TypeScript, strict.** Every component has a typed props `type`. No `any`
   unless unavoidable. No `React.` global — `import { useState } from "react"`.
2. **Named exports**, one component concept per file. No `window.*` — real ES
   imports from `@/…`. No React-hook aliasing (`const { useState: useS2 }`).
3. **Tailwind for styling.** Do NOT port the old CSS class names. Re-author each
   component's look with Tailwind utilities using the **token map** below. Keep
   genuinely-dynamic values (chart geometry, computed widths) as inline `style`.
4. **Mock data → `*.data.ts`** siblings. This phase consumes **no API**; the
   fixtures currently inline in the prototype become typed exports (the future
   API-swap points). Do not fetch anything.
5. **Reference, don't copy.** Read the matching `_legacy/*.jsx` for behavior +
   the matching `_legacy/*.css` for the visual spec (padding/color/radius →
   tokens). Reproduce the look; modernize the code.
6. **Conditional classes** use `cn()` from `@/lib/cn`.

## Token map (old CSS var → Tailwind)

| Old var | Tailwind | | Old var | Tailwind |
| --- | --- | --- | --- | --- |
| `--bg` | `bg-bg` | | `--text` | `text-ink` |
| `--surface` | `bg-surface` | | `--t2` | `text-ink-2` |
| `--stage` | `bg-stage` | | `--t3` | `text-ink-3` |
| `--panel` | `bg-panel` | | `--t4` | `text-ink-4` |
| `--line` | `border-line` | | `--accent` | `text-accent` / `bg-accent` |
| `--line-2` | `bg-line-2` / `border-line-2` | | `--accent-2` | `accent-2` |
| `--line-strong` | `border-line-strong` | | `--accent-weak` | `bg-accent-weak` |
| `--accent-tint` | `bg-accent-tint` | | `--green` / `--green-weak` | `text-green` / `bg-green-weak` |
| `--red` / `--red-weak` | `text-red` / `bg-red-weak` | | `--amber` / `--amber-weak` | `text-amber` / `bg-amber-weak` |
| `--blue` / `--blue-weak` | `text-blue` / `bg-blue-weak` | | `--hue-violet/magenta/slate` | `violet` / `magenta` / `slateh` |
| `--r-sm/md/lg` | `rounded-sm/md/lg` | | `--shadow-1/2/3` | `shadow-1/2/3` |
| `--font` | `font-sans` | | `--mono` | `font-mono` or `.mono` class |

**Weights (Linear):** `font-medium` = 510, `font-semibold` = 590 (already themed).
**Type sizes:** `text-2xs`(11) `text-xs`(11.5) `text-sm`(12.5) `text-base`(13, default)
`text-md`(14) `text-lg`(16) `text-xl`(20) `text-2xl`(24) `text-3xl`(30).
**Tracking:** `tracking-tightish`(body) `tracking-tight`(h2/3) `tracking-tighter`(h1).

## Easing / motion (house curves — themed)

| Utility | Curve | Use |
| --- | --- | --- |
| `ease-out` | `cubic-bezier(.22,1,.36,1)` | enters, hovers (default choice) |
| `ease-drawer` | `cubic-bezier(.32,.72,0,1)` | drawers/sheets |
| `ease-spring` | `cubic-bezier(.34,1.56,.64,1)` | subtle overshoot |
| `ease-in-out` | `cubic-bezier(.65,0,.35,1)` | on-screen movement |
| (default) | `cubic-bezier(.4,0,.2,1)` | generic |

Prebuilt entrance animations: `animate-pageIn` `animate-fadeIn` `animate-popIn`
`animate-riseIn` `animate-shimmer` `animate-grow`. Need another keyframe? Add it
to `tailwind.config.ts` (`keyframes`+`animation`), don't inline a `@keyframes`.

## Animation rules (emil-design-eng — enforced)

- **Never `transition-all`.** Name the properties: `transition-colors`,
  `transition-transform`, or `transition-[transform,opacity]`.
- **Every pressable element** (button, chip, nav item, row-as-button) gets
  `active:scale-[.97]` + `transition-transform duration-150 ease-out`.
- **Only animate `transform` + `opacity`** (and `color`/`background` for hover).
  Never animate `width/height/top/left/margin/padding` — use transforms
  (`translate`, `scale`, `translateY(100%)` tricks).
- **Enter from `scale(.97)`+opacity, never `scale(0)`.**
- **Popovers/menus/tooltips are origin-aware**: set `origin-top-right` etc. to
  match the trigger. Modals stay `origin-center`.
- **Focus**: add the `focus-ring` utility class to interactive elements.
- Keep UI animations < 300ms. Don't animate keyboard-driven / high-frequency
  actions.

## Browser-API → hooks (never touch `window` in render)

Import from `@/hooks`: `useElementWidth(ref)` (ResizeObserver),
`useInfiniteScroll(ref, onMore)` (IntersectionObserver), `usePopoverPosition(...)`
(viewport-clamped placement), `useEscapeKey(fn)`, `useOutsideClick(ref, fn)`,
`usePointerDrag(opts)`, `useWindowEvent(type, fn)`, `useMovingHL()`.

## Folder layout

```
src/
  components/
    primitives/   Icon, Portal, Popover, Select, Modal, Drawer, Toggle,
                  Checkbox, Seg, Search, DatePicker, NumberFlow, CodeBlock
    feedback/     toast/, skeletons/, empty-state/
    charts/       MiniSpark, TerminalChart, PerfChart, SignalChart, FunnelViz, Donut
    overlays/     V3Drawer
    command/      CommandPalette, RvSearch
    nav/          Sidebar, WorkspaceMenu (Phase C)
    layout/       AppLayout (routed shell)
  hooks/          the browser-API hooks above
  lib/            cn.ts, format.ts (smoothPath, number fmt)
  routes/         one folder per screen (Phase D), each with *.data.ts
```

## Known bug to FIX during migration (do not port)

`_legacy/page-recordings-v2.jsx:280` calls hooks **after** an early
`if (empty) return`. In the rewrite, **all hooks go above any conditional
return.** `react-hooks/recommended` lint will enforce this.
