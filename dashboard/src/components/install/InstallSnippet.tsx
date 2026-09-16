import { useState, type CSSProperties, type ReactNode } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
// Grammars for the SNIP snippets only (order matters: dependants load last —
// typescript needs javascript; jsx needs markup+javascript; tsx needs both).
import "prismjs/components/prism-markup";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-dart";
import "prismjs/components/prism-go";
import "prismjs/components/prism-python";
import { Icon, Select, type SelectOption } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import {
  PLATFORMS,
  SNIP,
  installIngestHost,
} from "@/routes/settings/settings.data";

/* SNIP `lang` label → Prism grammar key (falls back to clike). */
const PRISM_LANG: Record<string, string> = {
  HTML: "markup",
  TSX: "tsx",
  TS: "typescript",
  Swift: "swift",
  Kotlin: "kotlin",
  Dart: "dart",
  Go: "go",
  Python: "python",
  JS: "javascript",
};

/* Grouped platform options for the editor-toolbar selector (SET3b). */
const PLAT_OPTIONS: SelectOption[] = [
  { header: "Web" },
  ...PLATFORMS.filter((p) => p.group === "Web").map((p) => ({
    value: p.id,
    label: p.label,
  })),
  { divider: true },
  { header: "Mobile" },
  ...PLATFORMS.filter((p) => p.group === "Mobile").map((p) => ({
    value: p.id,
    label: p.label,
  })),
];

/* Per-platform hints for the "Copy AI prompt" button: what to install, the one
   framework gotcha, and the docs slug. The generated prompt embeds the LIVE
   snippet (real publishable key) so a coding agent can wire the SDK with no
   hand-editing. */
const AGENT_META: Record<
  string,
  { name: string; install: string; note: string; docs: string }
> = {
  web: {
    name: "the Replayfy web SDK (script tag)",
    install: "no package to install — it loads from the CDN in the snippet below",
    note: "It's a plain <script> tag — add it to the <head> so it loads on every page.",
    docs: "platforms/web",
  },
  react: {
    name: "the Replayfy web SDK in a React app",
    install: "install @replayfyapp/browser (npm / yarn / pnpm)",
    note: "Initialize once in a top-level client effect (e.g. a root useEffect) — never during SSR.",
    docs: "platforms/web",
  },
  next: {
    name: "the Replayfy web SDK in a Next.js app",
    install: "install @replayfyapp/browser (npm / yarn / pnpm)",
    note: 'Put the init in a "use client" component rendered once from app/layout.tsx — it must run in the browser, not during server rendering.',
    docs: "platforms/web",
  },
  vue: {
    name: "the Replayfy web SDK in a Vue app",
    install: "install @replayfyapp/browser (npm / yarn / pnpm)",
    note: "Initialize once in your app entry (main.ts) before mounting the app.",
    docs: "platforms/web",
  },
  rn: {
    name: "the Replayfy React Native SDK",
    install: "install @replayfyapp/react-native, then run `cd ios && pod install`",
    note: "Call Replay.start() once at the app root.",
    docs: "platforms/react-native",
  },
  swift: {
    name: "the Replayfy iOS (Swift) SDK",
    install: "add the Replay package via Swift Package Manager",
    note: "Call Replay.start(with:) once in your App init or AppDelegate.",
    docs: "platforms/ios",
  },
  android: {
    name: "the Replayfy Android SDK",
    install: "add the JitPack dependency com.replayfy.android in Gradle",
    note: "Call Replay.init() once in Application.onCreate().",
    docs: "platforms/android",
  },
  flutter: {
    name: "the Replayfy Flutter SDK",
    install: "add replayfy_flutter to pubspec.yaml, then run `flutter pub get`",
    note: "await Replay.start() once in main() before runApp().",
    docs: "platforms/flutter",
  },
};

/* Build a paste-ready prompt for a coding agent (Cursor, Claude Code, …): what
   to install, the exact config with the workspace's REAL key, and the framework
   gotcha — so "set up Replayfy" becomes a one-paste job for the user's agent. */
function buildAgentPrompt(platform: string, snippet: string): string {
  const m = AGENT_META[platform] ?? AGENT_META.web;
  return [
    "Set up Replayfy in this project — it adds session replay + product analytics.",
    "",
    `Target: ${m.name}.`,
    "",
    "Steps:",
    `1. Install: ${m.install}.`,
    "2. Initialize the SDK as early as possible in the app's entry point, following this project's existing structure and conventions. Use exactly this configuration (the apiKey below is my real publishable key):",
    "",
    snippet,
    "",
    "Rules:",
    "- apiKey is a publishable CLIENT key — safe to ship in client code. Use it exactly as shown.",
    `- Keep apiHost as "${installIngestHost()}".`,
    `- ${m.note}`,
    "- Initialize only ONCE for the whole app; don't add any other dependencies, secrets, or config.",
    "",
    "When you're done, tell me which files you changed and how to confirm a session shows up in my Replayfy dashboard under Recordings.",
    "",
    `Docs: https://docs.replayfy.app/${m.docs}`,
  ].join("\n");
}

type Props = {
  platform: string;
  onPlatform: (v: string) => void;
  /** Snippet source override — onboarding swaps the fixture project id in
   *  SNIP for the workspace's real key. Copy follows what's rendered. */
  code?: string;
  /** Extra toolbar content, between the spacer and the language chip
   *  (onboarding puts its region endpoint there). */
  headerExtra?: ReactNode;
  /** Language chip + filename. Settings shows them as file context; onboarding
   *  wants the bar down to the picker and Copy, so nothing competes with the
   *  one thing you're there to do. */
  showMeta?: boolean;
  style?: CSSProperties;
};

/* The SDK install card: platform picker + language chip + filename + copy, over
   a dark-themed read-only Prism editor. Shared verbatim by Settings → Install
   and the onboarding install step so the two can't drift apart. */
export function InstallSnippet({
  platform,
  onPlatform,
  code,
  headerExtra,
  showMeta = true,
  style,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const toast = useToast();
  const snip = SNIP[platform];
  const lang = PRISM_LANG[snip.lang] ?? "clike";
  const src = code ?? snip.code;

  // Copy the current snippet to the clipboard with a 1.5s confirmation swap.
  const copyCode = () => {
    try {
      navigator.clipboard?.writeText(src);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast && toast("Couldn't copy", { kind: "err" });
    }
  };

  // Copy a paste-ready setup prompt for the user's AI coding agent — same live
  // snippet (real key), wrapped in instructions so the agent installs + wires the
  // SDK itself. Built from the CURRENTLY selected platform.
  const copyPrompt = () => {
    try {
      navigator.clipboard?.writeText(buildAgentPrompt(platform, src));
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1500);
    } catch {
      toast && toast("Couldn't copy", { kind: "err" });
    }
  };

  return (
    <div className="ins-code" style={style}>
      <div className="ins-code-h">
        <div className="ins-plat-sel">
          <Select
            value={platform}
            options={PLAT_OPTIONS}
            onChange={onPlatform}
            width={168}
            menuClass="ins-plat-menu"
          />
        </div>
        <span style={{ flex: 1 }} />
        {headerExtra}
        {showMeta && <span className="ins-lang">{snip.lang}</span>}
        {showMeta && <span className="ins-title mono">{snip.title}</span>}
        <button
          className="ins-copy ins-ai"
          onClick={copyPrompt}
          title="Copy a setup prompt for your AI coding agent (Cursor, Claude Code, …) — it installs and wires the SDK for you"
        >
          {copiedPrompt ? (
            <>
              <Icon name="check" size={12} /> Copied
            </>
          ) : (
            <>
              <Icon name="sparkle" size={12} /> Copy AI prompt
            </>
          )}
        </button>
        <button className="ins-copy" onClick={copyCode} title="Copy code">
          {copied ? (
            <>
              <Icon name="check" size={12} /> Copied
            </>
          ) : (
            <>
              <Icon name="copy" size={12} /> Copy
            </>
          )}
        </button>
      </div>
      <Editor
        value={src}
        readOnly
        onValueChange={() => {}}
        highlight={(c) =>
          Prism.highlight(c, Prism.languages[lang] || Prism.languages.clike, lang)
        }
        padding={16}
        className="ins-editor"
        textareaClassName="ins-editor-ta"
        style={{ fontFamily: "var(--ide-mono)", fontSize: "var(--text-sm)", lineHeight: "var(--lh-loose)" }}
      />
    </div>
  );
}
