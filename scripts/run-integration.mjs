import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(resolve(root, '.env')); } catch { /* CI may supply environment variables. */ }
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/api.integration.spec.ts'], {
  cwd: resolve(root, 'apps/api'), env: { ...process.env, RUN_INTEGRATION: 'true' }, stdio: 'inherit',
});
process.exit(result.status ?? 1);
