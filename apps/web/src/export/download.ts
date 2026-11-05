/**
 * Lowercase dash-separated file base with the extension, never empty (Phase 4 L30). The base
 * names the route and the selected period; it holds no clock, so a repeated export is stable.
 */
export function sanitizeFilename(base: string, extension: string): string {
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${clean === "" ? "export" : clean}.${extension}`;
}

/** File base suffix for a selected period: both UTC dates, without a clock (L30). */
export function rangeSlug(from: string, to: string): string {
  return `${from.slice(0, 10)}-${to.slice(0, 10)}`;
}

/** Hands one blob to the browser as a download through a temporary object URL (L30). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a later task so a browser that reads the URL after the click can finish (L30).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(filename: string, text: string, mime: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}
