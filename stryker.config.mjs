// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "command",
  // node:test has no Stryker plugin, so the suite runs as a command. `test:only`
  // skips the type-check `npm test` does first — a mutant that fails to compile
  // would count as killed without a single test having run.
  commandRunner: { command: "npm run test:only" },
  coverageAnalysis: "off",
  mutate: [
    "src/**/*.ts",
    // Wiring with no test of its own: mutating it only reports what we already
    // know and drowns out the score for the code that is covered.
    "!src/index.ts",
    // Metric declarations. Their values are asserted through the code that
    // writes them, which is where the mutants belong.
    "!src/metrics.ts",
  ],
  // Measured, not aspirational: the suite scores 65.34% today. `break` sits just
  // under it so the build fails on a regression, not on the log-message mutants
  // that make up most of what survives.
  thresholds: { high: 80, low: 65, break: 63 },
  incrementalFile: "reports/stryker-incremental.json",
  reporters: ["html", "json", "clear-text", "progress"],
  // A timeout counts as detected, so it must mean a hung mutant and never a
  // loaded machine: `node --test` already forks a process per file, and a
  // higher concurrency here starves them into timing out for no reason.
  timeoutMS: 10000,
  concurrency: 4,
};
