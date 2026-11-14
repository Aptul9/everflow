import type { NextConfig } from 'next';
import { buildConfiguration } from './src/web/build-artifact.ts';

export default function config(phase: string): NextConfig {
  // scripts/dev.ts: page preview from the checkout against a copied database
  if (phase === 'phase-development-server' && process.env.EVERFLOW_DEV === '1') {
    return { serverExternalPackages: ['koffi', 'winax'], poweredByHeader: false, turbopack: { root: process.cwd() } };
  }
  return buildConfiguration(phase, process.env.EVERFLOW_BUILD_ROOT, process.cwd());
}
