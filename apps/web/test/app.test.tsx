// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { fakeColorScheme, memoryStorage } from "./helpers";

const root = document.documentElement;

async function renderApp(
  path: string,
  {
    stored = {},
    prefersDark = false,
  }: { stored?: Record<string, string>; prefersDark?: boolean } = {},
) {
  window.history.replaceState(null, "", path);
  const storage = memoryStorage(stored);
  const scheme = fakeColorScheme(prefersDark);
  const i18n = await createI18n({ storage, browserLanguages: ["es-ES"] });
  await act(async () => {
    render(<App i18n={i18n} env={{ storage, root, matchMedia: scheme.matchMedia }} />);
  });
  return { storage, scheme, i18n };
}

beforeEach(() => {
  for (const name of ["data-theme", "data-density", "lang"]) root.removeAttribute(name);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            period: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" },
            sessions: 0,
            turns: 0,
            usageTurns: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            pricing: { basis: "historical", observedAt: null, staleUsageTurns: 0 },
            costs: {
              reported: { usd: null, known: 0, unknown: 0 },
              computed: { usd: null, known: 0, unknown: 0 },
            },
            days: [],
            issues: { warning: 0, error: 0, critical: 0 },
            quota: { status: "unavailable" },
          }),
        ),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("app shell", () => {
  it("labels the selected 30-day period without counting dates as filters", async () => {
    await renderApp("/?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z");
    expect(screen.getByText(`rango: ${es.summary.last30Days}`)).toBeTruthy();
    expect(screen.getByText(es.status.filters_zero)).toBeTruthy();
  });
  it("offers a skip link to the main content", async () => {
    await renderApp("/");
    const skip = screen.getByRole("link", { name: es.a11y.skipToContent });
    expect(skip.getAttribute("href")).toBe("#main");
    expect(document.getElementById("main")?.tagName).toBe("MAIN");
  });

  it("lists every view in the sidebar and marks the current one", async () => {
    await renderApp("/");
    const nav = screen.getByRole("navigation", { name: es.nav.label });
    expect(nav.querySelectorAll("a")).toHaveLength(11);
    expect(screen.getByRole("link", { name: es.nav.summary }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("navigates with the history API and keeps the query string", async () => {
    await renderApp("/?agent=claude");
    fireEvent.click(screen.getByRole("link", { name: es.nav.settings }));
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("?agent=claude");
    expect(screen.getByRole("heading", { level: 1, name: es.settings.title })).toBeTruthy();
  });

  it("sends unknown routes to Summary and fixes the URL", async () => {
    await renderApp("/nope?agent=claude");
    expect(screen.getByRole("heading", { level: 1, name: es.summary.title })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?agent=claude");
  });

  it("shows the ingest command in the empty Summary (spec §8.4)", async () => {
    await renderApp("/");
    expect(screen.getByText(es.summary.empty.title)).toBeTruthy();
    expect(screen.getByText("pnpm omt ingest").tagName).toBe("CODE");
  });

  it("shows the upcoming phase for views not built yet", async () => {
    await renderApp("/git");
    expect(screen.getByRole("heading", { level: 1, name: es.nav.git })).toBeTruthy();
    expect(screen.getByText("Esta vista llega en la fase 4.")).toBeTruthy();
  });

  it("counts explorer filters but not its structural URL params in the status bar", async () => {
    const filters = encodeURIComponent(
      JSON.stringify([
        { dimension: "agent", op: "in", values: ["pi"] },
        { dimension: "tool", op: "notIn", values: ["bash"] },
      ]),
    );
    await renderApp(
      `/explorer?metrics=total&dimensions=day&chart=bar&view=mi-vista&filters=${filters}`,
    );
    expect(screen.getByRole("contentinfo").textContent).toContain("2 filtros");
  });

  it("shows the explorer at its route instead of the upcoming placeholder", async () => {
    await renderApp("/explorer");
    expect(screen.getByRole("heading", { level: 1, name: es.explorer.title })).toBeTruthy();
    expect(screen.queryByText("Esta vista llega en la fase 2.")).toBeNull();
  });

  it("shows the session view at its route without counting the session id as a filter", async () => {
    const id = `${"a".repeat(64)}:session:${"b".repeat(64)}`;
    await renderApp(`/session?agent=pi&id=${id}`);
    expect(screen.getByRole("heading", { level: 1, name: es.session.title })).toBeTruthy();
    expect(screen.queryByText("Esta vista llega en la fase 2.")).toBeNull();
    expect(screen.getByRole("contentinfo").textContent).toContain("1 filtro");
  });

  it("shows range, plural filters, ingest status and theme mode in the status bar", async () => {
    await renderApp("/?agent=claude&model=opus");
    const bar = screen.getByRole("contentinfo");
    expect(bar.textContent).toContain("rango: últimos 7 días");
    expect(bar.textContent).toContain("2 filtros");
    expect(bar.textContent).toContain(es.status.ingestIdle);
    expect(bar.textContent).toContain("tema: Sistema");
  });

  it("shows the Gentle-AI badge exactly as spec §11.4 in About", async () => {
    await renderApp("/about");
    const badge = screen.getByRole("img", { name: es.about.badgeAlt });
    expect(badge.getAttribute("src")).toBe(
      "https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png",
    );
    expect(badge.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/Gentleman-Programming/gentle-ai",
    );
    expect(
      screen.getByText("Independent project, built with Gentle-AI and gentle-shell."),
    ).toBeTruthy();
  });
});

describe("settings (spec §8.2, §8.3, §8.5)", () => {
  it("applies and persists theme mode and dark variant live", async () => {
    const { storage } = await renderApp("/settings");
    expect(root.dataset.theme).toBe("lotus");

    fireEvent.click(screen.getByRole("radio", { name: es.settings.theme.dark }));
    expect(root.dataset.theme).toBe("wave");
    fireEvent.click(screen.getByRole("radio", { name: es.settings.darkVariant.dragon }));
    expect(root.dataset.theme).toBe("dragon");
    expect(JSON.parse(storage.data.get("omt.theme") ?? "")).toEqual({
      mode: "dark",
      darkVariant: "dragon",
    });
    expect(screen.getByRole("contentinfo").textContent).toContain("tema: Oscuro");

    fireEvent.click(screen.getByRole("radio", { name: es.settings.theme.light }));
    expect(root.dataset.theme).toBe("lotus");
  });

  it("restores stored preferences", async () => {
    await renderApp("/settings", {
      stored: {
        "omt.theme": JSON.stringify({ mode: "dark", darkVariant: "dragon" }),
        "omt.density": "compact",
      },
    });
    expect(root.dataset.theme).toBe("dragon");
    expect(root.dataset.density).toBe("compact");
    expect(
      screen.getByRole("radio", { name: es.settings.density.compact }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("follows OS color scheme changes live in system mode", async () => {
    const { scheme } = await renderApp("/settings", { prefersDark: false });
    expect(root.dataset.theme).toBe("lotus");
    act(() => scheme.setDark(true));
    expect(root.dataset.theme).toBe("wave");
    fireEvent.click(screen.getByRole("radio", { name: es.settings.theme.light }));
    act(() => scheme.setDark(false));
    act(() => scheme.setDark(true));
    expect(root.dataset.theme).toBe("lotus");
  });

  it("applies and persists density live", async () => {
    const { storage } = await renderApp("/settings");
    expect(root.dataset.density).toBe("comfortable");
    fireEvent.click(screen.getByRole("radio", { name: es.settings.density.compact }));
    expect(root.dataset.density).toBe("compact");
    expect(storage.data.get("omt.density")).toBe("compact");
  });

  it("switches language in place, keeps the route and updates <html lang> (S9)", async () => {
    const { storage, i18n } = await renderApp("/settings?agent=claude");
    expect(root.lang).toBe("es");
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "English" }));
    });
    expect(i18n.language).toBe("en");
    expect(root.lang).toBe("en");
    expect(storage.data.get("omt.language")).toBe("en");
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.search).toBe("?agent=claude");
    expect(screen.getByRole("heading", { level: 1, name: en.settings.title })).toBeTruthy();
    expect(screen.getByRole("contentinfo").textContent).toContain("1 filter");
  });
});
