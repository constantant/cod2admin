import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/log-tailer',
  test: {
    name: 'log-tailer',
    watch: false,
    globals: true,
    environment: 'node',
    // No source/tests yet (docs/PLAN.md §9 Phase 3 scaffold) — remove once real specs land.
    passWithNoTests: true,
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
