import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec §8.2 / §11.3: UI styles use design tokens only, never loose colors or measures.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return files(path, pattern);
    return pattern.test(entry) ? [path] : [];
  });
}

const RULES: Array<[string, RegExp]> = [
  ["hex color", /#[0-9a-f]{3,8}\b/i],
  ["color function", /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i],
  ["raw length", /(?<![\w-])(?:\d*\.)?\d+(?:px|rem|em)\b/i],
  ["named color", /:\s*(?:white|black|red|blue|green|gray|grey)\s*;/i],
];

/** Returns "line N: kind: text" for every non-token value; comments are ignored. */
function findRawValues(css: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const out: string[] = [];
  stripped.split("\n").forEach((line, i) => {
    for (const [kind, rule] of RULES) {
      const match = rule.exec(line);
      if (match && !/^0+(?:px|rem|em)$/i.test(match[0]))
        out.push(`line ${i + 1}: ${kind}: ${match[0]}`);
    }
  });
  return out;
}

describe("findRawValues", () => {
  it("flags hex, color functions and px/rem/em literals", () => {
    expect(findRawValues("a { color: #fff; }")).toHaveLength(1);
    expect(findRawValues("a { color: rgb(0 0 0); }")).toHaveLength(1);
    expect(findRawValues("a { background: hsl(0 0% 0%); }")).toHaveLength(1);
    expect(findRawValues("a { padding: 12px; }")).toHaveLength(1);
    expect(findRawValues("a { margin: 1.5rem; }")).toHaveLength(1);
    expect(findRawValues("a { gap: .5em; }")).toHaveLength(1);
    expect(findRawValues("a { color: white; }")).toHaveLength(1);
  });

  it("accepts tokens, zero and unitless values", () => {
    expect(
      findRawValues(
        "a { padding: var(--space-2) 0; margin: 0px; line-height: 1; flex: 1 1 0; width: 100%; }",
      ),
    ).toEqual([]);
    expect(findRawValues("/* #fff 12px */ a { color: var(--color-fg); }")).toEqual([]);
  });
});

describe("apps/web/src styles", () => {
  const cssFiles = files(SRC, /\.css$/);

  it("exist", () => {
    expect(cssFiles.length).toBeGreaterThan(0);
  });

  it("use only design tokens", () => {
    const offenders = cssFiles.flatMap((path) =>
      findRawValues(readFileSync(path, "utf8")).map((o) => `${path} ${o}`),
    );
    expect(offenders).toEqual([]);
  });

  it("components do not use inline style props", () => {
    const offenders = files(SRC, /\.tsx$/).filter((path) =>
      /\bstyle=\{/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
