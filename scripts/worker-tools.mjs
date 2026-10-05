import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const mode = process.argv[2];
if (!['types', 'build'].includes(mode)) throw new Error('Expected types or build');
for (const name of ['public', 'admin', 'discovery', 'email']) {
  const config = `apps/media-${name}/wrangler.jsonc`;
  const args = mode === 'types'
    ? ['types', `apps/media-${name}/worker-configuration.d.ts`, '--env-interface',
      `Media${name[0].toUpperCase()}${name.slice(1)}Env`, '--include-runtime', 'false', '-c', config]
    : ['deploy', '--dry-run', '--outdir', resolve(`dist/media-${name}`), '-c', config];
  mkdirSync('.wrangler/logs', { recursive: true });
  const result = spawnSync('node_modules/.bin/wrangler', args, {
    stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: '.wrangler/logs' },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
