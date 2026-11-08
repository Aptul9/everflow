import type { NextConfig } from 'next';
import { buildConfiguration } from './src/web/build-artifact.ts';

export default function config(phase: string): NextConfig {
  return buildConfiguration(phase, process.env.WORKDESK_BUILD_ROOT, process.cwd());
}
