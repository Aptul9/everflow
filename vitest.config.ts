import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Client tests opt in with // @vitest-environment jsdom.
    testTimeout: 10_000,
  },
});
