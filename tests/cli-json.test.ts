import { expect, test } from 'vitest';
import { cliJson } from '../src/watchers/cli-json.ts';

test('CLI JSON runner handles paths/Unicode without a shell', async () => {
  const args = ['--eval', 'console.log(JSON.stringify({value:process.argv[1]}))', 'space è & | value'];
  expect(await cliJson('gmail', process.execPath, args)).toEqual({ value: 'space è & | value' });
});

test('CLI JSON runner bounds time/output and never leaks stderr', async () => {
  await expect(cliJson('gmail', process.execPath, ['--eval', 'setInterval(()=>{},1000)'], undefined, { timeoutMs: 100 })).rejects.toThrow('cli.timeout');
  await expect(cliJson('gmail', process.execPath, ['--eval', 'console.log("x".repeat(10000))'], undefined, { maxBytes: 100 })).rejects.toThrow('cli.result-limit');
  await expect(cliJson('gmail', process.execPath, ['--eval', 'console.error("SECRET");process.exit(2)'])).rejects.toThrow('cli.failed');
  await expect(cliJson('gchat', process.execPath, ['--eval', 'console.log("invalid")'])).rejects.toThrow('cli.response-json');
  await expect(cliJson('gmail', 'missing-workdesk-fixture-executable', [])).rejects.toThrow('cli.start');
});

test('CLI JSON runner cancellation kills its owned child', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await expect(cliJson('gchat', process.execPath, ['--eval', 'setInterval(()=>{},1000)'], controller.signal)).rejects.toThrow('cli.aborted'); }
  finally { clearTimeout(timer); }
});
