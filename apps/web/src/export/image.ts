/** Turns the data URL vega returns for a raster chart into a downloadable blob (L30). */
export function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("not a data url");
  const header = url.slice(0, comma);
  const mime = /^data:([^;,]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const body = url.slice(comma + 1);
  if (!header.includes(";base64")) return new Blob([decodeURIComponent(body)], { type: mime });
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}
