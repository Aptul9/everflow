import { Worker } from 'node:worker_threads';
import type { Config } from '../src/core/config.ts';

type Operation = { kind: 'claim' } | { kind: 'enqueue'; key: string; ticket: number; batch_ids: number[] };

async function race(cfg: Config, at: string, operations: Operation[]): Promise<(number | null)[]> {
  const workers = operations.map((operation, id) => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openDb } = await import(workerData.db);
      const { claim, enqueue } = await import(workerData.jobs);
      const db = openDb(workerData.cfg.db.path);
      parentPort.once('message', () => {
        try {
          const operation = workerData.operation;
          const id = operation.kind === 'claim'
            ? claim(db, workerData.cfg, 'racing-run-' + workerData.id, workerData.at)?.id ?? null
            : enqueue(db, 'forward', operation.key, { batch_ids: operation.batch_ids }, operation.ticket);
          parentPort.postMessage({ id });
        } finally {
          db.close();
          parentPort.close();
        }
      });
      parentPort.postMessage({ ready: true });
    })().catch((error) => { throw error; });
  `, { eval: true, workerData: { id, operation, cfg, at, db: new URL('../src/core/db.ts', import.meta.url).href,
    jobs: new URL('../src/core/jobs.ts', import.meta.url).href } }));
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once('message', (message: { ready: boolean }) => message.ready ? resolve() : reject(new Error('Worker not ready')));
      worker.once('error', reject);
    })));
    const results = workers.map((worker) => new Promise<number | null>((resolve, reject) => {
      worker.once('message', (message: { id: number | null }) => resolve(message.id));
      worker.once('error', reject);
    }));
    for (const worker of workers) worker.postMessage('claim');
    return await Promise.all(results);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

export function raceClaims(cfg: Config, at: string, count: number): Promise<(number | null)[]> {
  return race(cfg, at, Array.from({ length: count }, () => ({ kind: 'claim' })));
}

export function raceEnqueues(cfg: Config, at: string, inputs: Omit<Extract<Operation, { kind: 'enqueue' }>, 'kind'>[]): Promise<(number | null)[]> {
  return race(cfg, at, inputs.map((input) => ({ ...input, kind: 'enqueue' })));
}

export async function raceChatOpen(path: string): Promise<string[]> {
  const barrier = new SharedArrayBuffer(4);
  const workers = Array.from({ length: 2 }, () => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const exec = DatabaseSync.prototype.exec;
    let waited = false;
    DatabaseSync.prototype.exec = function (sql) {
      if (!waited && sql === 'BEGIN IMMEDIATE') {
        waited = true;
        parentPort.postMessage({ ready: true });
        if (Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 10000) === 'timed-out') throw new Error('Writer barrier timed out');
      }
      return exec.call(this, sql);
    };
    (async () => {
      try {
        const { openDb } = await import(workerData.module);
        const db = openDb(workerData.path);
        db.close();
        parentPort.postMessage({ result: 'ok' });
      } catch (error) { parentPort.postMessage({ result: error.message }); }
      finally { parentPort.close(); }
    })();
  `, { eval: true, workerData: { path, barrier, module: new URL('../src/core/db.ts', import.meta.url).href } }));
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once('message', (message: { ready?: boolean; result?: string }) => message.ready ? resolve() : reject(new Error(message.result)));
      worker.once('error', reject);
    })));
    const results = workers.map((worker) => new Promise<string>((resolve, reject) => {
      worker.once('message', (message: { result: string }) => resolve(message.result));
      worker.once('error', reject);
    }));
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, 2);
    return await Promise.all(results);
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
}
