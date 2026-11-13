import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __SKILLHANGAR_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
