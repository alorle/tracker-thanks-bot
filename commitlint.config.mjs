export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Keep in sync with the changelog-sections in release-please-config.json.
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "perf", "deps", "revert", "docs", "build", "ci", "refactor", "test", "chore"],
    ],
  },
};
