import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['koffi', 'winax'],
  poweredByHeader: false,
  outputFileTracingExcludes: { '/*': ['./data/**/*', './config.toml', './.venv/**/*', './src/dispatcher/**/*'] },
};

export default config;
