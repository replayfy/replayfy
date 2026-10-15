import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MASKING_COPY,
  MASKING_FALLBACK,
  type ApiMasking,
} from "../settings.data";
import { PanelMasking } from "./PanelMasking";

/* The panel's reads and writes are stubbed at the module boundary: useApi
   hands back whatever `api.state` holds, and every PATCH lands in `setMasking`
   instead of the network. */
const api = vi.hoisted(() => ({
  state: {
    data: undefined as ApiMasking | undefined,
    stale: false,
    syncing: false,
    error: null as Error | null,
    refetch: (() => {}) as () => void,
  },
}));
const setMasking = vi.hoisted(() => vi.fn(async (_body: unknown) => ({})));
vi.mock("@/api/useApi", () => ({ useApi: () => api.state }));
vi.mock("@/api/endpoints", () => ({
  Settings: { masking: { get: vi.fn(), set: setMasking } },
}));
vi.mock("@/components/feedback", () => ({ useToast: () => () => {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root;
let host: HTMLDivElement;

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<PanelMasking />));
}

const loaded = (over: Partial<ApiMasking> = {}): ApiMasking => ({
  ...MASKING_FALLBACK,
  maskSelectors: [".user-email"],
  blockSelectors: [".no-replay"],
  ...over,
});

const buttons = (text: string) =>
  [...host.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === text,
  );
const [ruleInput, urlInput] = [0, 1].map(
  (i) => () => host.querySelectorAll<HTMLInputElement>(".set-card-add input")[i],
);
const allowedInput = () =>
  [...host.querySelectorAll<HTMLInputElement>("input")].at(-1)!;
const alerts = () =>
  [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
/* React drops a click on a disabled control before any handler runs, so a
   click can't show that a handler refuses on its own. This calls the handler
   React holds for the element directly, as an enabled path would. */
function callHandler(el: Element, name: string, arg: unknown = {}) {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  const props = (el as unknown as Record<string, Record<string, unknown>>)[key];
  act(() => {
    (props[name] as (a: unknown) => void)(arg);
  });
}
const rerender = () => act(() => root.render(<PanelMasking />));
/* Opens the template menu (portalled to <body>) and returns its items. */
function templates() {
  click(buttons("Add from template")[0]);
  return [...document.querySelectorAll<HTMLButtonElement>(".menu-pop button")];
}

beforeEach(() => {
  api.state = {
    data: undefined,
    stale: false,
    syncing: false,
    error: null,
    refetch: () => {},
  };
  setMasking.mockReset();
  setMasking.mockImplementation(async () => ({}));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("PanelMasking copy", () => {
  it("renders the force-masking label and every help paragraph", () => {
    api.state.data = loaded();
    render();
    const text = host.textContent ?? "";
    expect(text).toContain(MASKING_COPY.maskInputsLabel);
    for (const p of MASKING_COPY.maskInputsHelp) expect(text).toContain(p);
    expect(text).toContain(MASKING_COPY.cardTextHelp);
    expect(text).toContain(MASKING_COPY.stripQueryHelp);
    expect(text).toContain(MASKING_COPY.allowedParamsHelp);
    expect(text).not.toContain("allowlisted later");
    expect(text).not.toContain("even outside form fields");
  });
});

describe("PanelMasking before the config has loaded", () => {
  it("shows the server defaults and locks every control", () => {
    render();
    const text = host.textContent ?? "";
    for (const s of [".no-replay", "[data-private]", ".sensitive"])
      expect(text).toContain(s);
    const toggles = [...host.querySelectorAll<HTMLButtonElement>(".toggle")];
    expect(toggles).toHaveLength(3);
    for (const t of toggles) expect(t.disabled).toBe(true);
    expect(toggles[0].classList.contains("on")).toBe(false);
    for (const b of [
      ...buttons("Add"),
      ...buttons("Add from template"),
      ...host.querySelectorAll<HTMLButtonElement>(".ibtn"),
    ])
      expect((b as HTMLButtonElement).disabled).toBe(true);
    for (const i of host.querySelectorAll("input"))
      expect(i.disabled).toBe(true);
    for (const x of host.querySelectorAll<HTMLButtonElement>(".ibtn"))
      expect(x.style.opacity).toBe("0.5");
  });

  it("sends nothing even if a locked control is clicked", () => {
    render();
    for (const t of host.querySelectorAll(".toggle")) click(t);
    for (const x of host.querySelectorAll(".ibtn")) click(x);
    for (const b of buttons("Add")) click(b);
    expect(setMasking).not.toHaveBeenCalled();
  });

  /* Defense in depth: the handlers behind every control refuse while locked
     even when reached without the disabled control in the way. */
  it("refuses in every write handler, not only through disabled controls", () => {
    render();
    for (const t of host.querySelectorAll(".toggle")) callHandler(t, "onClick");
    for (const x of host.querySelectorAll(".ibtn")) callHandler(x, "onClick");
    callHandler(ruleInput(), "onChange", { target: { value: ".x" } });
    callHandler(buttons("Add")[0], "onClick");
    callHandler(urlInput(), "onChange", { target: { value: "email=" } });
    callHandler(buttons("Add")[1], "onClick");
    for (const t of templates()) callHandler(t, "onClick");
    callHandler(allowedInput(), "onChange", { target: { value: "ref" } });
    callHandler(allowedInput(), "onBlur");
    expect(setMasking).not.toHaveBeenCalled();
    // A refused add keeps the draft, so nothing looks saved that wasn't.
    expect(ruleInput().value).toBe(".x");
    expect(urlInput().value).toBe("email=");
    expect(alerts()).toEqual([]);
  });

  it("explains a load error and offers a retry", () => {
    const refetch = vi.fn();
    api.state = { ...api.state, error: new Error("500"), refetch };
    render();
    expect(alerts().join(" ")).toContain(MASKING_COPY.loadError);
    click(buttons("Retry")[0]);
    expect(refetch).toHaveBeenCalledTimes(1);
    for (const t of host.querySelectorAll<HTMLButtonElement>(".toggle"))
      expect(t.disabled).toBe(true);
  });

  it("locks after a failed refetch, even with data on screen", () => {
    api.state = { ...api.state, data: loaded(), error: new Error("500") };
    render();
    expect(alerts().join(" ")).toContain(MASKING_COPY.loadError);
    for (const t of host.querySelectorAll<HTMLButtonElement>(".toggle"))
      expect(t.disabled).toBe(true);
    for (const t of host.querySelectorAll(".toggle")) callHandler(t, "onClick");
    expect(setMasking).not.toHaveBeenCalled();
  });

  it("stays locked while showing the previous workspace's config", () => {
    api.state = { ...api.state, data: loaded(), stale: true };
    render();
    for (const t of host.querySelectorAll<HTMLButtonElement>(".toggle"))
      expect(t.disabled).toBe(true);
    for (const t of host.querySelectorAll(".toggle")) click(t);
    expect(setMasking).not.toHaveBeenCalled();
  });
});

describe("PanelMasking selector validation", () => {
  it("rejects an invalid selector inline and keeps the draft", () => {
    api.state.data = loaded();
    render();
    type(ruleInput(), "[[");
    click(buttons("Add")[0]);
    expect(setMasking).not.toHaveBeenCalled();
    expect(alerts()).toContain(` ${MASKING_COPY.invalidDraft}`);
    expect(ruleInput().value).toBe("[[");
    expect(ruleInput().getAttribute("aria-invalid")).toBe("true");
    expect(ruleInput().classList.contains("in-err")).toBe(true);
    type(ruleInput(), "[[x");
    expect(alerts()).toHaveLength(0);
    expect(ruleInput().classList.contains("in-err")).toBe(false);
  });

  it("saves a valid selector together with the existing rules", () => {
    api.state.data = loaded();
    render();
    type(ruleInput(), '  input[name="card"]  ');
    click(buttons("Add")[0]);
    expect(setMasking).toHaveBeenCalledWith({
      blockSelectors: [".no-replay", 'input[name="card"]'],
      maskSelectors: [".user-email"],
    });
    expect(ruleInput().value).toBe("");
  });

  it("flags a stored invalid rule, blocks additions, and lets it be removed", () => {
    api.state.data = loaded({ blockSelectors: ['[name="x', ".ok"] });
    render();
    expect(host.textContent).toContain(MASKING_COPY.invalidRule("block"));
    expect(host.textContent).not.toContain(MASKING_COPY.invalidRule("mask"));

    type(ruleInput(), ".fine");
    click(buttons("Add")[0]);
    expect(setMasking).not.toHaveBeenCalled();
    expect(alerts()).toContain(` ${MASKING_COPY.invalidRulesBlock}`);

    click(host.querySelectorAll(".ibtn")[0]);
    expect(setMasking).toHaveBeenCalledWith({
      blockSelectors: [".ok"],
      maskSelectors: [".user-email"],
    });
  });

  it("rejects an invalid URL pattern inline and saves a valid one", () => {
    api.state.data = loaded();
    render();
    type(urlInput(), "?token=");
    click(buttons("Add")[1]);
    expect(setMasking).not.toHaveBeenCalled();
    expect(alerts()).toContain(` ${MASKING_COPY.invalidDraftPattern}`);
    expect(urlInput().classList.contains("in-err")).toBe(true);

    type(urlInput(), "session=");
    click(buttons("Add")[1]);
    expect(setMasking).toHaveBeenCalledWith({
      redactUrlPatterns: ["token=", "api_key=", "session=[^&#]*"],
    });
  });

  it("rejects a lookbehind URL pattern older browsers can't compile", () => {
    api.state.data = loaded();
    render();
    type(urlInput(), "(?<=email=)[^&]+");
    click(buttons("Add")[1]);
    expect(setMasking).not.toHaveBeenCalled();
    expect(alerts()).toContain(` ${MASKING_COPY.newPatternDraft}`);
    expect(urlInput().value).toBe("(?<=email=)[^&]+");
  });

  it("flags a stored lookbehind pattern with the older-browser message", () => {
    api.state.data = loaded({ redactUrlPatterns: ["(?<=a=)b"] });
    render();
    expect(host.textContent).toContain(MASKING_COPY.newPattern);
    expect(host.textContent).not.toContain(MASKING_COPY.invalidPattern);
  });

  it("explains what URL patterns reach", () => {
    api.state.data = loaded();
    render();
    expect(host.textContent).toContain(MASKING_COPY.urlPatternsHelp);
  });

  it("saves a key= template with its value covered, once", () => {
    api.state.data = loaded({ redactUrlPatterns: [] });
    render();
    const token = templates().find((t) => t.textContent?.includes("token="))!;
    click(token);
    expect(setMasking).toHaveBeenCalledWith({
      redactUrlPatterns: ["token=[^&#]*"],
    });
  });

  it("rejects a selector older browsers can't read, with its own message", () => {
    vi.spyOn(document, "createDocumentFragment").mockReturnValue({
      querySelector: () => null,
    } as unknown as DocumentFragment);
    api.state.data = loaded({ maskSelectors: [".user-email", "li:has(b)"] });
    render();
    expect(host.textContent).toContain(MASKING_COPY.newSelectorRule("mask"));
    expect(host.textContent).not.toContain(MASKING_COPY.invalidRule("mask"));
    type(ruleInput(), ".form:has(input)");
    click(buttons("Add")[0]);
    expect(setMasking).not.toHaveBeenCalled();
    expect(alerts()).toContain(` ${MASKING_COPY.newSelectorDraft}`);
  });
});

describe("PanelMasking while a save is in flight", () => {
  /* Each rule write sends the whole list, built from `data`; until the save's
     refetch lands, `data` is the list from BEFORE that save, so a second edit
     made then would silently undo the first. */
  it("locks until the save's refetch has landed, then builds on it", async () => {
    let finish: () => void = () => {};
    setMasking.mockImplementationOnce(
      () => new Promise<object>((r) => (finish = () => r({}))),
    );
    const refetch = vi.fn(() => {
      api.state.syncing = true;
    });
    api.state = { ...api.state, data: loaded(), refetch };
    render();

    type(ruleInput(), 'input[name*="ssn"]');
    click(buttons("Add")[0]);
    expect(setMasking).toHaveBeenCalledTimes(1);
    const locked = () => [
      ...host.querySelectorAll<HTMLButtonElement>(".toggle, .ibtn"),
      ...buttons("Add"),
      ...buttons("Add from template"),
    ];
    for (const b of locked()) expect(b.disabled).toBe(true);
    for (const t of templates()) callHandler(t, "onClick");
    expect(setMasking).toHaveBeenCalledTimes(1);

    // PATCH done, refetch running: still the old list on screen, still locked.
    await act(async () => finish());
    expect(refetch).toHaveBeenCalledTimes(1);
    for (const b of locked()) expect(b.disabled).toBe(true);

    // The refetch lands with the saved list: unlocked, and the next edit
    // keeps the first one.
    api.state = {
      ...api.state,
      syncing: false,
      data: loaded({ blockSelectors: [".no-replay", 'input[name*="ssn"]'] }),
    };
    rerender();
    for (const b of locked()) expect(b.disabled).toBe(false);
    type(ruleInput(), ".cvc");
    click(buttons("Add")[0]);
    expect(setMasking).toHaveBeenLastCalledWith({
      blockSelectors: [".no-replay", 'input[name*="ssn"]', ".cvc"],
      maskSelectors: [".user-email"],
    });
  });

  it("unlocks after a failed save once the refetch is done", async () => {
    setMasking.mockImplementationOnce(async () => {
      throw new Error("422");
    });
    api.state = { ...api.state, data: loaded() };
    render();
    click(host.querySelectorAll(".toggle")[0]);
    await act(async () => {});
    for (const t of host.querySelectorAll<HTMLButtonElement>(".toggle"))
      expect(t.disabled).toBe(false);
  });

  it("flags a stored invalid URL pattern and still lets it be removed", () => {
    api.state.data = loaded({ redactUrlPatterns: ["(", "token="] });
    render();
    expect(host.textContent).toContain(MASKING_COPY.invalidPattern);
    const rows = host.querySelectorAll(".ibtn");
    click(rows[rows.length - 2]);
    expect(setMasking).toHaveBeenCalledWith({ redactUrlPatterns: ["token="] });
  });
});
