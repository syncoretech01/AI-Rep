import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': fromRoot('./src'),
      // `server-only` throws outside React Server environments; tests run server code directly.
      'server-only': fromRoot('./tests/support/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
