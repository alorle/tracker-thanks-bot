// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default defineConfig(
  // Replacement for .eslintignore — build output and deps.
  {
    ignores: ["dist/**", "node_modules/**"],
  },

  // Base recommended rules for all JS/TS files.
  js.configs.recommended,

  // Type-aware recommended rules for TypeScript sources.
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Plain JS (this config and any stray scripts) is not part of a TS
  // program, so disable type-aware linting there. TypeScript sources in
  // `src/` and `test/` are covered by their respective tsconfig projects.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Must be last: turns off rules that conflict with Prettier.
  eslintConfigPrettier,
);
