import type { NextConfig } from 'next';
import { buildConfiguration } from './src/web/build-artifact.ts';

export default function config(phase: string): NextConfig {
  return buildConfiguration(phase, process.env.INBOX_DISPATCHER_BUILD_ROOT, process.cwd());
}
