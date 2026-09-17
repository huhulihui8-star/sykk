import { spawnSync } from 'node:child_process';
const env = { ...process.env, NEXT_PUBLIC_BASE_PATH: process.env.NEXT_PUBLIC_BASE_PATH ?? '/sykk', NEXT_PUBLIC_STATIC_EXPORT: '1' };
const result = spawnSync(process.execPath, ['node_modules/vinext/dist/cli.js', 'build'], { env, stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
