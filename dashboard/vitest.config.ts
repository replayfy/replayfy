import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Unit + component tests (`yarn test`). Built on the app's own Vite config so
// tests resolve the `@/` alias and transform TSX exactly as the app does.
// happy-dom gives React a DOM to mount the players into.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "happy-dom",
      include: ["src/**/*.test.{ts,tsx}"],
    },
  }),
);
