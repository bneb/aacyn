// @ts-check
/**
 * StrykerJS mutation testing configuration.
 *
 * Uses @hughescr/stryker-bun-runner to run mutations via Bun's test runner.
 * Run with: bun run test:mutation  (from ts/ directory)
 * Or:       bunx stryker run
 *
 * Mutation operators (matching CLAUDE.md spec):
 *   equality, logical, conditional, string, array, block
 * All other mutator types are excluded via excludedMutations.
 *
 * Thresholds start lenient (break: 0) — ratchet up over time
 * as test coverage improves.
 *
 * Requires:
 *   - Bun >= 1.3.7 (for @hughescr/stryker-bun-runner Inspector Protocol)
 *   - @stryker-mutator/core ^9.0.0
 *   - @hughescr/stryker-bun-runner ^1.2.2
 *
 * Pre-existing test failures (3 tests) will cause the initial dry run
 * to fail. This is tracked separately — fix those before expecting
 * mutation results.
 */

/** @type {import('@stryker-mutator/core').StrykerOptions} */
const config = {
  // ── Test Runner ────────────────────────────────────────────────────────
  testRunner: 'bun',
  plugins: ['@hughescr/stryker-bun-runner'],

  // ── Coverage ───────────────────────────────────────────────────────────
  // Use 'off' — test runner handles its own coverage.
  // Switch to 'perTest' once initial test failures are resolved.
  coverageAnalysis: 'off',

  // ── Files to Mutate ────────────────────────────────────────────────────
  mutate: [
    'apps/api/src/lib/**/*.ts',
    'apps/api/src/routes/**/*.ts',
    '!apps/api/src/lib/**/*.test.ts',
    '!apps/api/src/routes/**/*.test.ts',
    '!apps/api/src/lib/**/*.spec.ts',
    '!apps/api/src/routes/**/*.spec.ts',
    '!**/node_modules/**',
  ],

  // ── Mutation Operators ─────────────────────────────────────────────────
  // Enable only: equality, logical, conditional, string, array, block.
  // Exclude all other operators to focus on the highest-value mutations.
  mutator: {
    excludedMutations: [
      'ArithmeticOperator',
      'BooleanLiteral',
      'MethodExpression',
      'ObjectLiteral',
      'OptionalChaining',
      'Regex',
      'UnaryOperator',
      'UpdateOperator',
    ],
  },

  // ── Concurrency ────────────────────────────────────────────────────────
  concurrency: 4,

  // ── Timeouts (ms) ──────────────────────────────────────────────────────
  // Bun test runner timeout multiplier (stryker applies this to measured
  // test execution time).
  timeoutFactor: 2,
  timeoutMS: 30000,

  // ── Reporters ──────────────────────────────────────────────────────────
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: {
    fileName: 'reports/mutation/html/index.html',
  },

  // ── Thresholds ─────────────────────────────────────────────────────────
  // Start lenient (break: 0 means CI never fails on mutation score).
  // Ratchet up over time as the test suite strengthens.
  thresholds: {
    high: 80,
    low: 60,
    break: 0,
  },

  // ── Temp Directory ─────────────────────────────────────────────────────
  cleanTempResources: true,
};

export default config;
