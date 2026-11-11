import fs from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, test, vi } from 'vitest';
import { atomicJson, bounded } from '../src/core/daemon.ts';
import { failureFields } from '../src/cli.ts';
import { readBuildReceipt } from '../src/web/build-artifact.ts';
import { scratch } from './support.ts';

export async function denyDeleteReader(path: string, artifactRoot: string) {
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {createRequire}=require('node:module');
    const ffi=createRequire(workerData.package)('koffi'),api=ffi.load('kernel32.dll');
    const open=api.func('void *__stdcall CreateFileW(str16 path,uint32_t access,uint32_t sharing,void *security,uint32_t disposition,uint32_t flags,void *templateFile)');
    const close=api.func('int __stdcall CloseHandle(void *handle)'),last=api.func('uint32_t __stdcall GetLastError()');
    const handle=open(workerData.path,0x80000000,1,null,3,0,null);if(!handle||BigInt.asUintN(64,handle)===0xffffffffffffffffn)throw new Error('fixture.file-open:'+last());
    let closed=false,timer;function release(){if(closed)return;closed=true;clearTimeout(timer);if(!close(handle))throw new Error('fixture.file-close:'+last());parentPort.postMessage('released');parentPort.close();}
    parentPort.on('message',value=>{if(value==='release')release();else if(value==='release-soon')timer=setTimeout(release,150);});
    timer=setTimeout(release,5000);parentPort.postMessage('locked');`, {
    eval: true, execArgv: [], workerData: { path, package: join(artifactRoot, 'package.json') },
  });
  const released = new Promise<void>((resolve, reject) => { worker.on('message', (value) => { if (value === 'released') resolve(); }); worker.once('error', reject); });
  const exited = new Promise<void>((resolve, reject) => { worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('fixture.file-holder-exit'))); worker.once('error', reject); });
  await bounded(new Promise<void>((resolve, reject) => { worker.on('message', (value) => { if (value === 'locked') resolve(); }); worker.once('error', reject); }), 5000, 'fixture.file-holder-ready');
  return { releaseSoon: () => worker.postMessage('release-soon'), async close() { worker.postMessage('release'); await bounded(released, 6000, 'fixture.file-holder-release'); await exited; } };
}

test('Windows own deny-delete reader reproduces fixed rename denial without changing any file permissions', async () => {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT), f = scratch('phase7b-publication-');
  const target = join(f.root, 'receipt.json'), temporary = join(f.root, 'complete.tmp');
  fs.writeFileSync(target, '{"generation":1}'); fs.writeFileSync(temporary, '{"generation":2}');
  const reader = await denyDeleteReader(target, artifact.root);
  let failure: unknown;
  try { try { fs.renameSync(temporary, target); } catch (error) { failure = error; } }
  finally { await reader.close(); }
  const fields = failureFields(failure, 'heartbeat.receipt');
  expect(['EACCES', 'EPERM', 'EBUSY']).toContain(fields.reason); expect(fields.operation).toBe('rename');
  expect(fs.readFileSync(target, 'utf8')).toBe('{"generation":1}'); expect(fs.readFileSync(temporary, 'utf8')).toBe('{"generation":2}');
  fs.writeFileSync(join(f.root, 'diagnosis.json'), JSON.stringify({ config: f.config, artifact: process.env.TEST_BUILD_RECEIPT, fields, targetUnchanged: true, completeTemporaryRetained: true }, null, 2));
});

test('atomic receipt publication survives a transient own deny-delete reader with complete replacement', async () => {
  const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT), f = scratch('phase7b-publication-');
  const target = join(f.root, 'receipt.json'); atomicJson(target, { generation: 1 });
  const reader = await denyDeleteReader(target, artifact.root);
  try { reader.releaseSoon(); expect(() => atomicJson(target, { generation: 2 })).not.toThrow(); }
  finally { await reader.close(); }
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ generation: 2 });
});

test('receipt publication retries only fixed transient rename codes, never a write failure or arbitrary exception', () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT); const f = scratch('phase7b-publication-'), path = join(f.root, 'receipt.json');
  const original = fs.renameSync; let attempts = 0;
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (++attempts === 1) throw Object.assign(new Error('synthetic hidden text'), { code: 'EACCES', syscall: 'rename' }); original(from, to); });
  try { expect(() => atomicJson(path, { generation: 1 })).not.toThrow(); expect(attempts).toBe(2); }
  finally { rename.mockRestore(); }
});

test('permanent rename denial stays bounded and preserves the old receipt and complete candidate', () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT); const f = scratch('phase7b-publication-'), path = join(f.root, 'receipt.json'); atomicJson(path, { generation: 1 });
  const failure = Object.assign(new Error('synthetic denial'), { code: 'EPERM', syscall: 'rename' });
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure; });
  try { expect(() => atomicJson(path, { generation: 2 })).toThrow(failure); expect(rename).toHaveBeenCalledTimes(10); }
  finally { rename.mockRestore(); }
  expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({ generation: 1 });
  const candidates = fs.readdirSync(f.root).filter((name) => name.startsWith('receipt.json.') && name.endsWith('.tmp'));
  expect(candidates).toHaveLength(1); expect(JSON.parse(fs.readFileSync(join(f.root, candidates[0]!), 'utf8'))).toEqual({ generation: 2 });
});

test('write failure is propagated immediately without a rename retry or old receipt mutation', () => {
  readBuildReceipt(process.env.TEST_BUILD_RECEIPT); const f = scratch('phase7b-publication-'), path = join(f.root, 'receipt.json'); atomicJson(path, { generation: 1 });
  const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC', syscall: 'write' }); });
  const rename = vi.spyOn(fs, 'renameSync');
  try { expect(() => atomicJson(path, { generation: 2 })).toThrow('synthetic full disk'); expect(rename).not.toHaveBeenCalled(); }
  finally { write.mockRestore(); rename.mockRestore(); }
  expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({ generation: 1 });
});
