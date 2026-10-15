/**
 * The server-side masking rule checks: a mask / block selector must parse as
 * a selector list and stand on its own (web SDKs join rules with ", "), and a
 * redact URL pattern must compile as a RegExp. Every rule the dashboard
 * accepts must pass here too.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUsableSelector,
  isUsableUrlPattern,
} from "../src/settings/masking-rules";

describe("isUsableSelector", () => {
  const accepted = [
    // The defaults and the dashboard's own accept list and templates.
    "[data-private]",
    ".sensitive",
    ".no-replay",
    ".ok",
    'input[type="password"]',
    'input[autocomplete="cc-number"], input[name*="card"]',
    'input[autocomplete="cc-csc"], input[name*="cvc"]',
    'input[name*="ssn"]',
    ".user-email, [data-email]",
    "div > span.x",
    ":not(.x)",
    "input:is(.a, .b)",
    '[title="a,b"]',
    "[data-x='a]']",
    "  .padded  ",
    // Combinators, universal and namespace forms querySelector parses.
    "a b",
    "a+b",
    "a ~ b",
    "a>b",
    ".a, .b,\n.c",
    "html body .x",
    "*",
    "*|*",
    "|a",
    "*|a",
    // The nesting selector (modern browsers).
    "&",
    // Identifiers: escapes, non-ASCII, leading dashes and underscores.
    "#main",
    "#\\31 23",
    ".a\\:b",
    ".café",
    ".🙂",
    ".-a",
    ".--a",
    "._a",
    // Attribute selectors.
    "[data-x=y i]",
    '[data-x="y" s]',
    "[ data-x ]",
    "[data-x|=en]",
    "[data-x~=a]",
    "[data-x^=a]",
    "[data-x$=a]",
    "[data-x*=a]",
    "[data-x=--]",
    "[*|data-x]",
    "[|data-x]",
    '[title="a\\"b"]',
    // Pseudo-classes and pseudo-elements.
    'a:not([type="hidden"]):not(.x)',
    "div:has(> img)",
    "li:nth-child(2n + 1)",
    "a::before",
    "input::-webkit-input-placeholder",
    ":root",
    ":is()",
    "a:where()",
  ];
  for (const sel of accepted) {
    it(`accepts ${JSON.stringify(sel)}`, () => {
      assert.equal(isUsableSelector(sel), true);
    });
  }

  const rejected = [
    // The dashboard's reject list.
    "",
    "   ",
    "[[",
    "div >",
    "a]",
    "a)",
    ".a,,.b",
    "#1",
    // Parse alone in a browser, but swallow every rule joined after them.
    '[name="x',
    "[data-x",
    "div:not(.a",
    "a\\",
    "a /* note",
    // Comments are refused outright, as in the dashboard.
    ".a /* closed */",
    // Lists and combinators.
    "> a",
    "a,",
    ",a",
    "a > > b",
    "a*",
    "a||b",
    // Identifiers.
    ".",
    ".1",
    ".-1",
    "#",
    "#-1",
    // Attribute selectors.
    "[data-x=1]",
    "[]",
    "[=x]",
    "[data-x!=y]",
    "[data-x=y z]",
    "[data-x i]",
    "[ns|x]",
    '[title="a\nb"]',
    // Namespaces querySelector can't resolve.
    "svg|rect",
    // Pseudo-classes.
    "a:",
    "a: hover",
    ":not()",
    ":has()",
    "a:nth-child()",
    // Not selectors at all.
    "a{color:red}",
    "a;b",
    "div$",
    ".a!important",
  ];
  for (const sel of rejected) {
    it(`rejects ${JSON.stringify(sel)}`, () => {
      assert.equal(isUsableSelector(sel), false);
    });
  }

  it("rejects a non-string", () => {
    assert.equal(isUsableSelector(42), false);
    assert.equal(isUsableSelector(null), false);
  });
});

describe("isUsableUrlPattern", () => {
  for (const p of [
    "token=",
    "api_key=",
    "^https://",
    "\\bsecret\\b",
    "(?<=x)y",
  ]) {
    it(`accepts ${JSON.stringify(p)}`, () => {
      assert.equal(isUsableUrlPattern(p), true);
    });
  }
  for (const p of ["", "  ", "(", "[", "*a", "a{2,1}"]) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      assert.equal(isUsableUrlPattern(p), false);
    });
  }
  it("rejects a non-string", () => {
    assert.equal(isUsableUrlPattern(undefined), false);
  });
});
