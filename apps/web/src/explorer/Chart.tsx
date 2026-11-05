import type { RefObject } from "react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { View } from "vega";
import embed, { type EmbedOptions, type VisualizationSpec } from "vega-embed";
import { ErrorState } from "../components/ErrorState";
import { dataUrlToBlob } from "../export/image";
import type { Language } from "../i18n/i18n";
import { usePreferences } from "../prefs/usePreferences";
import { BASE_TOKENS, THEME_TOKENS } from "../theme/tokens";
import { buildVegaConfig } from "../theme/vega";
import { type DatasetMap, injectData } from "./state";

export interface ChartProps {
  /** Data-free spec (L16), already localized; values are injected right before rendering. */
  spec: Record<string, unknown>;
  datasets: DatasetMap;
  /** Accessible chart name, already translated; the data table is the text alternative. */
  label: string;
  language: Language;
  /** Optional handle so the view can export the rendered chart (spec §9, L30). */
  chartRef?: RefObject<ChartHandle | null> | undefined;
}

/** Export surface of one mounted chart; both calls resolve null when the view is gone. */
export interface ChartHandle {
  toSvg(): Promise<string | null>;
  toPng(scale?: number): Promise<Blob | null>;
}

const LOCALES: Record<Language, string> = { es: "es-ES", en: "en-US" };

/** d3 number and time locales derived from Intl, so axes follow the UI language (spec §8.5). */
function vegaLocales(language: Language): Pick<EmbedOptions, "formatLocale" | "timeFormatLocale"> {
  const locale = LOCALES[language];
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  const thousands = parts.find((p) => p.type === "group")?.value ?? ",";
  const names = (options: Intl.DateTimeFormatOptions, count: number, date: (i: number) => Date) =>
    Array.from({ length: count }, (_, i) =>
      new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(date(i)),
    );
  // 2023-01-01 is a Sunday: d3 day arrays start on Sunday.
  const day = (i: number) => new Date(Date.UTC(2023, 0, 1 + i));
  const month = (i: number) => new Date(Date.UTC(2023, i, 1));
  return {
    formatLocale: {
      decimal,
      thousands,
      grouping: [3],
      currency: language === "es" ? ["", "\u00a0US$"] : ["$", ""],
    },
    timeFormatLocale: {
      dateTime: "%x, %X",
      date: language === "es" ? "%d/%m/%Y" : "%m/%d/%Y",
      time: "%H:%M:%S",
      periods: ["AM", "PM"],
      days: names({ weekday: "long" }, 7, day),
      shortDays: names({ weekday: "short" }, 7, day),
      months: names({ month: "long" }, 12, month),
      shortMonths: names({ month: "short" }, 12, month),
    },
  } as Pick<EmbedOptions, "formatLocale" | "timeFormatLocale">;
}

/** Vega/Vega-Lite rendering bound to the active theme tokens (spec §8.2). */
export function Chart({ spec, datasets, label, language, chartRef }: ChartProps) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<View | null>(null);
  const { resolvedTheme } = usePreferences();
  const config = useMemo(() => {
    const theme = THEME_TOKENS.themes[resolvedTheme];
    return { ...buildVegaConfig(theme, BASE_TOKENS), text: { fill: theme.colors.fg } };
  }, [resolvedTheme]);
  const locales = useMemo(() => vegaLocales(language), [language]);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element || attempt < 0) return;
    let cancelled = false;
    let finalize: (() => void) | undefined;
    setFailed(false);
    embed(element, injectData(spec, datasets) as VisualizationSpec, {
      config,
      actions: false,
      renderer: "svg",
      ...locales,
    })
      .then((result) => {
        if (cancelled) {
          result.view.finalize();
          return;
        }
        view.current = result.view;
        finalize = () => {
          view.current = null;
          result.view.finalize();
        };
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      finalize?.();
    };
  }, [spec, datasets, config, locales, attempt]);

  // The view stays alive while the chart is mounted so it can be exported (S7, L30).
  useImperativeHandle(
    chartRef,
    () => ({
      async toSvg() {
        const current = view.current;
        if (!current) return null;
        try {
          return current.toSVG();
        } catch {
          return null;
        }
      },
      async toPng(scale = 2) {
        const current = view.current;
        if (!current) return null;
        try {
          return dataUrlToBlob(await current.toImageURL("png", scale));
        } catch {
          return null;
        }
      },
    }),
    [],
  );

  return (
    <>
      {/* Vega rewrites its host role and aria-label (untranslated), so the name lives on a wrapper. */}
      <div role="img" aria-label={label} className="explorer__chart">
        <div ref={host} />
      </div>
      {failed ? (
        <ErrorState message={t("explorer.chartError")} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
    </>
  );
}
