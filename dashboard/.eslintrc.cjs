module.exports = {
  root: true,
  env: { browser: true, es2021: true },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  plugins: ["react-refresh"],
  ignorePatterns: ["dist", "_legacy", "node_modules", "*.config.*"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "off",
    // Ported verbatim from the approved prototype, which has intentional empty
    // catch/no-op blocks — don't error on them (behavior must stay identical).
    "no-empty": "off",
    // react-hooks/recommended stays ON — it catches the Rules-of-Hooks bug we fixed.
  },
};
