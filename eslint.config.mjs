import js from "@eslint/js";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The suites read the package's own source by path (tripwires and the no-app-literal scan).
    files: ["tests/**/*.ts"],
    rules: { "security/detect-non-literal-fs-filename": "off" },
  },
);
