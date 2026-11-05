// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chart, type ChartHandle } from "../src/explorer/Chart";
import { ChartExport } from "../src/export/ChartExport";
import { toCsv } from "../src/export/csv";
import { downloadBlob, downloadText, sanitizeFilename } from "../src/export/download";
import { dataUrlToBlob } from "../src/export/image";
import { TableExport } from "../src/export/TableExport";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { PreferencesProvider } from "../src/prefs/usePreferences";
import {
  type Download,
  type DownloadSeam,
  fakeColorScheme,
  installDownloadSeam,
  memoryStorage,
  renderWithI18n,
} from "./helpers";

let seam: DownloadSeam;
let downloads: Download[];
let revoked: string[];

beforeEach(() => {
  seam = installDownloadSeam();
  downloads = seam.downloads;
  revoked = seam.revoked;
});

afterEach(() => {
  cleanup();
  seam.restore();
});

async function text(download: Download | undefined): Promise<string> {
  return seam.text(download);
}

describe("toCsv (S7: any table to CSV)", () => {
  it("writes a header row and CRLF records from raw values", () => {
    expect(
      toCsv(
        ["date", "agent", "tokens"],
        [
          ["2026-10-31", "claude-code", 301045678],
          ["2026-10-30", "opencode", 88421330],
        ],
      ),
    ).toBe(
      "date,agent,tokens\r\n2026-10-31,claude-code,301045678\r\n2026-10-30,opencode,88421330\r\n",
    );
  });

  it("writes the header alone when there are no rows", () => {
    expect(toCsv(["agent", "tokens"], [])).toBe("agent,tokens\r\n");
  });

  it("quotes only the cells that need it and doubles inner quotes", () => {
    expect(toCsv(["a", "b", "c", "d"], [["plain", "with,comma", 'say "hi"', "two\nlines"]])).toBe(
      'a,b,c,d\r\nplain,"with,comma","say ""hi""","two\nlines"\r\n',
    );
  });

  it("quotes cells with leading or trailing spaces", () => {
    expect(toCsv(["a"], [[" pad "]])).toBe('a\r\n" pad "\r\n');
  });

  it("renders null and undefined as an empty cell", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\r\n,\r\n");
  });

  it("writes numbers without grouping and with a dot decimal separator", () => {
    expect(toCsv(["cost"], [[1234.5]])).toBe("cost\r\n1234.5\r\n");
  });

  it("writes booleans as true and false", () => {
    expect(toCsv(["had"], [[true], [false]])).toBe("had\r\ntrue\r\nfalse\r\n");
  });
});

describe("sanitizeFilename", () => {
  it("lowercases, collapses separators and appends the extension", () => {
    expect(sanitizeFilename("Git Commits (2026-10)", "csv")).toBe("git-commits-2026-10.csv");
  });

  it("falls back when nothing usable is left", () => {
    expect(sanitizeFilename("///", "png")).toBe("export.png");
  });
});

describe("download helper", () => {
  it("downloads text through an object URL and revokes it", async () => {
    downloadText("one.csv", "a,b\r\n", "text/csv;charset=utf-8");
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toBe("one.csv");
    expect(downloads[0]?.blob.type).toBe("text/csv;charset=utf-8");
    expect(await text(downloads[0])).toBe("a,b\r\n");
    await waitFor(() => expect(revoked).toEqual(["blob:http://localhost/mock"]));
  });

  it("downloads a binary blob unchanged", async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    downloadBlob("chart.png", blob);
    expect(downloads[0]?.name).toBe("chart.png");
    expect(downloads[0]?.blob.type).toBe("image/png");
    expect(new Uint8Array(await (downloads[0] as Download).blob.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });

  it("converts the data url vega returns into an image blob", async () => {
    expect(await dataUrlToBlob("data:image/png;base64,UE5H").text()).toBe("PNG");
    const png = dataUrlToBlob("data:image/png;base64,iVBORw0KGgo=");
    expect(png.type).toBe("image/png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(dataUrlToBlob("data:image/svg+xml;charset=utf-8,%3Csvg%3E").type).toBe("image/svg+xml");
  });
});

describe("TableExport", () => {
  const rows = [
    ["a1b2c3d", 42],
    ["e4f5g6h", null],
  ] as const;

  it("downloads the raw rows as CSV named after the view", async () => {
    await renderWithI18n(
      <TableExport
        name="Commits"
        filename="git-commits-2026-10"
        columns={["sha", "tokens"]}
        rows={[...rows]}
      />,
    );
    const button = screen.getByRole("button", {
      name: en.export.csvAria.replace("{{name}}", "Commits"),
    });
    expect(button.textContent).toBe(en.export.csv);
    fireEvent.click(button);
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]?.name).toBe("git-commits-2026-10.csv");
    expect(await text(downloads[0])).toBe("sha,tokens\r\na1b2c3d,42\r\ne4f5g6h,\r\n");
  });

  it("is inert with no rows", async () => {
    await renderWithI18n(
      <TableExport name="Commits" filename="git-commits" columns={["sha"]} rows={[]} />,
    );
    const button = screen.getByRole("button", {
      name: en.export.csvAria.replace("{{name}}", "Commits"),
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(downloads).toHaveLength(0);
  });

  it("uses the Spanish labels", async () => {
    await renderWithI18n(
      <TableExport name="Commits" filename="c" columns={["sha"]} rows={[["x"]]} />,
      "es",
    );
    expect(
      screen.getByRole("button", { name: es.export.csvAria.replace("{{name}}", "Commits") }),
    ).toBeTruthy();
  });
});

function handle(overrides: Partial<ChartHandle> = {}): RefObject<ChartHandle | null> {
  return {
    current: {
      toSvg: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      toPng: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      ...overrides,
    },
  };
}

describe("ChartExport", () => {
  it("downloads the chart as PNG and as SVG", async () => {
    await renderWithI18n(
      <ChartExport chart={handle()} filename="git-tokens-per-commit" name="Tokens per commit" />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: en.export.pngAria.replace("{{name}}", "Tokens per commit"),
      }),
    );
    await waitFor(() =>
      expect(downloads.map((d) => d.name)).toEqual(["git-tokens-per-commit.png"]),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: en.export.svgAria.replace("{{name}}", "Tokens per commit"),
      }),
    );
    await waitFor(() =>
      expect(downloads.map((d) => d.name)).toEqual([
        "git-tokens-per-commit.png",
        "git-tokens-per-commit.svg",
      ]),
    );
    expect(await text(downloads[1])).toContain("<svg");
    expect(downloads[1]?.blob.type).toBe("image/svg+xml;charset=utf-8");
  });

  it("reports a failed chart export", async () => {
    await renderWithI18n(
      <ChartExport chart={handle({ toPng: async () => null })} filename="chart" name="Chart" />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.export.pngAria.replace("{{name}}", "Chart") }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(en.export.failed);
    expect(downloads).toHaveLength(0);
  });
});

describe("Chart handle (S7: any chart to PNG/SVG)", () => {
  it("keeps the vega view and returns its SVG", async () => {
    const chart: RefObject<ChartHandle | null> = { current: null };
    const i18n = await createI18n({ storage: memoryStorage(), browserLanguages: ["en"] });
    const scheme = fakeColorScheme(false);
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <PreferencesProvider
          env={{
            storage: memoryStorage(),
            root: document.documentElement,
            matchMedia: scheme.matchMedia,
          }}
        >
          <Chart
            chartRef={chart}
            label="Tokens per commit"
            language="en"
            spec={{
              $schema: "https://vega.github.io/schema/vega-lite/v6.json",
              data: { name: "table" },
              mark: { type: "point" },
              encoding: {
                x: { field: "at", type: "temporal" },
                y: { field: "tokens", type: "quantitative" },
              },
            }}
            datasets={{ table: [{ at: "2026-10-01", tokens: 10 }] }}
          />
        </PreferencesProvider>
      </I18nextProvider>,
    );
    await waitFor(() => expect(container.querySelector("svg")).not.toBeNull(), { timeout: 5000 });
    await waitFor(() => expect(chart.current).not.toBeNull());
    const svg = await chart.current?.toSvg();
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
});
