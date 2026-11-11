// Page preview with hot reload: Next dev on the checkout, reading a snapshot of the instance database.
// Clicks on the page write to the snapshot only; the daemon and the live database are never touched.
// Usage: node scripts/dev.ts [config.toml] [port]
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/core/config.ts';

const configPath = resolve(process.argv[2] ?? join(process.env.LOCALAPPDATA ?? '', 'everflow', 'config.toml'));
const port = Number(process.argv[3] ?? 8790);
const config = loadConfig(configPath);
const dir = join(tmpdir(), 'everflow-dev');
const snapshot = join(dir, 'preview.db');
mkdirSync(dir, { recursive: true });
rmSync(snapshot, { force: true });
{
  using live = new DatabaseSync(config.db.path, { readOnly: true, timeout: 30_000 });
  live.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
}
config.db.path = snapshot;
process.env.EVERFLOW_DEV = '1';
// Same slot src/web/instance.ts reads; set directly since Node cannot strip that module's parameter properties
(process as unknown as Record<symbol, unknown>)[Symbol.for('everflow.web.instance')] = { config, configPath: config._config_path, port, token: randomBytes(32).toString('hex') };

const next = createRequire(import.meta.url)('next') as typeof import('next').default;
const server = createServer((request, response) => { void handle(request, response); });
const app = next({ dev: true, dir: process.cwd(), hostname: '127.0.0.1', port, httpServer: server });
await app.prepare();
const handle = app.getRequestHandler();
server.listen(port, '127.0.0.1', () => console.log(`preview http://127.0.0.1:${port}/ (snapshot ${snapshot})`));
