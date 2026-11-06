import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_MARKER, BUILD_PARENT, inside, plainParents, stagedRoot } from '../src/web/build-artifact.ts';
import type { BuildReceipt, BuildTree, SourceFile } from '../src/web/build-artifact.ts';
import { nativeBuildEnv } from './setup.ts';

const rootFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'next.config.ts',
  'postcss.config.mjs', 'vitest.config.ts', 'components.json', 'README.md'];
const sourceDirs = ['src', 'scripts', 'tests'];
const excluded = new Set(['data', '.venv', '.git', '.next', 'dist', 'node_modules', '__pycache__', '.cache']);

function sourceBytes(path: string): Buffer {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('Source links and junctions are not allowed');
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Source must be a regular, unlinked file; hard links are not allowed');
  if (stat.size > 2_097_152) throw new Error('Source file exceeds the reviewed size limit');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(path);
    if (current.isSymbolicLink() || opened.nlink !== 1 || current.ino !== stat.ino || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Source changed while staging');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function createBuildTree(input: string): BuildTree {
  if (!isAbsolute(input)) throw new Error('Explicit absolute source root required');
  const source = resolve(input);
  if (inside(BUILD_PARENT, source)) throw new Error('A staged output cannot be used as a source checkout');
  plainParents(source);
  fs.mkdirSync(BUILD_PARENT, { recursive: true });
  plainParents(BUILD_PARENT);
  const root = fs.mkdtempSync(join(BUILD_PARENT, 'build-'));
  const files: SourceFile[] = [];
  const copy = (name: string) => {
    const bytes = sourceBytes(join(source, name));
    const path = name.split(sep).join('/');
    fs.mkdirSync(dirname(join(root, name)), { recursive: true });
    fs.writeFileSync(join(root, name), bytes, { flag: 'wx' });
    files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  for (const name of rootFiles) copy(name);
  const walk = (name: string) => {
    const path = join(source, name);
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Source directories must not be links or junctions');
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      if (excluded.has(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('.env')) continue;
      const next = join(name, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Source links and junctions are not allowed');
      if (entry.isDirectory()) walk(next);
      else if (['.ts', '.tsx', '.css'].includes(extname(entry.name)) || next.split(sep).join('/') === 'tests/fixtures/v1.sql') copy(next);
    }
  };
  for (const dir of sourceDirs) walk(dir);
  const pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown };
  const lock = JSON.parse(fs.readFileSync(join(root, 'package-lock.json'), 'utf8')) as { lockfileVersion: number; packages: Record<string, { link?: boolean; resolved?: string }> };
  if (pkg.workspaces || lock.lockfileVersion !== 3 || !lock.packages) throw new Error('Reviewed non-workspace lockfile required');
  for (const dependency of Object.values(lock.packages)) {
    if (dependency.link || dependency.resolved && !dependency.resolved.startsWith('https://')) throw new Error('Local/workspace dependency links are not allowed');
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  fs.writeFileSync(join(root, BUILD_MARKER), JSON.stringify({ version: 1, root, status: 'prepared', files }, null, 2) + '\n', { flag: 'wx' });
  return { root, files };
}

export function isolatedEnvironment(root: string, base: Record<string, string | undefined>): NodeJS.ProcessEnv {
  stagedRoot(root);
  const keep = new Map(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS'].map((name) => [name.toLowerCase(), name]));
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(base)) {
    const canonical = keep.get(name.toLowerCase());
    if (canonical && value !== undefined) env[canonical] = value;
  }
  env.PATH = (env.PATH ?? '').split(delimiter).filter((path) => isAbsolute(path)
    && !path.split(/[\\/]/).some((part) => excluded.has(part.toLowerCase()))).join(delimiter);
  const home = join(root, '.private', 'home');
  for (const path of [home, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local'), join(root, '.private', 'tmp')]) fs.mkdirSync(path, { recursive: true });
  for (const name of ['user.npmrc', 'global.npmrc']) fs.writeFileSync(join(root, '.private', name), '', { flag: 'a' });
  return nativeBuildEnv({ ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: join(root, '.private', 'tmp'), TMP: join(root, '.private', 'tmp'), NODE_ENV: 'production' as const, NEXT_TELEMETRY_DISABLED: '1',
    INBOX_DISPATCHER_BUILD_ROOT: root, npm_config_cache: join(root, '.private', 'npm-cache'), npm_package_config_node_gyp_devdir: join(root, '.private', 'node-gyp'),
    npm_config_userconfig: join(root, '.private', 'user.npmrc'), npm_config_globalconfig: join(root, '.private', 'global.npmrc'),
    npm_config_prefix: join(root, '.private', 'npm-prefix'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' });
}

export function containedLinks(root: string): number {
  let links = 0;
  const checkedTarget = (link: string, seen: Set<string>): string => {
    const key = link.toLowerCase();
    if (seen.has(key) || seen.size >= 16) throw new Error('Cyclic staged link');
    const nextSeen = new Set([...seen, key]);
    const raw = fs.readlinkSync(link);
    const value = /^\\\\\?\\[a-z]:\\/i.test(raw) ? raw.slice(4) : raw;
    const target = resolve(dirname(link), value);
    if (!inside(root, target)) throw new Error('Staged link escapes outside its build root');
    let current = root;
    for (const part of relative(root, target).split(sep)) {
      const path = join(current, part);
      const stat = fs.lstatSync(path);
      current = stat.isSymbolicLink() ? checkedTarget(path, nextSeen) : path;
    }
    return current;
  };
  const visit = (path: string) => {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink()) { checkedTarget(path, new Set()); links++; return; }
    if (stat.isDirectory()) for (const entry of fs.readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
  return links;
}

export function inspectBuildArtifacts(root: string): { manifests: number; outsideEntries: number } {
  stagedRoot(root);
  let manifests = 0;
  const visit = (path: string) => {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Artifact link is not allowed');
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.nft.json')) {
        manifests++;
        const trace = JSON.parse(fs.readFileSync(file, 'utf8')) as { files: string[] };
        for (const target of trace.files) {
          // Lexical containment only. Never open/stat/hash a manifest target.
          const absolute = resolve(dirname(file), target);
          if (!inside(root, absolute)) throw new Error('Artifact trace points outside its staged root');
          const name = relative(root, absolute).split(sep).join('/');
          if (/^(data\/|config\.toml$|\.env|\.venv\/|\.git\/)/.test(name)) throw new Error('Artifact trace names a forbidden input');
        }
      }
    }
  };
  visit(join(root, '.next'));
  if (!manifests) throw new Error('No staged artifact manifests produced');
  return { manifests, outsideEntries: 0 };
}

export function build(source: string): string {
  assert.equal(process.platform, 'win32', 'Pinned Windows build toolchain required');
  assert.equal(process.versions.node, '26.4.0', 'Use the pinned Node version');
  const started = new Date().toISOString();
  const tree = createBuildTree(source);
  const env = isolatedEnvironment(tree.root, process.env);
  const logs = join(tree.root, 'build-logs');
  fs.mkdirSync(logs);
  console.log(JSON.stringify({ stage: tree.root, status: 'prepared', sourceFiles: tree.files.length }));
  const run = (name: string, args: string[]) => {
    const fd = fs.openSync(join(logs, `${name}.log`), 'wx');
    try {
      const result = spawnSync(process.execPath, args, { cwd: tree.root, env, windowsHide: true, stdio: ['ignore', fd, fd], timeout: 600_000 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${name} failed (${result.status}); inspect its staged build log`);
    } finally { fs.closeSync(fd); }
  };
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  run('install', [npm, 'ci', '--include=dev', '--foreground-scripts', '--no-audit', '--no-fund']);
  containedLinks(tree.root);
  run('native-check', ['scripts/setup.ts', '--verify-only', '--log', join(logs, 'native-config.json.log')]);
  run('next', [join(tree.root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build', tree.root, '--turbopack']);
  run('server', [join(tree.root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.server.json']);
  const inspection = inspectBuildArtifacts(tree.root);
  const internalLinks = containedLinks(tree.root);
  const receipt: BuildReceipt = { version: 1, status: 'complete', root: tree.root, server: join(tree.root, 'dist', 'server.js'),
    build_id: fs.readFileSync(join(tree.root, '.next', 'BUILD_ID'), 'utf8').trim(), started_at: started, ended_at: new Date().toISOString(), files: tree.files };
  fs.writeFileSync(join(tree.root, BUILD_MARKER), JSON.stringify({ ...receipt, status: 'complete' }, null, 2) + '\n');
  const path = join(tree.root, 'build-receipt.json');
  fs.writeFileSync(path, JSON.stringify({ ...receipt, inspection, internalLinks, roots: { project: tree.root, turbopack: tree.root, tracing: tree.root },
    limits: 'Source-only staging and root checks. Not an OS sandbox or a complete filesystem/network event audit.' }, null, 2) + '\n', { flag: 'wx' });
  return path;
}

if (import.meta.main) {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify({ buildReceipt: build(source) }));
}
