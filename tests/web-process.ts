const { startServer } = await import(new URL('../dist/server.js', import.meta.url).href) as typeof import('../src/server.ts');

const configPath = process.env.TEST_INSTANCE_CONFIG;
if (!configPath) throw new Error('Explicit test instance config required');
const server = await startServer({ configPath, port: 0 });
process.send?.({ ready: true, port: server.port });
process.once('message', () => { void server.close().then(() => process.disconnect?.()); });
