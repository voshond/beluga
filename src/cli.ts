#!/usr/bin/env node
// The `beluga` command (src/cli/main.ts, one file per command in src/cli/), and the engine the Mac
// app runs in the background (src-tauri/src/daemon.rs starts `cli.js daemon --keep-alive`).
import { main } from './cli/main.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`beluga: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
