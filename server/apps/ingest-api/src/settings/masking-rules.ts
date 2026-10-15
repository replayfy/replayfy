/**
 * Server-side checks for the masking rules a workspace stores: mask / block
 * CSS selectors and redact URL patterns. The dashboard checks the same rules
 * in the browser before saving; these keep a direct API call (or an older
 * dashboard) from storing a rule that switches the others off:
 *
 *   • web SDKs up to 0.1.19 join every selector of a mode with ", " into one
 *     rrweb selector, so one bad rule makes the whole list fail to match
 *     (mask rules) or throw on every DOM mutation (block rules);
 *   • every web SDK joins mask rules, and a rule with an unclosed string,
 *     bracket, paren, comment or escape parses alone (the browser closes it
 *     at the end) but swallows the rules joined after it;
 *   • web SDKs build `new RegExp(pattern, "i")` from each redact pattern, and
 *     one that throws stops the dashboard config from applying.
 *
 * The selector check is a syntax check of the selector-list grammar. It
 * rejects only what no browser parses, so it never blocks a rule the
 * dashboard accepts; it does not know which pseudo-class names exist, and it
 * checks functional pseudo-class arguments for balance only.
 */

/** Whether `sel` can be stored as one mask or block rule. */
export function isUsableSelector(sel: unknown): boolean {
  if (typeof sel !== "string") return false;
  const s = sel.trim();
  if (!s || !isSelfContainedSelector(s)) return false;
  return new SelectorScanner(s).selectorList();
}

/** Whether `pattern` can be stored as one redact URL pattern: what web SDKs
 *  compile from it must not throw. */
export function isUsableUrlPattern(pattern: unknown): boolean {
  if (typeof pattern !== "string" || !pattern.trim()) return false;
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

/** Every quote, [ and ( is closed, nothing closes what was never opened, and
 *  no comment or escape runs off the end. Same rule as the dashboard's. */
function isSelfContainedSelector(s: string): boolean {
  const open: string[] = [];
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      if (++i >= s.length) return false;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "/" && s[i + 1] === "*") return false;
    else if (c === "[") open.push("]");
    else if (c === "(") open.push(")");
    else if ((c === "]" || c === ")") && open.pop() !== c) return false;
  }
  return !quote && open.length === 0;
}

/**
 * Recursive-descent scan of a selector list, as querySelector parses it:
 *   list     = complex ( "," complex )*
 *   complex  = compound ( [ ">" | "+" | "~" | whitespace ] compound )*
 *   compound = [ type | "*" ] ( "#"ident | "."ident | [attr] | :pseudo | "&" )*
 * querySelector has no namespace declarations, so only the "*|" and "|"
 * prefixes parse.
 */
class SelectorScanner {
  private i = 0;

  constructor(private readonly s: string) {}

  selectorList(): boolean {
    for (;;) {
      this.ws();
      if (!this.complex()) return false;
      this.ws();
      if (this.i >= this.s.length) return true;
      if (this.s[this.i] !== ",") return false;
      this.i++;
    }
  }

  private complex(): boolean {
    if (!this.compound()) return false;
    for (;;) {
      const spaced = this.ws();
      const c = this.s[this.i];
      if (c === undefined || c === ",") return true;
      if (c === ">" || c === "+" || c === "~") {
        this.i++;
        this.ws();
      } else if (!spaced) {
        return false;
      }
      if (!this.compound()) return false;
    }
  }

  private compound(): boolean {
    const start = this.i;
    if (!this.typeSelector()) return false;
    for (;;) {
      const c = this.s[this.i];
      if (c === "#" || c === ".") {
        this.i++;
        if (!this.ident()) return false;
      } else if (c === "[") {
        if (!this.attribute()) return false;
      } else if (c === ":") {
        if (!this.pseudo()) return false;
      } else if (c === "&") {
        this.i++;
      } else {
        break;
      }
    }
    return this.i > start;
  }

  /** Optional type or universal selector. True when absent. */
  private typeSelector(): boolean {
    const c = this.s[this.i];
    if (c === "|") {
      this.i++;
      return this.nameOrStar();
    }
    if (c === "*") {
      this.i++;
      if (this.s[this.i] !== "|") return true;
      this.i++;
      return this.nameOrStar();
    }
    // A named namespace prefix ("svg|rect") never parses in querySelector.
    if (this.ident()) return this.s[this.i] !== "|";
    return true;
  }

  private nameOrStar(): boolean {
    if (this.s[this.i] === "*") {
      this.i++;
      return true;
    }
    return this.ident();
  }

  /** [ name ] or [ name matcher value modifier? ]. */
  private attribute(): boolean {
    const s = this.s;
    this.i++;
    this.ws();
    if (s[this.i] === "*" && s[this.i + 1] === "|" && s[this.i + 2] !== "=") {
      this.i += 2;
    } else if (s[this.i] === "|" && s[this.i + 1] !== "=") {
      this.i++;
    }
    if (!this.ident()) return false;
    this.ws();
    if (s[this.i] !== "]") {
      const c = s[this.i];
      if (c === "=") this.i++;
      else if (
        (c === "~" || c === "|" || c === "^" || c === "$" || c === "*") &&
        s[this.i + 1] === "="
      )
        this.i += 2;
      else return false;
      this.ws();
      // An unquoted value must be an identifier: [data-id=1] does not parse.
      if (!this.string() && !this.ident()) return false;
      this.ws();
      const flagStart = this.i;
      if (this.ident()) {
        const flag = s.slice(flagStart, this.i).toLowerCase();
        if (flag !== "i" && flag !== "s") return false;
        this.ws();
      }
    }
    if (s[this.i] !== "]") return false;
    this.i++;
    return true;
  }

  /** :name, ::name or :name(args). Args are checked for balance only, and
   *  must not be empty except in the forgiving :is() and :where(). */
  private pseudo(): boolean {
    this.i++;
    if (this.s[this.i] === ":") this.i++;
    const nameStart = this.i;
    if (!this.ident()) return false;
    if (this.s[this.i] !== "(") return true;
    const name = this.s.slice(nameStart, this.i).toLowerCase();
    const end = this.closingParen(this.i);
    if (end < 0) return false;
    const arg = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    return arg.trim() !== "" || name === "is" || name === "where";
  }

  /** Index of the ")" that closes the "(" at `open`, or -1. */
  private closingParen(open: number): number {
    let depth = 0;
    for (let j = open; j < this.s.length; j++) {
      const c = this.s[j];
      if (c === "\\") {
        j++;
      } else if (c === '"' || c === "'") {
        j = this.stringEnd(j);
        if (j < 0) return -1;
      } else if (c === "(") {
        depth++;
      } else if (c === ")" && --depth === 0) {
        return j;
      }
    }
    return -1;
  }

  private string(): boolean {
    const c = this.s[this.i];
    if (c !== '"' && c !== "'") return false;
    const end = this.stringEnd(this.i);
    if (end < 0) return false;
    this.i = end + 1;
    return true;
  }

  /** Index of the quote closing the string opened at `start`, or -1 (also
   *  for an unescaped newline, which ends a CSS string as a bad string). */
  private stringEnd(start: number): number {
    const q = this.s[start];
    for (let j = start + 1; j < this.s.length; j++) {
      const c = this.s[j];
      if (c === "\\") j++;
      else if (c === "\n" || c === "\r" || c === "\f") return -1;
      else if (c === q) return j;
    }
    return -1;
  }

  /** An identifier (CSS Syntax: an ident sequence that would start an
   *  identifier). Consumes nothing and returns false when there is none. */
  private ident(): boolean {
    let j = this.i;
    if (this.s[j] === "-") {
      j++;
      if (this.s[j] === "-") j++;
      else if (!this.nameStart(j) && !this.escape(j)) return false;
    } else if (!this.nameStart(j) && !this.escape(j)) {
      return false;
    }
    while (j < this.s.length) {
      if (this.escape(j)) j = this.escapeEnd(j);
      else if (this.nameStart(j) || this.digit(j) || this.s[j] === "-") j++;
      else break;
    }
    this.i = j;
    return true;
  }

  /** Letter, "_" or any non-ASCII code point. */
  private nameStart(j: number): boolean {
    const c = this.s.charCodeAt(j);
    return (
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x41 && c <= 0x5a) ||
      c === 0x5f ||
      c >= 0x80
    );
  }

  private digit(j: number): boolean {
    const c = this.s.charCodeAt(j);
    return c >= 0x30 && c <= 0x39;
  }

  private hex(j: number): boolean {
    const c = this.s.charCodeAt(j) | 0x20;
    return this.digit(j) || (c >= 0x61 && c <= 0x66);
  }

  private space(j: number): boolean {
    const c = this.s[j];
    return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  }

  /** A backslash that starts a valid escape (not followed by a newline). */
  private escape(j: number): boolean {
    if (this.s[j] !== "\\" || j + 1 >= this.s.length) return false;
    const n = this.s[j + 1];
    return n !== "\n" && n !== "\r" && n !== "\f";
  }

  /** Index just past the escape at `j`: up to six hex digits plus one
   *  optional whitespace, or the single escaped character. */
  private escapeEnd(j: number): number {
    let k = j + 1;
    if (!this.hex(k)) return k + 1;
    const max = k + 6;
    while (k < max && this.hex(k)) k++;
    if (this.s[k] === "\r" && this.s[k + 1] === "\n") return k + 2;
    return this.space(k) ? k + 1 : k;
  }

  /** Skip CSS whitespace; true when any was skipped. */
  private ws(): boolean {
    const start = this.i;
    while (this.space(this.i)) this.i++;
    return this.i > start;
  }
}
