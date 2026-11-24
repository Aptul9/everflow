import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Windows bridge, Teams/DPAPI, PowerShell README examples and live checks: no Linux counterpart to test
// Chat files serve the VM's chat host only and read POSIX paths from the history
const platform = process.platform === 'win32' ? ['tests/chat-files.test.ts'] : ['tests/native.test.ts', 'tests/native-exit-race.test.ts', 'tests/daemon-identity.test.ts',
  'tests/receipt-publication.test.ts', 'tests/teams-source.test.ts', 'tests/live-checks.test.ts', 'tests/readme.test.ts'];
// Each starts real daemons or Next servers; beside other workers a Next prepare took 20 s and outran the daemon's 30 s
// readiness deadline, so they run after the rest, one file at a time
const servers = ['tests/daemon.test.ts', 'tests/daemon-pipeline.test.ts', 'tests/daemon-shutdown.test.ts', 'tests/runtime-lifecycle.test.ts',
  'tests/web.test.ts', 'tests/chat-gate.test.ts', 'tests/login.test.ts', 'tests/oidc.test.ts', 'tests/web-showcase.test.ts'];

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    // Client tests opt in with // @vitest-environment jsdom.
    // SQLite allows 30s lock waits; native backup, fixtures and checks need headroom.
    testTimeout: 60_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/**/*.test.{ts,tsx}'], exclude: [...platform, ...servers], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'server', include: servers, exclude: platform, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
