import { expect, test } from 'vitest';
import { nativeBuildEnv, verifyNativeConfig } from '../scripts/setup.ts';

test('disables LLVM LTO only in the npm child environment', () => {
  const base = {
    PATH: 'unchanged',
    npm_package_config_node_gyp_enable_thin_lto: 'true',
    npm_package_config_node_gyp_enable_lto: 'true',
    npm_package_config_node_gyp_lto_jobs: '4',
  };
  expect(nativeBuildEnv(base)).toEqual({
    PATH: 'unchanged',
    npm_package_config_node_gyp_enable_thin_lto: 'false',
    npm_package_config_node_gyp_enable_lto: 'false',
    npm_package_config_node_gyp_lto_jobs: '',
  });
  expect(base.npm_package_config_node_gyp_enable_lto).toBe('true');
});

test('refuses generated MSVC projects that still enable LLVM LTO', () => {
  expect(() => verifyNativeConfig('# Generated\n' + JSON.stringify({ variables: {
    clang: 0, enable_lto: 'false', enable_thin_lto: 'true', lto_jobs: '',
  } }))).toThrow(/enable_thin_lto/);
});

test('accepts generated native config with the scoped no-LTO values', () => {
  expect(() => verifyNativeConfig('# Generated\n' + JSON.stringify({ variables: {
    clang: 0, enable_lto: 'false', enable_thin_lto: 'false', lto_jobs: '',
  } }))).not.toThrow();
});
