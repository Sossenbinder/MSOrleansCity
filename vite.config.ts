import { defineConfig } from 'vitest/config';

// base: './' so the built bundle works when served from a GitHub Pages
// project subpath (e.g. https://<user>.github.io/MSOrleansCity/).
export default defineConfig({
  base: './',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
