// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import type { SavedQuery, SqlResult } from "../src/sql/contract";
import { SqlView } from "../src/sql/SqlView";
import { DEFAULT_SQL } from "../src/sql/state";
import { type DownloadSeam, installDownloadSeam, memoryStorage } from "./helpers";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const result = (patch: Partial<SqlResult> = {}): SqlResult => ({
  columns: [
    { name: "one", type: "INTEGER" },
    { name: "text", type: "VARCHAR" },
  ],
  rows: [[1, "x"]],
  rowCount: 1,
  truncated: false,
  elapsedMs: 7,
  ...patch,
});

const savedQuery = (patch: Partial<SavedQuery> = {}): SavedQuery => ({
  schema: "omt.saved-query/1",
  id: "top-agents",
  name: "Top agents",
  sql: "SELECT agent FROM sessions",
  updatedAt: "2026-01-02T10:00:00.000Z",
  ...patch,
});

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

let calls: Call[];
let views: SavedQuery[];
let queryAnswer: () => Response;
let seam: DownloadSeam;
const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({
    url,
    method,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  });
  if (url === "/api/sql/views" && method === "GET") {
    return json({ views, invalid: [] });
  }
  if (url === "/api/sql/query" && method === "POST") return queryAnswer();
  if (url.startsWith("/api/sql/views/") && method === "PUT") {
    const id = url.slice("/api/sql/views/".length);
    const body = JSON.parse(String(init?.body)) as { name: string; sql: string };
    const stored = savedQuery({ id, ...body });
    views = [...views.filter((view) => view.id !== id), stored];
    return json(stored);
  }
  if (url.startsWith("/api/sql/views/") && method === "DELETE") {
    const id = url.slice("/api/sql/views/".length);
    views = views.filter((view) => view.id !== id);
    return new Response(null, { status: 204 });
  }
  return json({ error: "not found" }, 404);
});

beforeEach(() => {
  calls = [];
  views = [];
  queryAnswer = () => json(result());
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockClear();
  seam = installDownloadSeam();
});
afterEach(() => {
  cleanup();
  seam.restore();
  vi.unstubAllGlobals();
});

async function view(language: "en" | "es" = "en") {
  const i18n = await createI18n({ storage: memoryStorage(), browserLanguages: [language] });
  render(
    <I18nextProvider i18n={i18n}>
      <SqlView />
    </I18nextProvider>,
  );
  return i18n;
}

const editor = () => screen.getByRole("textbox", { name: en.sql.editor }) as HTMLTextAreaElement;
const run = () => fireEvent.click(screen.getByRole("button", { name: en.sql.run }));

function dataCells(): HTMLElement[] {
  const table = screen.getByRole("table", { name: en.sql.result });
  return within(table).getAllByRole("row").slice(1) as HTMLElement[];
}

function cellTexts(row: HTMLElement): (string | null)[] {
  return [...row.querySelectorAll("th, td")].map((cell) => cell.textContent);
}

describe("SQL console (T4, S5)", () => {
  it("shows the console, the default query and the saved queries", async () => {
    views = [savedQuery()];
    await view();
    expect(screen.getByRole("heading", { level: 1, name: en.sql.title })).toBeTruthy();
    expect(editor().value).toBe(DEFAULT_SQL);
    expect(await screen.findByRole("button", { name: "Top agents" })).toBeTruthy();
    expect(calls.filter((call) => call.url === "/api/sql/views")).toHaveLength(1);
  });

  it("runs the editor text and shows typed columns, rows and the summary", async () => {
    await view();
    fireEvent.change(editor(), { target: { value: "SELECT 1 AS one" } });
    run();
    const table = await screen.findByRole("table", { name: en.sql.result });
    expect(calls.find((call) => call.method === "POST")).toMatchObject({
      url: "/api/sql/query",
      body: { sql: "SELECT 1 AS one" },
    });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["oneINTEGER", "textVARCHAR"]);
    expect(cellTexts(dataCells()[0] as HTMLElement)).toEqual(["1", "x"]);
    expect(
      screen.getByText(en.sql.summary_one.replace("{{count}}", "1").replace("{{ms}}", "7")),
    ).toBeTruthy();
    expect(screen.queryByText(en.sql.empty)).toBeNull();
  });

  it("renders null and structured values as readable text", async () => {
    queryAnswer = () =>
      json(
        result({
          columns: [
            { name: "a", type: "INTEGER" },
            { name: "b", type: "INTEGER[]" },
          ],
          rows: [[null, [1, 2]]],
        }),
      );
    await view();
    run();
    await screen.findByRole("table", { name: en.sql.result });
    expect(cellTexts(dataCells()[0] as HTMLElement)).toEqual([en.sql.nullValue, "[1,2]"]);
  });

  it("notes a truncated result instead of pretending it is complete", async () => {
    queryAnswer = () => json(result({ rows: [[1, "x"]], rowCount: 1000, truncated: true }));
    await view();
    run();
    expect(await screen.findByText(en.sql.truncated.replace("{{rows}}", "1000"))).toBeTruthy();
  });

  it("shows the server diagnostic for a rejected query and a timeout message", async () => {
    await view();
    queryAnswer = () =>
      json(
        { error: "query failed", message: 'Parser Error: syntax error at or near "SELEC"' },
        400,
      );
    run();
    expect(await screen.findByText(/Parser Error/)).toBeTruthy();
    expect(screen.getByText(en.sql.error.failed, { exact: false })).toBeTruthy();

    queryAnswer = () => json({ error: "query timed out" }, 504);
    run();
    expect(await screen.findByText(en.sql.error.timeout)).toBeTruthy();

    queryAnswer = () => json({ error: "invalid sql" }, 400);
    run();
    expect(await screen.findByText(en.sql.error.invalid)).toBeTruthy();
  });

  it("saves the current query under a derived id and lists it afterwards", async () => {
    await view();
    fireEvent.change(editor(), { target: { value: "SELECT agent FROM sessions" } });
    fireEvent.change(screen.getByRole("textbox", { name: en.sql.saved.name }), {
      target: { value: "Top agents" },
    });
    fireEvent.click(screen.getByRole("button", { name: en.sql.saved.save }));
    expect(await screen.findByRole("button", { name: "Top agents" })).toBeTruthy();
    expect(calls.find((call) => call.method === "PUT")).toMatchObject({
      url: "/api/sql/views/top-agents",
      body: { name: "Top agents", sql: "SELECT agent FROM sessions" },
    });
    expect(screen.getByText(en.sql.saved.saved)).toBeTruthy();
  });

  it("loads a saved query into the editor and deletes it", async () => {
    views = [savedQuery({ id: "weekly", name: "Weekly", sql: "SELECT 7 AS days" })];
    await view();
    fireEvent.click(await screen.findByRole("button", { name: "Weekly" }));
    expect(editor().value).toBe("SELECT 7 AS days");
    fireEvent.click(
      screen.getByRole("button", { name: en.sql.saved.delete.replace("{{name}}", "Weekly") }),
    );
    await waitFor(() => expect(screen.queryByText("Weekly")).toBeNull());
    expect(calls.find((call) => call.method === "DELETE")).toMatchObject({
      url: "/api/sql/views/weekly",
    });
  });

  it("runs the query with Ctrl+Enter and refuses an empty editor", async () => {
    await view();
    fireEvent.change(editor(), { target: { value: "   " } });
    run();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    fireEvent.change(editor(), { target: { value: "SELECT 2 AS two" } });
    fireEvent.keyDown(editor(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
  });

  it("speaks Spanish when that is the chosen language", async () => {
    await view("es");
    expect(screen.getByRole("heading", { level: 1, name: es.sql.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: es.sql.run })).toBeTruthy();
  });
});

describe("SQL exports (S7, Phase 4 L30)", () => {
  const csv = () =>
    screen.getByRole("button", {
      name: en.export.csvAria.replace("{{name}}", en.sql.result),
    });

  it("downloads the result set as CSV with the column names and raw cells", async () => {
    await view();
    run();
    await screen.findByRole("table", { name: en.sql.result });
    fireEvent.click(csv());
    await waitFor(() => expect(seam.downloads).toHaveLength(1));
    expect(seam.downloads[0]?.name).toBe("sql-result.csv");
    expect(await seam.text(seam.downloads[0])).toBe("one,text\r\n1,x\r\n");
  });

  it("keeps nulls empty and structured cells as their JSON text", async () => {
    queryAnswer = () =>
      json(
        result({
          columns: [
            { name: "a", type: "INTEGER" },
            { name: "b", type: "INTEGER[]" },
          ],
          rows: [[null, [1, 2]]],
        }),
      );
    await view();
    run();
    await screen.findByRole("table", { name: en.sql.result });
    fireEvent.click(csv());
    await waitFor(() => expect(seam.downloads).toHaveLength(1));
    expect(await seam.text(seam.downloads[0])).toBe('a,b\r\n,"[1,2]"\r\n');
  });

  it("offers no CSV before a query runs", async () => {
    await view();
    expect(
      screen.queryByRole("button", {
        name: en.export.csvAria.replace("{{name}}", en.sql.result),
      }),
    ).toBeNull();
  });
});
