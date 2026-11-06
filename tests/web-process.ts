import { pathToFileURL } from 'node:url';
import { readBuildReceipt } from '../src/web/build-artifact.ts';

const buildReceipt = process.env.TEST_BUILD_RECEIPT;
const artifact = readBuildReceipt(buildReceipt);
const { startServer } = await import(pathToFileURL(artifact.server).href) as typeof import('../src/server.ts');

const configPath = process.env.TEST_INSTANCE_CONFIG;
if (!configPath) throw new Error('Explicit test instance config required');
const server = await startServer({ configPath, buildReceipt: buildReceipt!, port: 0 });
process.send?.({ ready: true, port: server.port });
process.once('message', () => { void server.close().then(() => process.disconnect?.()); });
