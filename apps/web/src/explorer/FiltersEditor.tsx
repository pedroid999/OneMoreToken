import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import {
  EXPLORER_DIMENSIONS,
  type ExplorerDimension,
  type ExplorerFilter,
  MAX_FILTERS,
  parseFilterValues,
} from "./state";

interface Draft {
  key: number;
  dimension: ExplorerDimension;
  op: ExplorerFilter["op"];
  text: string;
}

export interface FiltersEditorProps {
  filters: ExplorerFilter[];
  onChange: (filters: ExplorerFilter[]) => void;
}

const effective = (drafts: Draft[]): ExplorerFilter[] =>
  drafts
    .map(({ dimension, op, text }) => ({ dimension, op, values: parseFilterValues(text) }))
    .filter((filter) => filter.values.length > 0);

/**
 * Combinable AND filters (S9). Rows being typed live here; only filters with values reach the
 * URL and the query, and a URL change from elsewhere (loading a view, history) resets the rows.
 */
export function FiltersEditor({ filters, onChange }: FiltersEditorProps) {
  const { t } = useTranslation();
  const next = useRef(0);
  const toDrafts = (list: ExplorerFilter[]): Draft[] =>
    list.map((filter) => ({
      key: next.current++,
      dimension: filter.dimension,
      op: filter.op,
      text: filter.values.join(", "),
    }));
  const [drafts, setDrafts] = useState(() => toDrafts(filters));
  const urlKey = JSON.stringify(filters);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the serialized URL filters are the trigger; toDrafts only allocates keys
  useEffect(() => {
    setDrafts((current) =>
      JSON.stringify(effective(current)) === urlKey ? current : toDrafts(JSON.parse(urlKey)),
    );
  }, [urlKey]);

  const change = (list: Draft[]) => {
    setDrafts(list);
    const applied = effective(list);
    if (JSON.stringify(applied) !== urlKey) onChange(applied);
  };
  const patch = (key: number, update: Partial<Draft>) =>
    change(drafts.map((draft) => (draft.key === key ? { ...draft, ...update } : draft)));

  return (
    <div className="explorer__filters">
      {drafts.length > 0 ? (
        <ul className="explorer__filter-list">
          {drafts.map((draft) => (
            <li key={draft.key} className="explorer__filter">
              <select
                className="explorer__input"
                aria-label={t("explorer.filterDimension")}
                value={draft.dimension}
                onChange={(event) =>
                  patch(draft.key, { dimension: event.target.value as ExplorerDimension })
                }
              >
                {EXPLORER_DIMENSIONS.map((dimension) => (
                  <option key={dimension} value={dimension}>
                    {t(`explorer.dimension.${dimension}`)}
                  </option>
                ))}
              </select>
              <select
                className="explorer__input"
                aria-label={t("explorer.filterOperator")}
                value={draft.op}
                onChange={(event) =>
                  patch(draft.key, { op: event.target.value as ExplorerFilter["op"] })
                }
              >
                <option value="in">{t("explorer.op.in")}</option>
                <option value="notIn">{t("explorer.op.notIn")}</option>
              </select>
              <input
                type="text"
                className="explorer__input explorer__input--grow"
                aria-label={t("explorer.filterValues")}
                value={draft.text}
                onChange={(event) => patch(draft.key, { text: event.target.value })}
              />
              <Button
                variant="ghost"
                onClick={() => change(drafts.filter((item) => item.key !== draft.key))}
              >
                {t("explorer.removeFilter")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        disabled={drafts.length >= MAX_FILTERS}
        onClick={() =>
          setDrafts([...drafts, { key: next.current++, dimension: "agent", op: "in", text: "" }])
        }
      >
        {t("explorer.addFilter")}
      </Button>
    </div>
  );
}
