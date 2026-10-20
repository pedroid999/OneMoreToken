// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildBootScript, headTags, omtHeadPlugin } from "../src/prefs/boot";

function stubMatchMedia(prefersDark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("dark") ? prefersDark : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

function runBoot() {
  new Function(buildBootScript())();
}

const root = document.documentElement;

afterEach(() => {
  localStorage.clear();
  for (const name of ["data-theme", "data-density", "lang"]) root.removeAttribute(name);
});

describe("boot script (spec §8.3: no flicker)", () => {
  it("applies stored theme, density and language before React mounts", () => {
    stubMatchMedia(false);
    localStorage.setItem("omt.theme", JSON.stringify({ mode: "dark", darkVariant: "dragon" }));
    localStorage.setItem("omt.density", "compact");
    localStorage.setItem("omt.language", "en");
    runBoot();
    expect(root.dataset.theme).toBe("dragon");
    expect(root.dataset.density).toBe("compact");
    expect(root.lang).toBe("en");
  });

  it("follows the OS in system mode when nothing is stored", () => {
    stubMatchMedia(true);
    runBoot();
    expect(root.dataset.theme).toBe("wave");
    expect(root.dataset.density).toBe("comfortable");
    stubMatchMedia(false);
    runBoot();
    expect(root.dataset.theme).toBe("lotus");
  });

  it("uses the browser language, then Spanish", () => {
    stubMatchMedia(false);
    runBoot();
    expect(["es", "en"]).toContain(root.lang);
    Object.defineProperty(navigator, "languages", { value: ["fr-FR"], configurable: true });
    runBoot();
    expect(root.lang).toBe("es");
  });

  it("still sets a theme when storage holds garbage", () => {
    stubMatchMedia(true);
    localStorage.setItem("omt.theme", "{oops");
    runBoot();
    expect(root.dataset.theme).toBe("wave");
  });
});

describe("omtHeadPlugin", () => {
  it("injects the token CSS and the boot script into <head>", () => {
    expect(omtHeadPlugin().transformIndexHtml).toBe(headTags);
    const tags = headTags();
    const style = tags.find((t) => t.tag === "style");
    const script = tags.find((t) => t.tag === "script");
    expect(style?.children).toContain(':root[data-theme="lotus"]');
    expect(style?.injectTo).toBe("head-prepend");
    expect(script?.children).toContain("omt.theme");
    expect(script?.injectTo).toBe("head-prepend");
  });
});
