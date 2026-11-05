import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import "../styles/export.css";
import { type CsvValue, toCsv } from "./csv";
import { downloadText, sanitizeFilename } from "./download";

export interface TableExportProps {
  /** Already-translated table name, used only for the accessible name. */
  name: string;
  /** File name base without extension, usually the route plus the selected period. */
  filename: string;
  columns: readonly string[];
  rows: readonly (readonly CsvValue[])[];
}

/** CSV download for one table, placed next to its header (spec §9 S7, Phase 4 L30). */
export function TableExport({ name, filename, columns, rows }: TableExportProps) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      disabled={rows.length === 0}
      aria-label={t("export.csvAria", { name })}
      onClick={() =>
        downloadText(
          sanitizeFilename(filename, "csv"),
          toCsv(columns, rows),
          "text/csv;charset=utf-8",
        )
      }
    >
      {t("export.csv")}
    </Button>
  );
}
