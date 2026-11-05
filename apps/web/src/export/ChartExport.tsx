import type { RefObject } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import type { ChartHandle } from "../explorer/Chart";
import "../styles/export.css";
import { downloadBlob, downloadText, sanitizeFilename } from "./download";

export interface ChartExportProps {
  /** Imperative handle of the chart panel this control belongs to. */
  chart: RefObject<ChartHandle | null>;
  /** Already-translated chart name, used only for the accessible names. */
  name: string;
  /** File name base without extension, usually the route plus the selected period. */
  filename: string;
}

/** PNG and SVG downloads for one chart, placed in its panel header (spec §9 S7, L30). */
export function ChartExport({ chart, name, filename }: ChartExportProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function toPng(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      const blob = await chart.current?.toPng();
      if (blob) downloadBlob(sanitizeFilename(filename, "png"), blob);
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function toSvg(): Promise<void> {
    setFailed(false);
    const markup = await chart.current?.toSvg();
    if (markup)
      downloadText(sanitizeFilename(filename, "svg"), markup, "image/svg+xml;charset=utf-8");
    else setFailed(true);
  }

  return (
    <div className="export">
      <Button
        variant="ghost"
        loading={busy}
        aria-label={t("export.pngAria", { name })}
        onClick={() => void toPng()}
      >
        {t("export.png")}
      </Button>
      <Button
        variant="ghost"
        aria-label={t("export.svgAria", { name })}
        onClick={() => void toSvg()}
      >
        {t("export.svg")}
      </Button>
      {failed ? (
        <p className="export__error" role="alert">
          {t("export.failed")}
        </p>
      ) : null}
    </div>
  );
}
