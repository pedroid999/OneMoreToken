#!/usr/bin/env node
/**
 * npm entry: the packaged install ships data/ and the built dashboard next to the bundle.
 * resolveDataDir() and defaultWebDist() honor OMT_DATA_DIR / OMT_WEB_DIST, so pointing the
 * env vars there (only when unset) makes the package self-contained without the repo.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here); // dist/ -> package root
process.env.OMT_DATA_DIR ??= join(root, "data");
process.env.OMT_WEB_DIST ??= join(root, "web-dist");
process.env.OMT_MIGRATIONS_DIR ??= join(root, "migrations");

const { run } = await import("./cli.js");

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
});
