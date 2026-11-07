import { expect, test, vi } from 'vitest';
import { createKernel } from '../src/windows/kernel.ts';
import type { NativeBindings } from '../src/windows/kernel.ts';

test('bounded wait observes a dying owned process whose image disappears before its handle signals', () => {
  const waits: number[] = [];
  const api: NativeBindings = {
    OpenProcess: () => 1n, CloseHandle: vi.fn(() => 1), GetLastError: () => 31,
    WaitForSingleObject: (_handle, ms) => { waits.push(ms); return ms === 5000 ? 0 : 258; },
    GetProcessTimes: (_handle, created) => { created.writeBigUInt64LE(123n); return 1; },
    QueryFullProcessImageNameW: () => 0,
  };
  using kernel = createKernel(api);
  expect(kernel.wait({ pid: 1234, created: '123', image: 'C:/fixture/node.exe' }, 5000)).toBe(true);
  expect(waits).toContain(5000);
});

test('exit-race handling never weakens termination identity or treats an active unqueryable process as absent', () => {
  const terminate = vi.fn(() => 1);
  const api: NativeBindings = { OpenProcess: () => 1n, CloseHandle: () => 1, GetLastError: () => 31,
    WaitForSingleObject: () => 258, GetProcessTimes: (_handle, created) => { created.writeBigUInt64LE(123n); return 1; }, QueryFullProcessImageNameW: () => 0, TerminateProcess: terminate };
  using kernel = createKernel(api);
  const identity = { pid: 1234, created: '123', image: 'C:/fixture/node.exe' };
  expect(() => kernel.terminate(identity)).toThrow('native.process-image');
  expect(() => kernel.wait(identity, 10)).toThrow('native.process-image');
  expect(terminate).not.toHaveBeenCalled();
});
