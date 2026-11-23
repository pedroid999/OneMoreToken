import type { SqlParams, ToolCatalogue } from "@omt/core";

/**
 * Raw tool names resolved to canonical ids in SQL (spec §7.3, S4): a `VALUES` CTE whose aliases are
 * always bound as parameters, never interpolated. `of(raw)` is the canonical expression of a raw
 * name column and degrades to its lowercase form, exactly like `canonicalTool` in JavaScript, so the
 * catalogue is the only place the mapping lives.
 */
export interface CanonicalTools {
  /** CTE prefix, ending in a comma; empty when the catalogue has no alias to bind. */
  cte: string;
  /** Join the `of` expression needs, on the raw name column `x.tool`; empty without aliases. */
  join: string;
  of: (raw: string) => string;
}

export function canonicalTools(catalogue: ToolCatalogue, params: SqlParams): CanonicalTools {
  const pairs = catalogue.tools.flatMap((tool) =>
    tool.aliases.map((alias) => [alias.toLowerCase(), tool.id] as const),
  );
  if (!pairs.length) return { cte: "", join: "", of: (raw) => `lower(${raw})` };
  const values = pairs.map(([alias, id]) => {
    const index = params.length + 1;
    params.push(alias, id);
    return `($${index}, $${index + 1})`;
  });
  return {
    cte: `canon(alias, canonical) AS (VALUES ${values.join(", ")}),`,
    join: "LEFT JOIN canon cm ON cm.alias = lower(x.tool)",
    of: (raw) => `coalesce(cm.canonical, lower(${raw}))`,
  };
}
