import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from '@playwright/test';

/** The served build, made once for the web project (what `beluga web` serves): `vite build` into dist/. */
test('build the UI the daemon serves', () => {
  test.setTimeout(180_000);
  execFileSync(process.execPath, [path.join(import.meta.dirname, '../../node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'error'], { cwd: path.join(import.meta.dirname, '../..'), stdio: 'inherit' });
});
