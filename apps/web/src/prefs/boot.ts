import type { HtmlTagDescriptor, Plugin } from "vite";
import { LANGUAGE_STORAGE_KEY, resolveInitialLanguage } from "../i18n/i18n";
import { buildThemeCss } from "../theme/css";
import { BASE_TOKENS, THEME_TOKENS } from "../theme/tokens";
import {
  DENSITY_STORAGE_KEY,
  parseDensity,
  parseThemePrefs,
  resolveTheme,
  THEME_STORAGE_KEY,
} from "./preferences";

// Applies theme, density and language to <html> before first paint, so a stored dark theme never
// flashes light (spec §8.3). It reuses the same functions the app runs, serialized as source.

export function buildBootScript(): string {
  const key = JSON.stringify;
  return `(function () {
  var parseThemePrefs = ${parseThemePrefs.toString()};
  var resolveTheme = ${resolveTheme.toString()};
  var parseDensity = ${parseDensity.toString()};
  var resolveInitialLanguage = ${resolveInitialLanguage.toString()};
  var read = function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } };
  var root = document.documentElement;
  var dark = !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", resolveTheme(parseThemePrefs(read(${key(THEME_STORAGE_KEY)})), dark));
  root.setAttribute("data-density", parseDensity(read(${key(DENSITY_STORAGE_KEY)})));
  root.setAttribute("lang", resolveInitialLanguage(read(${key(LANGUAGE_STORAGE_KEY)}), navigator.languages || []));
})();`;
}

/** Tags injected at the top of index.html <head>: the token CSS, then the boot script. */
export function headTags(): HtmlTagDescriptor[] {
  return [
    { tag: "style", children: buildThemeCss(THEME_TOKENS, BASE_TOKENS), injectTo: "head-prepend" },
    { tag: "script", children: buildBootScript(), injectTo: "head-prepend" },
  ];
}

export function omtHeadPlugin(): Plugin {
  return { name: "omt-head", transformIndexHtml: headTags };
}
