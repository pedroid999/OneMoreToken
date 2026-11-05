import { render } from "@testing-library/react";
import type { i18n as I18n } from "i18next";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { expect, vi } from "vitest";
import { createI18n } from "../src/i18n/i18n";

export function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

export async function testI18n(language: "es" | "en" = "en"): Promise<I18n> {
  return createI18n({ storage: memoryStorage(), browserLanguages: [language] });
}

export async function renderWithI18n(ui: ReactElement, language: "es" | "en" = "en") {
  const i18n = await testI18n(language);
  return { i18n, ...render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>) };
}

/** One download the UI handed to the browser (spec §9 S7, Phase 4 L30). */
export interface Download {
  name: string;
  blob: Blob;
}

export interface DownloadSeam {
  downloads: Download[];
  revoked: string[];
  /** Text body of the captured download that was clicked. */
  text(download: Download | undefined): Promise<string>;
  /** Puts the browser object URL helpers and the anchor click back. */
  restore(): void;
}

/**
 * Stubs the browser download seam: object URLs plus the anchor click, so a test observes exactly
 * the bytes the UI would save. Install it in `beforeEach` and `restore()` in `afterEach` (L30).
 */
export function installDownloadSeam(): DownloadSeam {
  const downloads: Download[] = [];
  const revoked: string[] = [];
  const createObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  let pending: Blob | null = null;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      pending = blob;
      return "blob:http://localhost/mock";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (url: string) => void revoked.push(url),
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    if (pending) downloads.push({ name: this.download, blob: pending });
  });
  return {
    downloads,
    revoked,
    async text(download) {
      expect(download, "no download was captured").toBeDefined();
      return (download as Download).blob.text();
    },
    restore() {
      click.mockRestore();
      for (const [key, descriptor] of [
        ["createObjectURL", createObjectURL],
        ["revokeObjectURL", revokeObjectURL],
      ] as const) {
        if (descriptor) Object.defineProperty(URL, key, descriptor);
        else Reflect.deleteProperty(URL, key);
      }
    },
  };
}

/** A controllable prefers-color-scheme media query. */
export function fakeColorScheme(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  return {
    matchMedia: (() => query) as unknown as (q: string) => MediaQueryList,
    setDark(value: boolean) {
      query.matches = value;
      for (const listener of listeners) listener();
    },
  };
}
