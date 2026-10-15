import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MASK_TEMPLATES,
  MASKING_COPY,
  MASKING_FALLBACK,
  coverParamValue,
  isValidSelector,
  isValidUrlPattern,
  selectorIssue,
  urlPatternIssue,
} from "./settings.data";

/* Makes the selector parse check accept anything, so only the panel's own
   structural and syntax checks can reject a selector. */
const lenientParser = () =>
  vi.spyOn(document, "createDocumentFragment").mockReturnValue({
    querySelector: () => null,
  } as unknown as DocumentFragment);
/* Runs `fn` with a `new RegExp` that accepts any pattern (Node 20 can't
   compile inline flags yet), so only the panel's own syntax check can reject
   one. Regex literals are unaffected. */
function withLenientRegExp<T>(fn: () => T): T {
  vi.stubGlobal("RegExp", function () {
    return /x/;
  });
  try {
    return fn();
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isValidSelector", () => {
  it.each([
    ".ok",
    "[data-private]",
    'input[type="password"]',
    'input[autocomplete="cc-number"], input[name*="card"]',
    "div > span.x",
    ":not(.x)",
    "input:is(.a, .b)",
    '[title="a,b"]',
    "[data-x='a]']",
    "  .padded  ",
  ])("accepts %j", (sel) => {
    expect(isValidSelector(sel)).toBe(true);
  });

  it.each(["", "   ", "[[", "div >", "a]", "a)", ".a,,.b", "#1"])(
    "rejects %j",
    (sel) => {
      expect(isValidSelector(sel)).toBe(false);
    },
  );

  /* Real browsers auto-close these at the end of a selector, so they parse
     fine alone — but the web SDK joins rules with ", ", and each one would
     swallow (or rewrite) every rule joined after it. Stub a lenient parser so
     only the structural check can reject them. */
  it.each([
    '[name="x',
    "[data-x",
    "div:not(.a",
    "a\\",
    "a /* note",
    ".a /* closed */",
  ])("rejects %j even where the browser parser accepts it", (sel) => {
    lenientParser();
    expect(isValidSelector(sel)).toBe(false);
    expect(isValidSelector(".ok")).toBe(true);
  });

  /* A current browser parses these, so they pass the admin's check, but each
     is a SyntaxError in engines end users still run (Firefox ESR 115 has no
     :has()), and there the SDK's joined selector list stops matching. */
  it.each([
    ".form:has(input)",
    "div:HAS(> .x)",
    "& .x",
    ".a &",
    "li:nth-child(2 of .x)",
    "li:nth-last-child(odd of .x)",
  ])("refuses %j as syntax older browsers can't read", (sel) => {
    lenientParser();
    expect(selectorIssue(sel)).toBe("newSyntax");
    expect(isValidSelector(sel)).toBe(false);
  });

  it.each([
    '[title="a&b"]',
    "[data-x=':has(x)']",
    ".a\\&b",
    ".of",
    "li:nth-child(2n+1)",
    "li:nth-child(odd) .of",
    "li:nth-of-type(2)",
  ])("does not mistake %j for newer syntax", (sel) => {
    lenientParser();
    expect(selectorIssue(sel)).toBe(null);
  });

  it("tells a broken selector from a newer one", () => {
    expect(selectorIssue("[[")).toBe("invalid");
    expect(selectorIssue(".ok")).toBe(null);
  });

  it("never queries the live page", () => {
    const spy = vi.spyOn(document, "querySelector");
    isValidSelector("body");
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts every template selector", () => {
    for (const t of MASK_TEMPLATES) {
      if (t.kind === "url") expect(isValidUrlPattern(t.pattern!)).toBe(true);
      else expect(isValidSelector(t.selector!)).toBe(true);
    }
  });
});

describe("isValidUrlPattern", () => {
  it.each(["token=", "api_key=", "/api/secret/", "auth=\\w+"])(
    "accepts %j",
    (p) => {
      expect(isValidUrlPattern(p)).toBe(true);
    },
  );

  it.each(["", "  ", "?token=", "(", "[a-"])("rejects %j", (p) => {
    expect(isValidUrlPattern(p)).toBe(false);
    expect(urlPatternIssue(p)).toBe("invalid");
  });

  /* These compile here but throw in older engines (lookbehind before Safari
     16.4, inline flags before 2024), and a throw stops the web SDK applying
     the dashboard config at all. */
  it.each(["(?<=token=)[^&]+", "(?<!x)y", "(?i:email)=", "a(?-i:B)"])(
    "refuses %j as syntax older browsers can't compile",
    (p) => {
      expect(withLenientRegExp(() => urlPatternIssue(p))).toBe("newSyntax");
      expect(isValidUrlPattern(p)).toBe(false);
    },
  );

  it.each(["(?:token|auth)=", "(?<name>a)", "[(?<=]", "\\(?<=", "a(?=b)"])(
    "does not mistake %j for newer syntax",
    (p) => {
      expect(withLenientRegExp(() => urlPatternIssue(p))).toBe(null);
      expect(urlPatternIssue(p)).toBe(null);
    },
  );
});

describe("coverParamValue", () => {
  it.each([
    ["email=", "email=[^&#]*"],
    ["  session=  ", "session=[^&#]*"],
    ["/api/secret/", "/api/secret/"],
    ["auth=\\w+", "auth=\\w+"],
  ])("turns %j into %j", (raw, saved) => {
    expect(coverParamValue(raw)).toBe(saved);
  });

  /* The web SDK applies each pattern as url.replace(new RegExp(p, "i"),
     "[REDACTED]") (withRedactedUrl), so only the matched text goes. */
  it("hides the value, not only the key, the way the web SDK applies it", () => {
    const apply = (p: string, url: string) =>
      url.replace(new RegExp(p, "i"), "[REDACTED]");
    const url = "/api/users?email=jane@acme.com&page=2#top";
    expect(apply("email=", url)).toContain("jane@acme.com");
    expect(apply(coverParamValue("email="), url)).toBe(
      "/api/users?[REDACTED]&page=2#top",
    );
  });
});

describe("MASKING_FALLBACK", () => {
  it("equals the server's DEFAULT_MASKING", () => {
    expect(MASKING_FALLBACK).toEqual({
      maskAllInputs: false,
      maskSelectors: ["[data-private]", ".sensitive"],
      blockSelectors: [".no-replay"],
      redactUrlPatterns: ["token=", "api_key="],
      blockCreditCardText: true,
      stripQueryParams: false,
      allowedQueryParams: ["utm_source", "utm_medium", "utm_campaign"],
      allowedHosts: [],
    });
  });

  it("holds only selectors and patterns the SDK can use", () => {
    for (const s of [
      ...MASKING_FALLBACK.maskSelectors,
      ...MASKING_FALLBACK.blockSelectors,
    ])
      expect(isValidSelector(s)).toBe(true);
    for (const p of MASKING_FALLBACK.redactUrlPatterns)
      expect(isValidUrlPattern(p)).toBe(true);
  });
});

describe("MASKING_COPY", () => {
  const help = MASKING_COPY.maskInputsHelp.join(" ");

  it("labels the switch as a force, not a default", () => {
    expect(MASKING_COPY.maskInputsLabel).toBe("Always mask input values");
  });

  it("names the SDK versions each promise needs", () => {
    expect(help).toContain("web SDKs mask every input value");
    expect(help).toContain("web SDK 0.1.20+");
    expect(help).toContain("web SDK 0.1.19 and older record what users type");
    expect(help).toContain("maskAllInputs: false");
  });

  /* Each package has its own version line: React Native 0.0.7 already exists
     and bundles Android 0.0.6, which never reads the dashboard flag. */
  it("gives every mobile package its own version", () => {
    expect(help).toContain("Android EditText from Android SDK 0.0.7");
    expect(help).toContain("iOS UITextField and UITextView from iOS SDK 0.0.7");
    expect(help).toContain("React Native TextInput from React Native SDK 0.0.8");
    expect(help).not.toMatch(/Android and iOS SDK 0\.0\.7/);
  });

  /* The force only arrives with the SDK config: a blocked or slow config
     request leaves the app's own setting in charge, and mobile reads the flag
     when a session starts. */
  it("says the force applies once the SDK has the settings", () => {
    const on = MASKING_COPY.maskInputsHelp[0];
    expect(on).toMatch(/^On: once an SDK has loaded this workspace's settings,/);
    expect(on).toContain(
      "Mobile apps pick up a change at their next session start.",
    );
  });

  /* Mobile apps can still send an observed field's value on the timeline
     (addObservedInput / trackInput), so the mobile promise is scoped to
     screen recordings and never to "every input value". */
  it("scopes the mobile promise to screen recordings", () => {
    const on = MASKING_COPY.maskInputsHelp[0];
    expect(on).not.toMatch(/every input value (stays|is) masked/);
    expect(on).toContain(
      "mobile SDKs hide native text fields in screen recordings",
    );
    expect(on.indexOf("web SDKs mask every input value")).toBeLessThan(
      on.indexOf("mobile SDKs hide native text fields"),
    );
  });

  it("says Flutter and Compose text fields are not auto-masked", () => {
    expect(help).toMatch(
      /Flutter and Jetpack Compose text fields, password fields included, are not masked automatically/,
    );
    expect(help).toContain("ReplayMask");
    expect(help).toContain("Modifier.replayOcclude");
  });

  it("drops the old overclaims", () => {
    expect(help).not.toMatch(/allowlist/i);
    expect(help).not.toMatch(/every platform/i);
    expect(help).not.toMatch(/never unmasks/i);
  });

  it("scopes card and query stripping to network request URLs", () => {
    expect(MASKING_COPY.cardTextHelp).toContain("network request URLs");
    expect(MASKING_COPY.cardTextHelp).not.toMatch(/outside form fields/i);
    expect(MASKING_COPY.cardTextHelp).not.toMatch(/bod(y|ies)|network data/i);
    expect(MASKING_COPY.stripQueryHelp).toContain("network request URLs");
    expect(MASKING_COPY.stripQueryHelp).toContain("Page URLs keep theirs");
    expect(MASKING_COPY.allowedParamsHelp).toContain("While stripping is on");
    expect(MASKING_COPY.allowedParamsHelp).not.toContain(
      "everything else is stripped",
    );
  });

  it("says a bad URL pattern can stop recording, not only settings", () => {
    expect(MASKING_COPY.invalidPattern).toContain("can record no replay");
    expect(MASKING_COPY.newPattern).toContain("can record no replay");
  });

  it("explains what a URL pattern reaches and how it matches", () => {
    const h = MASKING_COPY.urlPatternsHelp;
    expect(h).toContain("case-insensitive regular expression");
    expect(h).toContain("captured network request and resource URL");
    expect(h).toContain("Every match");
    expect(h).toContain(`email= is saved as ${coverParamValue("email=")}`);
  });
});
