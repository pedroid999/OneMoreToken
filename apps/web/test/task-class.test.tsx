// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { PreferencesProvider } from "../src/prefs/usePreferences";
import { SessionView } from "../src/views/SessionView";
import { fakeColorScheme, memoryStorage } from "./helpers";

const id = `${"a".repeat(64)}:session:${"b".repeat(64)}`;
const DETAIL = `/api/sessions/${id}`;
const WRITE = `/api/sessions/${id}/task-class`;

const cost = (usd: number | null, known: number, unknown: number) => ({ usd, known, unknown });

const detail = (taskClass: { value: string; source: string }) => ({
  session: {
    id,
    agent: "claude-code",
    cwd: "project-x",
    branch: "main",
    startedAt: "2026-01-02T10:00:00.000Z",
    endedAt: "2026-01-02T11:00:00.000Z",
    parentId: null,
    turns: 2,
    usageTurns: 1,
    tokens: { input: 1_000_000, output: 200_000, cacheRead: 0, cacheWrite: 0, total: 1_200_000 },
    costs: { reported: cost(null, 0, 1), computed: cost(1.25, 1, 0) },
    compactions: 0,
    children: 0,
  },
  turns: [],
  children: [],
  commits: [],
  pricing: { basis: "historical", observedAt: null },
  taskClass,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetcher = vi.fn<typeof fetch>();
interface Write {
  method: string;
  url: string;
  contentType: string | null;
  body: unknown;
}
let requests: string[] = [];
let writes: Write[] = [];
let get: () => Response | Promise<Response>;
let put: (body: { taskClass: string | null }) => Response | Promise<Response>;

beforeEach(() => {
  window.history.replaceState(null, "", `/session?id=${id}`);
  requests = [];
  writes = [];
  get = () => json(detail({ value: "feature", source: "derived" }));
  put = (body) =>
    json({
      sessionId: id,
      taskClass: body.taskClass ?? "feature",
      source: body.taskClass === null ? "derived" : "corrected",
    });
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { taskClass: string | null };
      const headers = (init?.headers ?? {}) as Record<string, string>;
      writes.push({ method, url, contentType: headers["content-type"] ?? null, body });
      return put(body);
    }
    requests.push(url);
    if (url === DETAIL) return get();
    return json({ error: "not found" }, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function view(language: "en" | "es" = "en") {
  const i18n = await createI18n({ storage: memoryStorage(), browserLanguages: [language] });
  const scheme = fakeColorScheme(false);
  render(
    <I18nextProvider i18n={i18n}>
      <PreferencesProvider
        env={{
          storage: memoryStorage(),
          root: document.documentElement,
          matchMedia: scheme.matchMedia,
        }}
      >
        <SessionView />
      </PreferencesProvider>
    </I18nextProvider>,
  );
  return i18n;
}

const control = () => screen.findByRole("radiogroup", { name: en.session.taskClass.label });
const value = (text: string) => screen.findByText(text);
const derived = () =>
  en.session.taskClass.value
    .replace("{{value}}", en.taskClass.feature)
    .replace("{{source}}", en.taskClass.source.derived);
const corrected = (klass: string) =>
  en.session.taskClass.value
    .replace("{{value}}", klass)
    .replace("{{source}}", en.taskClass.source.corrected);

describe("Session task class (T7, S2)", () => {
  it("shows the derived class next to the session heading", async () => {
    await view();
    const group = await control();
    expect(requests).toContain(DETAIL);
    const heading = screen.getByRole("heading", { level: 1, name: en.session.title });
    expect(heading.parentElement?.contains(group)).toBe(true);
    expect(await value(derived())).toBeTruthy();
    expect(
      within(group)
        .getByRole("radio", { name: en.session.taskClass.auto })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("corrects the class of the session through PUT /api/sessions/:id/task-class", async () => {
    await view();
    const group = await control();
    await value(derived());
    fireEvent.click(within(group).getByRole("radio", { name: en.taskClass.inline }));
    await value(corrected(en.taskClass.inline));
    expect(writes).toEqual([
      {
        method: "PUT",
        url: WRITE,
        contentType: "application/json",
        body: { taskClass: "inline" },
      },
    ]);
    // The class of another session is not touched and the detail is not refetched.
    expect(requests).toEqual([DETAIL]);
  });

  it("sends feature as the correction and shows it as corrected", async () => {
    await view();
    const group = await control();
    await value(derived());
    fireEvent.click(within(group).getByRole("radio", { name: en.taskClass.feature }));
    await value(corrected(en.taskClass.feature));
    expect(writes.at(-1)?.body).toEqual({ taskClass: "feature" });
  });

  it("clears the correction and shows the class as derived again", async () => {
    get = () => json(detail({ value: "inline", source: "corrected" }));
    await view();
    const group = await control();
    await value(corrected(en.taskClass.inline));
    fireEvent.click(within(group).getByRole("radio", { name: en.session.taskClass.auto }));
    await value(derived());
    expect(writes.at(-1)?.body).toEqual({ taskClass: null });
  });

  it("does not write when the chosen class is the current one", async () => {
    await view();
    const group = await control();
    await value(derived());
    fireEvent.click(within(group).getByRole("radio", { name: en.session.taskClass.auto }));
    expect(writes).toEqual([]);
  });

  it("keeps the class on screen and explains a rejected write", async () => {
    put = () => json({ error: "unknown session" }, 404);
    await view();
    const group = await control();
    await value(derived());
    fireEvent.click(within(group).getByRole("radio", { name: en.taskClass.feature }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en.session.taskClass.error)).toBeTruthy();
    expect(await value(derived())).toBeTruthy();
  });

  it("shows the corrected class from the payload in Spanish", async () => {
    get = () => json(detail({ value: "inline", source: "corrected" }));
    await act(async () => {
      await view("es");
    });
    expect(
      await screen.findByText(
        es.session.taskClass.value
          .replace("{{value}}", es.taskClass.inline)
          .replace("{{source}}", es.taskClass.source.corrected),
      ),
    ).toBeTruthy();
    const group = await screen.findByRole("radiogroup", { name: es.session.taskClass.label });
    await waitFor(() =>
      expect(
        within(group)
          .getByRole("radio", { name: es.taskClass.inline })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });
});
