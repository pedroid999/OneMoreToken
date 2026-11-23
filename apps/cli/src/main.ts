#!/usr/bin/env -S npx tsx
import { run } from "./cli";
import { startCommand } from "./start";

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
});
