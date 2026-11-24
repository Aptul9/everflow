import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Windows bridge, Teams/DPAPI, PowerShell README examples and live checks: no Linux counterpart to test
    // Chat files serve the VM's chat host only and read POSIX paths from the history
    exclude: process.platform === 'win32' ? ['tests/chat-files.test.ts'] : ['tests/native.test.ts', 'tests/native-exit-race.test.ts', 'tests/daemon-identity.test.ts',
      'tests/receipt-publication.test.ts', 'tests/teams-source.test.ts', 'tests/live-checks.test.ts', 'tests/readme.test.ts'],
    // Client tests opt in with // @vitest-environment jsdom.
    // SQLite allows 30s lock waits; native backup, fixtures and checks need headroom.
    testTimeout: 60_000,
  },
});
