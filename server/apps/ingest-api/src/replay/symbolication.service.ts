import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StorageService } from "../storage/storage.service";

/**
 * Server-side deobfuscation of mobile crash / ANR stacks.
 *
 * # Why server-side
 *
 * Mobile SDKs ship raw frames — R8-obfuscated class names on
 * Android, hex program counters on NDK + iOS. The customer
 * uploads symbols (mapping.txt for R8; unstripped .so debug
 * binaries for NDK) via the `com.replayfy.symbols` Gradle plugin
 * or manually via `POST /v1/replay/symbols/...`. Symbolication
 * happens HERE at render time rather than ingest time because:
 *
 *   1. Symbols may upload AFTER crashes already arrived — eg a
 *      production crash spike hits before the customer notices +
 *      uploads the mapping. Deferring symbolication lets old
 *      crashes light up later when symbols land.
 *   2. Some crashes never need symbolication (the dashboard's
 *      list view shows obfuscated class names + counts; only the
 *      detail view does the work).
 *   3. Re-symbolication with an updated mapping (re-uploaded after
 *      a hotfix) just works — no data migration.
 *
 * # How it works
 *
 * ## Android JVM (R8 / Proguard)
 *
 * R8's `mapping.txt` is a plain-text bidirectional rename map. The
 * format is well-documented + a tiny subset is enough to deobfuscate
 * stack traces:
 *
 *     com.example.MyClass -> a.b.c:
 *         java.lang.String myField -> a
 *         42:42:void myMethod():123 -> b
 *
 * We parse the relevant subset (class renames + method renames with
 * line-number ranges) in-process and apply it line-by-line to the
 * incoming stack. No external tool needed — R8's `retrace` CLI does
 * the same parse internally; we replicate the small subset to avoid
 * shelling out + the JVM startup cost.
 *
 * ## Android NDK (.so debug binaries)
 *
 * Native crashes ship raw PCs like `0x0000007fa12b4f8c`. The
 * uploaded `lib<name>.<abi>.so` files contain DWARF debug info we
 * can resolve those addresses against. We use `llvm-symbolizer`
 * (bundled with the NDK; the dashboard's deploy image installs it)
 * via stdin/stdout — pipe in `<binary> <address>` lines, get
 * `function\nfile:line` back.
 *
 * Falls back to leaving the raw hex untouched when llvm-symbolizer
 * isn't available (local dev without the toolchain installed) —
 * the dashboard renders the raw stack with a "symbolicator not
 * configured" notice in that case.
 *
 * ## iOS (dSYM) — reserved
 *
 * iOS crashes already arrive partially symbolicated via
 * PLCrashReporter (Mach binary + offset). Full deobfuscation against
 * dSYMs is a v2 item; reserved here so the API shape doesn't need
 * to change later.
 *
 * # Caching
 *
 * Per-workspace + per-version LRU. mapping.txt parses are
 * memoized into the parsed-renames map (the expensive bit), so
 * repeated symbolications of the same crash signature hit memory.
 * Cap: 50 versions × 2 platforms per process; oldest evicted.
 */

interface ParsedMapping {
  /**
   * Forward map for class names: `a.b.c` → `com.example.MyClass`.
   * R8's format is reversed from what we want — the on-disk shape
   * is `original -> obfuscated`; we build the inverse for lookup.
   */
  classes: Map<string, string>;
  /**
   * Per-class method maps:
   *   classes-obfuscated-name → (method-obfuscated → method-original-name)
   *
   * Method maps include line-range info in the original `mapping.txt`
   * but for the dashboard's stack view, the original method name is
   * the high-value piece; we drop the line-range complexity to keep
   * this fast. Re-add if customers ask for precise inlining.
   */
  methods: Map<string, Map<string, string>>;
}

interface SymbolicationKey {
  workspaceId: number;
  platform: "android" | "ios";
  version: string;
  build: string;
}

@Injectable()
export class SymbolicationService implements OnModuleInit {
  private readonly logger = new Logger(SymbolicationService.name);

  /** Per-(workspace, platform, version, build) parsed-mapping cache.
   *  Key shape matches the R2 path prefix. Capped at 100 entries
   *  total — oldest evicted via Map insertion order. */
  private readonly mappingCache = new Map<string, ParsedMapping>();
  private static readonly MAX_CACHED_MAPPINGS = 100;

  /** Cap on the number of .so files kept warm on disk per process.
   *  llvm-symbolizer needs a real file to mmap so we can't hold the
   *  binaries purely in memory; the disk cache lives under
   *  `soCacheDir` (created in ``onModuleInit``) and is LRU-evicted
   *  by mtime once over this cap. 20 ≈ ~500 MB worst case at 25 MB
   *  per `.so`. */
  private static readonly MAX_CACHED_SO = 20;
  private soCacheDir: string | null = null;

  /** Resolved path to `llvm-symbolizer` on the host. Null when the
   *  binary isn't installed — native symbolication falls back to a
   *  pass-through in that case. Resolved once at boot. */
  private llvmSymbolizerPath: string | null = null;

  constructor(private readonly storage: StorageService) {}

  /** Resolve llvm-symbolizer + log a one-time status on boot so
   *  ops can tell at a glance whether native symbolication is
   *  active. NestJS calls this automatically after module init. */
  async onModuleInit(): Promise<void> {
    this.llvmSymbolizerPath = await this.findLlvmSymbolizer();
    if (this.llvmSymbolizerPath) {
      this.logger.log(
        `Native (NDK) symbolication ENABLED via ${this.llvmSymbolizerPath}`,
      );
    } else {
      this.logger.warn(
        "Native (NDK) symbolication DISABLED — `llvm-symbolizer` not found on PATH. " +
          "Install via `brew install llvm` (macOS) or `apt-get install llvm` (Debian/Ubuntu) " +
          "to deobfuscate Android NDK crash stacks. JVM (R8 mapping.txt) " +
          "symbolication is unaffected.",
      );
    }
    // Lazy-create the on-disk .so cache dir. We delete it on
    // process exit via OS cleanup; the binaries are reproducible
    // from R2 so a fresh dir on each boot is fine.
    try {
      this.soCacheDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "replayfy-syms-"),
      );
    } catch (err) {
      this.logger.warn(`failed to create .so cache dir: ${String(err)}`);
    }
  }

  /** Search common install locations for llvm-symbolizer. Returns
   *  the resolved absolute path, or null when none of the
   *  candidates exist. */
  private async findLlvmSymbolizer(): Promise<string | null> {
    const candidates = [
      // Linux production deploy — `apt-get install llvm` drops the
      // binary at /usr/bin/llvm-symbolizer.
      "/usr/bin/llvm-symbolizer",
      "/usr/local/bin/llvm-symbolizer",
      // macOS local-dev via Homebrew (`brew install llvm`).
      "/opt/homebrew/opt/llvm/bin/llvm-symbolizer", // Apple Silicon
      "/opt/homebrew/bin/llvm-symbolizer",
      "/usr/local/opt/llvm/bin/llvm-symbolizer", // Intel
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep searching */
      }
    }
    return null;
  }

  /**
   * Deobfuscate a single JVM stack trace string. Pure text-in /
   * text-out so the caller (sessions service, crash detail
   * endpoint) doesn't need to know about R2 / parsing internals.
   *
   * Returns the input unchanged when:
   *   - storage isn't configured (local dev)
   *   - mapping.txt not uploaded for this (version, build)
   *   - the stack doesn't match any known obfuscated names
   *
   * Never throws — symbolication failures must not block the
   * dashboard render.
   */
  async symbolicateJvmStack(
    key: SymbolicationKey,
    rawStack: string,
  ): Promise<string> {
    try {
      const mapping = await this.loadMapping(key);
      if (!mapping) return rawStack;
      return this.applyMapping(rawStack, mapping);
    } catch (err) {
      this.logger.warn(
        `symbolicateJvmStack failed (${key.platform}/${key.version}+${key.build}): ${String(err)}`,
      );
      return rawStack;
    }
  }

  /**
   * Best-effort symbolication of a native NDK stack. Looks up each
   * frame's PC against the uploaded `.so` debug binary via
   * `llvm-symbolizer`. Frames whose binary isn't uploaded stay
   * as the raw hex.
   *
   * The input format matches what `replay_signal_handler.c` writes:
   *
   *     Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0 on thread 'main'
   *       at 0x0000007fa12b4f8c
   *       at 0x0000007fa12b51b0
   *
   * Returns the input unchanged when no `.so` files are uploaded or
   * llvm-symbolizer isn't available.
   *
   * Implementation:
   *   1. Parse each `  at 0x<hex>` PC out of the raw stack.
   *   2. Pick the matching `.so` debug binary from R2 (cached to
   *      disk so llvm-symbolizer can mmap it).
   *   3. spawn `llvm-symbolizer --obj=<path> --demangle` and pipe
   *      the addresses on stdin. Read `function\nfile:line\n` back
   *      per frame.
   *   4. Substitute each "  at 0x…" line with
   *      "  at <function> (<file>:<line>)".
   *
   * Falls back to the raw stack when llvm-symbolizer isn't on the
   * host (logged at boot) or when the `.so` for the crash's ABI
   * hasn't been uploaded.
   */
  async symbolicateNativeStack(
    key: SymbolicationKey,
    rawStack: string,
  ): Promise<string> {
    if (!this.llvmSymbolizerPath) return rawStack;
    if (key.platform !== "android") return rawStack;
    // Parse PCs + identify which .so binary they came from. The
    // SDK's signal_handler.c writes pure hex PCs with no binary
    // context — for v1 we resolve every PC against EVERY uploaded
    // .so and pick the first one that returns a non-?? symbol.
    // Future: ship the loaded-module map from the signal handler
    // so we can route addresses to specific binaries.
    const lines = rawStack.split("\n");
    const pcIndices: number[] = [];
    const pcs: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*at\s+(0x[0-9a-fA-F]+)\s*$/.exec(lines[i]);
      if (m) {
        pcIndices.push(i);
        pcs.push(m[1]);
      }
    }
    if (pcs.length === 0) return rawStack;

    // Try each uploaded .so for this version against the PC list
    // and merge the best results. Per-PC "best" = first non-?? hit.
    const soPaths = await this.listCachedSoForVersion(key);
    if (soPaths.length === 0) return rawStack;

    const resolved: Array<string | null> = new Array(pcs.length).fill(null);
    for (const soPath of soPaths) {
      const lookup = await this.runLlvmSymbolizer(soPath, pcs);
      for (let i = 0; i < pcs.length; i++) {
        if (!resolved[i] && lookup[i]) resolved[i] = lookup[i];
      }
      // Early exit when every PC has been resolved.
      if (resolved.every(Boolean)) break;
    }

    // Splice resolved frames back into the stack lines.
    for (let i = 0; i < pcIndices.length; i++) {
      const sym = resolved[i];
      if (!sym) continue;
      lines[pcIndices[i]] = `  at ${sym}`;
    }
    return lines.join("\n");
  }

  /** Download every `.so` we have on R2 for this (version, build)
   *  into the on-disk cache + return their paths. Idempotent
   *  per-process — cache hits skip the R2 round-trip. */
  private async listCachedSoForVersion(
    key: SymbolicationKey,
  ): Promise<string[]> {
    if (!this.soCacheDir) return [];
    // We don't have a list-objects helper on StorageService, so we
    // probe the four ABIs we accept on upload. Cheap (404 returns
    // ~10ms) + bounded.
    const abis = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"];
    const paths: string[] = [];
    // Without a known set of `.so` library names, we can't probe by
    // exact filename. So we cache whatever was already pulled. The
    // first time a native crash for a version arrives we have no
    // .so paths; the upload pipeline is expected to deliver them
    // separately + a subsequent symbolicate request picks them up.
    // For now: walk the cache dir for files matching the version
    // prefix.
    const prefix = `${key.workspaceId}.${key.platform}.${key.version}.${key.build}.`;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.soCacheDir);
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (entry.startsWith(prefix) && entry.endsWith(".so")) {
        paths.push(path.join(this.soCacheDir, entry));
      }
    }
    // If nothing cached yet, lazy-download by ABI — best-effort,
    // no list endpoint available. We try the convention
    // `libnative-lib.<abi>.so` first since it's the AGP default
    // for the most common single-library setup.
    if (paths.length === 0) {
      const guessNames = ["libnative-lib"];
      for (const name of guessNames) {
        for (const abi of abis) {
          const filename = `${name}.${abi}.so`;
          const r2Key = `replay-symbols/${key.workspaceId}/android/${key.version}/${key.build}/${filename}`;
          const bytes = await this.storage.download(r2Key);
          if (!bytes) continue;
          const localPath = path.join(
            this.soCacheDir,
            `${prefix}${filename}`,
          );
          await fs.writeFile(localPath, bytes);
          paths.push(localPath);
          this.evictSoCacheIfFull();
        }
      }
    }
    return paths;
  }

  /** LRU-evict .so files on disk so the cache dir doesn't grow
   *  unbounded. */
  private async evictSoCacheIfFull(): Promise<void> {
    if (!this.soCacheDir) return;
    try {
      const entries = await fs.readdir(this.soCacheDir);
      if (entries.length <= SymbolicationService.MAX_CACHED_SO) return;
      // Sort by mtime ascending; drop the oldest until under cap.
      const stats = await Promise.all(
        entries.map(async (e) => ({
          name: e,
          mtime: (await fs.stat(path.join(this.soCacheDir!, e))).mtimeMs,
        })),
      );
      stats.sort((a, b) => a.mtime - b.mtime);
      const overflow = stats.length - SymbolicationService.MAX_CACHED_SO;
      for (let i = 0; i < overflow; i++) {
        await fs.unlink(path.join(this.soCacheDir, stats[i].name));
      }
    } catch {
      /* best-effort */
    }
  }

  /** Pipe a list of hex addresses into `llvm-symbolizer` and parse
   *  the function\nfile:line\n response per frame. Returns one
   *  formatted string per input PC ("function (file:line)") or
   *  null when the symbolizer reported "??" for that frame. */
  private runLlvmSymbolizer(
    soPath: string,
    pcs: string[],
  ): Promise<Array<string | null>> {
    return new Promise((resolve) => {
      if (!this.llvmSymbolizerPath) return resolve(pcs.map(() => null));
      const args = [`--obj=${soPath}`, "--demangle", "--functions=linkage"];
      const child = spawn(this.llvmSymbolizerPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString("utf-8");
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += b.toString("utf-8");
      });
      child.on("error", () => {
        // spawn failure (binary disappeared, permissions) — caller
        // gets a fully-null array.
        resolve(pcs.map(() => null));
      });
      child.on("close", () => {
        if (stderr) {
          this.logger.debug(`llvm-symbolizer stderr: ${stderr.trim()}`);
        }
        // Output is paragraph-per-input separated by a blank line.
        // Each paragraph is `function\nfile:line\n`.
        const paragraphs = stdout.split(/\n\n+/).filter(Boolean);
        const out: Array<string | null> = [];
        for (let i = 0; i < pcs.length; i++) {
          const p = paragraphs[i];
          if (!p) {
            out.push(null);
            continue;
          }
          const [fn, loc] = p.split("\n");
          if (!fn || fn === "??") {
            out.push(null);
            continue;
          }
          const cleanLoc =
            loc && loc !== "??:0" && loc !== "??:?" ? ` (${loc})` : "";
          out.push(`${fn}${cleanLoc}`);
        }
        resolve(out);
      });
      // Write one address per line, then close stdin so the child
      // knows the input is complete.
      for (const pc of pcs) {
        child.stdin.write(`${pc}\n`);
      }
      child.stdin.end();
    });
  }

  /**
   * Convenience wrapper — picks the right symbolicator based on the
   * crash record's `kind`. JVM uncaught exceptions go through
   * symbolicateJvmStack; signal / native crashes go through
   * symbolicateNativeStack.
   */
  async symbolicate(
    key: SymbolicationKey,
    crashKind: string,
    rawStack: string,
  ): Promise<string> {
    if (crashKind === "signal") {
      return this.symbolicateNativeStack(key, rawStack);
    }
    return this.symbolicateJvmStack(key, rawStack);
  }

  // -------------------------------------------------------------------
  //  mapping.txt — fetch + parse
  // -------------------------------------------------------------------

  private async loadMapping(
    key: SymbolicationKey,
  ): Promise<ParsedMapping | null> {
    const cacheKey = this.makeCacheKey(key, "mapping.txt");
    const cached = this.mappingCache.get(cacheKey);
    if (cached) {
      // Re-insert so LRU position resets.
      this.mappingCache.delete(cacheKey);
      this.mappingCache.set(cacheKey, cached);
      return cached;
    }

    if (key.platform !== "android") return null;

    const r2Key = `replay-symbols/${key.workspaceId}/android/${key.version}/${key.build}/mapping.txt`;
    const bytes = await this.storage.download(r2Key);
    if (!bytes) return null;

    const parsed = this.parseMapping(bytes.toString("utf-8"));
    // Evict oldest if over cap.
    if (this.mappingCache.size >= SymbolicationService.MAX_CACHED_MAPPINGS) {
      const oldestKey = this.mappingCache.keys().next().value;
      if (oldestKey) this.mappingCache.delete(oldestKey);
    }
    this.mappingCache.set(cacheKey, parsed);
    return parsed;
  }

  /**
   * Parse the minimal subset of R8's `mapping.txt` format we need to
   * deobfuscate stack traces. The format spec is at
   * https://r8.googlesource.com/r8/+/refs/heads/main/doc/mapping.md.
   *
   * Each top-level entry looks like:
   *
   *     com.example.Original -> a.b.c:
   *         42:42:void method(...):123 -> d
   *         field-decl-line:field-end-line:type fieldName -> e
   *
   * We extract:
   *   - The class rename (`com.example.Original` ↔ `a.b.c`).
   *   - Method renames keyed by class.
   *
   * We IGNORE line-range info (the `42:42:` prefix) for the v1
   * implementation — most crash-stack viewers show the obfuscated
   * line numbers anyway, and the method-name + class-name deobfuscation
   * delivers the 80% UX win. Re-add inlining support if customers ask.
   */
  private parseMapping(text: string): ParsedMapping {
    const classes = new Map<string, string>();
    const methods = new Map<string, Map<string, string>>();
    let currentObfClass: string | null = null;

    for (const line of text.split("\n")) {
      if (line.startsWith("#")) continue; // comments / metadata
      if (!line) continue;
      // Top-level class line is unindented; member lines are indented.
      if (!line.startsWith(" ") && !line.startsWith("\t")) {
        // Format: `<original> -> <obfuscated>:` with optional metadata
        // suffix after the colon we don't care about.
        const m = /^([^ ]+)\s*->\s*([^ :]+)\s*:/.exec(line);
        if (!m) {
          currentObfClass = null;
          continue;
        }
        const originalClass = m[1];
        const obfClass = m[2];
        classes.set(obfClass, originalClass);
        currentObfClass = obfClass;
        if (!methods.has(obfClass)) methods.set(obfClass, new Map());
      } else if (currentObfClass) {
        // Member line. Format examples:
        //   "    42:42:void doThing():123 -> a"
        //   "    int someField -> a"
        // We only care about methods — line-number prefix is the
        // discriminator. Methods always have a `(` in the name.
        const trimmed = line.trim();
        const m = /->\s*([A-Za-z_$][A-Za-z_$0-9]*)\s*$/.exec(trimmed);
        if (!m) continue;
        const obfMember = m[1];
        const lhs = trimmed.substring(0, trimmed.lastIndexOf("->")).trim();
        // Strip any leading "<lineFrom>:<lineTo>:" prefix.
        const stripped = lhs.replace(/^\d+:\d+:/, "");
        // Methods have a `(` in their signature.
        if (!stripped.includes("(")) continue;
        // Extract just the method name — drop the return type prefix
        // and parameter list.
        // Examples after the prefix strip:
        //   "void doThing()"
        //   "int compute(int,int)"
        //   "java.lang.String getName()"
        const nameMatch =
          /([A-Za-z_$][A-Za-z_$0-9]*|<init>|<clinit>)\s*\(/.exec(stripped);
        const originalName = nameMatch?.[1];
        if (!originalName) continue;
        methods.get(currentObfClass)!.set(obfMember, originalName);
      }
    }

    return { classes, methods };
  }

  /**
   * Apply a parsed mapping to a stack trace string. Operates
   * line-by-line so the per-frame structure stays preserved (the
   * dashboard renders these as code blocks).
   *
   * Recognised line shapes:
   *   - `at a.b.c.d(SourceFile:42)` — standard Java stack frame
   *   - `at a.b.c.d(:42)` — variant without filename
   *   - bare class names mid-message, eg
   *     `a.b.c$Builder.build(...)` — we deobfuscate class portion
   *
   * Any line we can't match → passed through unchanged.
   */
  private applyMapping(rawStack: string, mapping: ParsedMapping): string {
    const lines = rawStack.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      out.push(this.deobfLine(line, mapping));
    }
    return out.join("\n");
  }

  private deobfLine(line: string, mapping: ParsedMapping): string {
    // Match a Java stack-frame: `<prefix>at <pkg.Cls$Inner>.<method>(<rest>)`
    const frame = /^(\s*at\s+)([\w$.]+)\.([\w$<>]+)\((.*)\)\s*$/.exec(line);
    if (frame) {
      const [, prefix, obfClass, obfMethod, rest] = frame;
      const originalClass = mapping.classes.get(obfClass);
      // Look up the method against the obfuscated class name —
      // mapping.txt keys methods by their obfuscated owner.
      const originalMethod =
        mapping.methods.get(obfClass)?.get(obfMethod) ?? obfMethod;
      if (originalClass) {
        return `${prefix}${originalClass}.${originalMethod}(${rest})`;
      }
    }
    // Bare class names in exception messages. Best-effort substitute
    // every known obfuscated class token. Skipped when the mapping
    // is small (< 1000 classes) since the lookup is per-token.
    // For larger mappings we'd want a precompiled regex; revisit
    // when a customer reports a >50ms render time.
    let result = line;
    for (const [obf, original] of mapping.classes) {
      if (!result.includes(obf)) continue;
      // Use a word-boundary regex so `a.b.c` doesn't match within
      // `a.b.cd` or any superstring.
      result = result.replace(
        new RegExp(`\\b${this.escapeRegex(obf)}\\b`, "g"),
        original,
      );
    }
    return result;
  }

  private makeCacheKey(key: SymbolicationKey, filename: string): string {
    return `${key.workspaceId}/${key.platform}/${key.version}/${key.build}/${filename}`;
  }

  /** Regex-escape a literal string so it can be embedded in
   *  `new RegExp(...)` without `*` / `.` / etc. being interpreted
   *  as metachars. Used by `deobfLine` when substituting bare
   *  obfuscated class names in exception messages. */
  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
