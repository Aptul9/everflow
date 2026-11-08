import fs from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { NextConfig } from 'next';

export const BUILD_PARENT = resolve('C:/Users/Antonio/AppData/Local/Temp/opencode/workdesk/source-builds');
export const BUILD_MARKER = '.source-build.json';

export interface SourceFile { path: string; sha256: string }
export interface BuildTree { root: string; files: SourceFile[] }
export interface BuildReceipt {
  version: 1;
  status: 'complete';
  root: string;
  server: string;
  build_id: string;
  started_at: string;
  ended_at: string;
  files: SourceFile[];
}

export function samePath(a: string, b: string): boolean { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); }

export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export function plainParents(path: string): void {
  const absolute = resolve(path);
  const drive = parse(absolute).root;
  let current = drive;
  for (const part of absolute.slice(drive.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Build paths must not contain links or junctions');
  }
}

export function stagedRoot(value: string | undefined): string {
  if (!value || !isAbsolute(value)) throw new Error('Explicit source-only staged build root required');
  const root = resolve(value);
  if (!samePath(dirname(root), BUILD_PARENT) || !/^build-[a-z0-9]+$/i.test(basename(root))) throw new Error('Source-only staging root required');
  return root;
}

function marker(root: string): { status: string } {
  plainParents(root);
  const path = join(root, BUILD_MARKER);
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576) throw new Error('Invalid source-only build marker');
  const value = JSON.parse(fs.readFileSync(path, 'utf8')) as { version?: number; root?: string; status?: string };
  if (value.version !== 1 || typeof value.root !== 'string' || !samePath(value.root, root) || !['prepared', 'complete'].includes(value.status ?? '')) throw new Error('Invalid source-only build marker');
  return { status: value.status! };
}

export function buildConfiguration(phase: string, value: string | undefined, cwd: string): NextConfig {
  const root = stagedRoot(value);
  if (!samePath(cwd, root)) throw new Error('Next working directory must be the staged root');
  const expected = phase === 'phase-production-build' ? 'prepared' : phase === 'phase-production-server' ? 'complete' : null;
  if (!expected || marker(root).status !== expected) throw new Error('Fresh staging build or completed production artifact required');
  return { serverExternalPackages: ['koffi', 'winax'], poweredByHeader: false,
    turbopack: { root }, outputFileTracingRoot: root };
}

export function readBuildReceipt(path: string | undefined): BuildReceipt {
  if (!path || !isAbsolute(path)) throw new Error('Explicit absolute build receipt required');
  const root = stagedRoot(dirname(path));
  if (basename(path) !== 'build-receipt.json') throw new Error('Explicit staged build-receipt.json required');
  plainParents(path);
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) throw new Error('Invalid build receipt');
  const receipt = JSON.parse(fs.readFileSync(path, 'utf8')) as Partial<BuildReceipt>;
  if (receipt.version !== 1 || receipt.status !== 'complete') throw new Error('Completed build receipt required');
  if (typeof receipt.root !== 'string' || !samePath(receipt.root, root) || !samePath(receipt.server ?? '', join(root, 'dist', 'server.js'))
    || typeof receipt.build_id !== 'string' || !receipt.build_id || !Array.isArray(receipt.files) || marker(root).status !== 'complete') throw new Error('Invalid completed staged build receipt');
  for (const artifact of [join(root, '.next', 'BUILD_ID'), join(root, 'dist', 'server.js')]) {
    plainParents(artifact);
    if (!fs.lstatSync(artifact).isFile()) throw new Error('Completed staged build artifact is missing');
  }
  if (fs.readFileSync(join(root, '.next', 'BUILD_ID'), 'utf8').trim() !== receipt.build_id) throw new Error('Build receipt does not match the staged artifact');
  return receipt as BuildReceipt;
}
