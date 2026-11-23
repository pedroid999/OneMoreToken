// Build post-step: ensure the bundled dist/main.js starts with a POSIX shebang.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = join(import.meta.dirname ?? ".", "..", "dist", "main.js");
let source = readFileSync(target, "utf8");
if (!source.startsWith("#!")) {
  source = `#!/usr/bin/env node\n${source}`;
}
writeFileSync(target, source);
console.log("shebang ensured in dist/main.js");
