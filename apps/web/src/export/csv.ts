/** One exported cell: raw data, never the formatted text the table renders (L30). */
export type CsvValue = string | number | boolean | null | undefined;

/** A cell needs quotes when it holds a separator, a quote, a line break or edge spaces. */
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/;

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * RFC 4180 CSV for one table: a header row from the given labels, CRLF records, a cell quoted
 * only when it needs it, and raw values (spec §9 S7, Phase 4 L30).
 */
export function toCsv(columns: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [columns as readonly CsvValue[], ...rows].map((row) => row.map(cell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
