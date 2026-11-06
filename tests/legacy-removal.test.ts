import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readBuildReceipt } from '../src/web/build-artifact.ts';

function trackedLegacyPaths(value: string | undefined): string[] {
  assert(value !== undefined && value !== '', 'TEST_TRACKED_LEGACY_PATHS must contain the real Git-index JSON array');
  const paths: unknown = JSON.parse(value);
  assert(Array.isArray(paths), 'Git-index legacy inventory must be a JSON string array');
  assert(paths.every((path: unknown) => typeof path === 'string' && path.length > 0
    && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && !path.split('/').includes('..')
    && (path.endsWith('.py') || path === 'requirements.txt')), 'Invalid tracked legacy path');
  assert(new Set(paths).size === paths.length, 'Duplicate tracked legacy path');
  return paths;
}

test.each([undefined, '', 'null', '{}', '"[]"', '[1]', '[""]', '["../legacy.py"]', '["/legacy.py"]', '["src/main.ts"]', '["a.py","a.py"]'])(
  'legacy inventory fails closed on missing or malformed caller metadata: %j', (value) => {
    expect(() => trackedLegacyPaths(value)).toThrow();
  },
);

test('legacy inventory accepts explicit empty metadata and preserves actual tracked path evidence', () => {
  expect(trackedLegacyPaths('[]')).toEqual([]);
  expect(trackedLegacyPaths('["dispatcher/work.py","tests/test_runtime.py","requirements.txt"]'))
    .toEqual(['dispatcher/work.py', 'tests/test_runtime.py', 'requirements.txt']);
});

test('real Git index contains no tracked Python application, test or requirements file', () => {
  // Source-only stages omit .git and Python already. A staged filesystem scan cannot prove source deletion.
  expect(trackedLegacyPaths(process.env.TEST_TRACKED_LEGACY_PATHS)).toEqual([]);
});

test('shipped application and build scripts have no Python bridge, source write transport, deny override or provider lifecycle helper', () => {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
  const files = artifact.files.filter(({ path }) => /^(src|scripts)\//.test(path) || path === 'package.json');
  expect(files.length).toBeGreaterThan(40);
  for (const { path } of files) {
    const source = fs.readFileSync(join(artifact.root, path), 'utf8');
    expect(source, path).not.toMatch(/\bpython(?:3|w)?(?:\.exe)?\b|pywin32|watch_teamsrelay|watch_outlook|teams_mcp\.py/i);
    expect(source, path).not.toMatch(/\b(?:send_email|send_message|sendEmail|sendMessage|sendMail|SendUsingAccount)\b|\.\s*(?:Send|ReplyAll|Reply|Forward)\s*\(/);
    expect(source, path).not.toMatch(/\bDENY\b|\bpermissions\s*:|\beffect\s*:\s*['"]deny['"]/);
    expect(source, path).not.toMatch(/MERIDIAN_CTL|meridian[\\/]ctl\.ps1|\b(?:Start-Process|schtasks|New-Service)\b|quota[_-](?:helper|probe)|\bautostart\b/i);
  }
  const cli = fs.readFileSync(join(artifact.root, 'src/cli.ts'), 'utf8');
  expect(cli).not.toMatch(/case\s+['"](?:draft|reply)['"]|(?:draft|reply):\s*\d/);
  // OpenCode prompt HTTP and node:http sendResponse are unrelated to mail/Teams delivery.
  expect(fs.readFileSync(join(artifact.root, 'src/dispatcher/opencode.ts'), 'utf8')).toContain('client.session.prompt');
});
