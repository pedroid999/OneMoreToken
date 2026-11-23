// Assembles the publishable one-more-token package into ../publish-omt/ and reports it.
// Files are copied, not moved; the repo stays untouched.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cli = new URL("..", import.meta.url).pathname;
const root = join(cli, "..", "..");
const out = new URL("../../publish-omt", import.meta.url).pathname;

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const entry of ["dist", "web-dist", "data", "migrations"]) {
  cpSync(join(cli, entry), join(out, entry), { recursive: true });
}
cpSync(join(cli, "README.md"), join(out, "README.md"));

const cliPackage = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"));
const published = {
  name: "one-more-token",
  version: cliPackage.version,
  description: cliPackage.description,
  license: "MIT",
  type: "module",
  bin: { omt: "./dist/main.js" },
  files: ["dist/", "web-dist/", "data/", "migrations/", "README.md"],
  dependencies: { "@duckdb/node-api": cliPackage.dependencies["@duckdb/node-api"] },
  engines: { node: ">=22" },
  repository: cliPackage.repository,
  keywords: ["ai", "agents", "claude-code", "dashboard", "usage", "tokens", "duckdb"],
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
console.log(`staged ${published.name}@${published.version} in ${out}`);
