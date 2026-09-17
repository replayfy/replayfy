/**
 * SDK install snippets for the `sdk.install` capability. Static templates that
 * mirror the dashboard's Install panel, so the agent hands a user the SAME code
 * they'd copy from Settings → Install — never a divergent one.
 *
 * SECURITY / SCOPE: these carry a PLACEHOLDER project key, never a real one. The
 * capability points the user at Settings to read their own key; it does not mint,
 * reveal, or embed a secret. The `rpl_pk_` project key is a publishable client key
 * by design (it ships in a <script> tag), but even that we leave as a placeholder
 * so there is one obvious "get your key here" step.
 */

/** Replaced by the user with their own key from Settings → Install. */
export const SDK_PROJECT_PLACEHOLDER = "rpl_pk_YOUR_PROJECT_KEY";

/** Where a user reads or creates their keys. Never done by the agent. */
export const SDK_KEYS_SETTINGS_PATH = "/settings/install";

const P = SDK_PROJECT_PLACEHOLDER;
/** Ingest host the SDK sends to (shown in every snippet, mirrors the dashboard).
 *  Derives from this API's own public origin so a self-hosted instance hands out
 *  snippets pointing at itself; override with API_BASE_URL. */
const H = process.env.API_BASE_URL || "https://us.replayfy.app";
/** URL of the web-SDK loader script. Self-hosters can keep the public CDN (the
 *  published SDK works against any host) or override with SDK_CDN_URL. */
const CDN =
  process.env.SDK_CDN_URL || "https://cdn.replayfy.app/v1/replay.global.js";

export interface SdkPlatform {
  label: string;
  /** All current Replayfy SDKs are client-side — they record sessions in the
   *  browser or app. (There is no separate server SDK yet.) */
  kind: "client";
  install: string;
  snippet: string;
}

export const SDK_PLATFORMS: Record<string, SdkPlatform> = {
  web: {
    label: "Web (script tag)",
    kind: "client",
    install: "Paste before </head> on every page.",
    snippet: `<script src="${CDN}"></script>
<script>
  Replayfy.init({
    apiKey: '${P}',
    apiHost: '${H}',
  });
</script>`,
  },
  react: {
    label: "React",
    kind: "client",
    install: "npm i @replayfyapp/browser — then init once on the client.",
    snippet: `import { useEffect } from 'react';
import { initReplay } from '@replayfyapp/browser';

export default function App() {
  useEffect(() => {
    initReplay({ apiKey: '${P}', apiHost: '${H}' });
  }, []);

  return <YourApp />;
}`,
  },
  next: {
    label: "Next.js",
    kind: "client",
    install: "npm i @replayfyapp/browser — then init from a client component.",
    snippet: `'use client';
import { useEffect } from 'react';
import { initReplay } from '@replayfyapp/browser';

export function Replayfy() {
  useEffect(() => {
    initReplay({ apiKey: '${P}', apiHost: '${H}' });
  }, []);
  return null;
}
// Render <Replayfy /> once in app/layout.tsx`,
  },
  vue: {
    label: "Vue",
    kind: "client",
    install: "npm i @replayfyapp/browser — then init in main.ts.",
    snippet: `import { createApp } from 'vue';
import { initReplay } from '@replayfyapp/browser';
import App from './App.vue';

initReplay({ apiKey: '${P}', apiHost: '${H}' });

createApp(App).mount('#app');`,
  },
  "react-native": {
    label: "React Native",
    kind: "client",
    install: "npm i @replayfyapp/react-native && cd ios && pod install",
    snippet: `import Replay from '@replayfyapp/react-native';

Replay.start({ apiKey: '${P}', apiHost: '${H}' });

export default function App() {
  return <RootStack />;
}`,
  },
  ios: {
    label: "iOS (Swift)",
    kind: "client",
    install:
      "Add the Replayfy Swift package (github.com/replayfy/ios-sdk), then start it.",
    snippet: `import Replay

Replay.start(with: ReplayConfig(
  apiKey: "${P}",
  apiHost: "${H}"
))`,
  },
  android: {
    label: "Android (Kotlin)",
    kind: "client",
    install:
      "Add JitPack + com.github.replayfy:android-sdk, then start it in Application.onCreate.",
    snippet: `import com.replayfy.android.Replay
import com.replayfy.android.ReplayConfig

Replay.init(
  this,
  ReplayConfig(
    apiKey = "${P}",
    apiHost = "${H}",
  ),
)`,
  },
  flutter: {
    label: "Flutter",
    kind: "client",
    install: "flutter pub add replayfy_flutter — then start it in main().",
    snippet: `import 'package:replayfy_flutter/replayfy_flutter.dart';

await Replay.start(const ReplayConfig(
  apiKey: '${P}',
  apiHost: '${H}',
));`,
  },
};

/** Loose platform aliases → canonical key, so "reactnative"/"rn"/"kotlin" resolve. */
const ALIASES: Record<string, string> = {
  js: "web",
  javascript: "web",
  html: "web",
  script: "web",
  nextjs: "next",
  rn: "react-native",
  reactnative: "react-native",
  expo: "react-native",
  swift: "ios",
  ios: "ios",
  iphone: "ios",
  kotlin: "android",
  java: "android",
  dart: "flutter",
};

export function resolveSdkPlatform(input: string | undefined): string | null {
  if (!input) return null;
  const k = input.trim().toLowerCase().replace(/[\s._]+/g, "-");
  if (SDK_PLATFORMS[k]) return k;
  const alias = ALIASES[k.replace(/-/g, "")] ?? ALIASES[k];
  return alias && SDK_PLATFORMS[alias] ? alias : null;
}
