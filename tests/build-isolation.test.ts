import fs from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { containedLinks, createBuildTree, inspectBuildArtifacts, isolatedEnvironment } from '../scripts/build.ts';
import { BUILD_PARENT, buildConfiguration, readBuildReceipt } from '../src/web/build-artifact.ts';
import { SCRATCH } from './support.ts';

afterEach(() => vi.restoreAllMocks());

function visitedWithin(path: string, root: string): boolean {
  const relative = win32.relative(root, path);
  return relative === '' || relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative);
}

test('forbidden-input assertions detect Windows descendants without matching sibling prefixes', () => {
  expect(visitedWithin('C:\\synthetic\\data\\nested\\held.db', 'C:\\synthetic\\data')).toBe(true);
  expect(visitedWithin('C:\\synthetic\\data-other\\held.db', 'C:\\synthetic\\data')).toBe(false);
});

function sourceFixture() {
  const root = fs.mkdtempSync(join(SCRATCH, 'build-source-fixture-'));
  fs.mkdirSync(join(root, 'src'));
  fs.mkdirSync(join(root, 'scripts'));
  fs.mkdirSync(join(root, 'tests'));
  for (const [name, text] of Object.entries({
    'README.md': '# Synthetic operating README\n',
    'package.json': '{"name":"synthetic-build","private":true,"dependencies":{}}',
    'package-lock.json': '{"name":"synthetic-build","lockfileVersion":3,"packages":{"":{}}}',
    'tsconfig.json': '{}', 'tsconfig.server.json': '{}', 'next.config.ts': 'export default {};',
    'postcss.config.mjs': 'export default {};', 'vitest.config.ts': 'export default {};', 'components.json': '{}',
    'src/example.ts': 'export const synthetic = true;', 'scripts/setup.ts': 'export {};', 'tests/example.test.ts': 'export {};',
  })) fs.writeFileSync(join(root, name), text);
  return root;
}

test('stages only allowlisted source without enumerating or reading synthetic state paths', () => {
  const source = sourceFixture();
  for (const name of ['data', '.venv', '.git', '.next', 'dist', 'node_modules']) {
    fs.mkdirSync(join(source, name));
    fs.writeFileSync(join(source, name, 'synthetic-state.txt'), 'synthetic state, never a live input');
  }
  fs.writeFileSync(join(source, 'config.toml'), 'synthetic default config, do not copy');
  fs.writeFileSync(join(source, '.env.local'), 'SYNTHETIC=true');
  fs.writeFileSync(join(source, 'src', 'ignored.db'), 'synthetic non-source');
  fs.mkdirSync(join(source, 'docs'));
  fs.writeFileSync(join(source, 'docs', 'private.md'), 'synthetic documentation tree, do not copy');
  fs.writeFileSync(join(source, 'other.md'), 'synthetic root note, do not copy');
  fs.writeFileSync(join(source, 'src', 'private.md'), 'synthetic nested note, do not copy');
  const reads = vi.spyOn(fs, 'readFileSync');
  const listings = vi.spyOn(fs, 'readdirSync');
  const stats = vi.spyOn(fs, 'lstatSync');
  const tree = createBuildTree(source);
  expect(tree.root.startsWith(BUILD_PARENT)).toBe(true);
  expect(tree.files.map((file) => file.path)).toContain('src/example.ts');
  expect(tree.files.filter((file) => file.path.endsWith('.md')).map((file) => file.path)).toEqual(['README.md']);
  expect(fs.readFileSync(join(tree.root, 'README.md'), 'utf8')).toBe('# Synthetic operating README\n');
  expect(tree.files.every((file) => !/(^|\/)(data|\.venv|\.git|\.next|dist|node_modules)\/|(^|\/)config\.toml$|(^|\/)\.env/.test(file.path))).toBe(true);
  expect(listings.mock.calls.some(([path]) => String(path) === source)).toBe(false);
  const visited = [...reads.mock.calls, ...stats.mock.calls, ...listings.mock.calls].map(([path]) => String(path));
  for (const name of ['data', '.venv', '.git', '.next', 'dist', 'node_modules', 'config.toml', '.env.local', 'docs', 'other.md']) {
    expect(visited.some((path) => visitedWithin(path, join(source, name)))).toBe(false);
  }
  expect(fs.existsSync(join(tree.root, 'config.toml'))).toBe(false);
  expect(fs.existsSync(join(tree.root, '.next'))).toBe(false);
});

test('named README rejects a hard link without reading the linked input', () => {
  const source = sourceFixture(), readme = join(source, 'README.md'), other = join(source, 'other.md');
  fs.linkSync(readme, other);
  const reads = vi.spyOn(fs, 'readFileSync');
  expect(() => createBuildTree(source)).toThrow(/hard.link|unlinked/i);
  expect(reads.mock.calls.some(([path]) => String(path) === readme)).toBe(false);
});

test('rejects source-directory junctions before reading the synthetic target', () => {
  const source = sourceFixture();
  const target = fs.mkdtempSync(join(SCRATCH, 'build-junction-target-'));
  fs.writeFileSync(join(target, 'source.ts'), 'synthetic target');
  fs.symlinkSync(target, join(source, 'src', 'linked'), 'junction');
  const reads = vi.spyOn(fs, 'readFileSync');
  expect(() => createBuildTree(source)).toThrow(/link|junction/i);
  expect(reads.mock.calls.some(([path]) => String(path).startsWith(target))).toBe(false);
});

test('rejects hard-linked source files without reading their contents', () => {
  const source = sourceFixture();
  const other = join(source, 'other-synthetic.ts');
  fs.writeFileSync(other, 'synthetic hard link');
  fs.linkSync(other, join(source, 'src', 'linked.ts'));
  const reads = vi.spyOn(fs, 'readFileSync');
  expect(() => createBuildTree(source)).toThrow(/hard.link|unlinked/i);
  expect(reads.mock.calls.some(([path]) => String(path).endsWith('linked.ts'))).toBe(false);
});

test('rejects local/workspace dependency material before install', () => {
  const source = sourceFixture();
  fs.writeFileSync(join(source, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{},"node_modules/local":{"link":true,"resolved":"../synthetic-outside"}}}');
  expect(() => createBuildTree(source)).toThrow(/local|workspace|link/i);
});

test('child environment drops inherited application state and scopes native caches/LTO', () => {
  const source = sourceFixture();
  const tree = createBuildTree(source);
  const env = isolatedEnvironment(tree.root, {
    PATH: ['C:/synthetic/toolchain', 'C:/synthetic/.venv/Scripts', 'C:/synthetic/node_modules/.bin'].join(delimiter), SystemRoot: 'C:/Windows', USERPROFILE: 'C:/synthetic-user', APPDATA: 'C:/synthetic-state',
    NODE_OPTIONS: '--import=synthetic-preload', EVERFLOW_OPENCODE_PASSWORD: 'synthetic-secret', TEST_INSTANCE_CONFIG: 'synthetic-config',
    OBSIDIAN_VAULT: 'synthetic-vault', npm_config_userconfig: 'synthetic-user-npmrc',
  });
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.PATH).toBe('C:/synthetic/toolchain');
  expect(env.EVERFLOW_OPENCODE_PASSWORD).toBeUndefined();
  expect(env.TEST_INSTANCE_CONFIG).toBeUndefined();
  expect(env.OBSIDIAN_VAULT).toBeUndefined();
  expect(env.USERPROFILE).toContain(tree.root);
  expect(env.npm_config_userconfig).toContain(tree.root);
  expect(env.npm_config_cache).toContain(tree.root);
  expect(env.npm_config_devdir).toBeUndefined();
  expect(env.npm_package_config_node_gyp_devdir).toBe(join(tree.root, '.private', 'node-gyp'));
  expect(env.NEXT_TELEMETRY_DISABLED).toBe('1');
  expect(env.npm_package_config_node_gyp_enable_thin_lto).toBe('false');
  expect(env.npm_package_config_node_gyp_enable_lto).toBe('false');
  expect(env.npm_package_config_node_gyp_lto_jobs).toBe('');
});

test('installed native headers resolve inside the staged node-gyp cache', () => {
  const root = process.env.EVERFLOW_BUILD_ROOT!;
  expect(root).toBeTruthy();
  const config = JSON.parse(fs.readFileSync(join(root, 'node_modules/winax/build/config.gypi'), 'utf8').replace(/^#.*$/gm, '')) as { variables: { nodedir: string } };
  expect(config.variables.nodedir.toLowerCase()).toBe(join(root, '.private', 'node-gyp', process.versions.node).toLowerCase());
});

test('configuration rejects an outside root before filesystem access and pins a fresh staged root', () => {
  const source = sourceFixture();
  const stats = vi.spyOn(fs, 'lstatSync');
  expect(() => buildConfiguration('phase-production-build', source, source)).toThrow(/staged|staging|source.only/i);
  expect(stats).not.toHaveBeenCalled();
  const tree = createBuildTree(source);
  const config = buildConfiguration('phase-production-build', tree.root, tree.root);
  expect(config.turbopack?.root).toBe(tree.root);
  expect(config.outputFileTracingRoot).toBe(tree.root);
  expect(config.output).not.toBe('standalone');
  expect(() => buildConfiguration('phase-production-build', tree.root, source)).toThrow(/working directory|cwd/i);
});

test('artifact receipt is mandatory, completed and confined to its immutable staged root', () => {
  expect(() => readBuildReceipt(undefined)).toThrow(/explicit/i);
  const source = sourceFixture();
  const reads = vi.spyOn(fs, 'readFileSync');
  expect(() => readBuildReceipt(join(source, 'not-a-build.json'))).toThrow(/staged|staging|source.only/i);
  expect(reads).not.toHaveBeenCalled();
  const tree = createBuildTree(source);
  const path = join(tree.root, 'build-receipt.json');
  fs.writeFileSync(path, JSON.stringify({ version: 1, root: tree.root, status: 'prepared' }));
  expect(() => readBuildReceipt(path)).toThrow(/completed|complete|built/i);
});

test('artifact containment rejects a synthetic outside-stage target without dereferencing it', () => {
  const source = sourceFixture();
  const tree = createBuildTree(source);
  const outside = join(source, 'outside-canary.txt');
  fs.writeFileSync(outside, 'synthetic outside-stage canary');
  fs.mkdirSync(join(tree.root, '.next'));
  fs.writeFileSync(join(tree.root, '.next', 'synthetic.nft.json'), JSON.stringify({ files: [outside] }));
  const reads = vi.spyOn(fs, 'readFileSync');
  const stats = vi.spyOn(fs, 'lstatSync');
  expect(() => inspectBuildArtifacts(tree.root)).toThrow(/outside/i);
  expect(reads.mock.calls.some(([path]) => String(path) === outside)).toBe(false);
  expect(stats.mock.calls.some(([path]) => String(path) === outside)).toBe(false);
});

test('ordinary build entrypoint uses the staging builder rather than invoking Next in place', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: { build: string } };
  expect(pkg.scripts.build).toBe('node scripts/build.ts');
});

test('allows generated internal library junctions but refuses outside targets before stat', () => {
  const source = sourceFixture();
  const tree = createBuildTree(source);
  const target = join(tree.root, 'synthetic-library');
  fs.mkdirSync(target);
  fs.symlinkSync(target, join(tree.root, 'internal-link'), 'junction');
  expect(containedLinks(tree.root)).toBe(1);
  const outside = fs.mkdtempSync(join(SCRATCH, 'outside-link-canary-'));
  fs.symlinkSync(outside, join(tree.root, 'outside-link'), 'junction');
  const stats = vi.spyOn(fs, 'lstatSync');
  expect(() => containedLinks(tree.root)).toThrow(/outside|escape/i);
  expect(stats.mock.calls.some(([path]) => String(path) === outside)).toBe(false);
});
