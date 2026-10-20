import i18next, { type i18n as I18n } from "i18next";
import en from "./en.json";
import es from "./es.json";

export const SUPPORTED_LANGUAGES = ["es", "en"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "es";
export const LANGUAGE_STORAGE_KEY = "omt.language";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isLanguage = (value: string | null | undefined): value is Language =>
  SUPPORTED_LANGUAGES.includes(value as Language);

/**
 * Stored choice first, then the browser languages, then Spanish (spec §8.5).
 * Serialized into the pre-paint boot script (src/prefs/boot.ts): keep it self-contained.
 */
export function resolveInitialLanguage(
  stored: string | null,
  browserLanguages: readonly string[],
): Language {
  const supported = (value: string | null | undefined): value is Language =>
    value === "es" || value === "en";
  if (supported(stored)) return stored;
  for (const tag of browserLanguages) {
    const base = tag.toLowerCase().split("-")[0];
    if (supported(base)) return base;
  }
  return "es";
}

export interface CreateI18nOptions {
  storage: KeyValueStorage;
  browserLanguages: readonly string[];
}

/** Creates an isolated i18next instance; changeLanguage switches in place and persists the choice. */
export async function createI18n({ storage, browserLanguages }: CreateI18nOptions): Promise<I18n> {
  const instance = i18next.createInstance();
  await instance.init({
    resources: { es: { translation: es }, en: { translation: en } },
    lng: resolveInitialLanguage(storage.getItem(LANGUAGE_STORAGE_KEY), browserLanguages),
    fallbackLng: false,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  let ready = false;
  instance.on("languageChanged", (language) => {
    if (ready && isLanguage(language)) storage.setItem(LANGUAGE_STORAGE_KEY, language);
  });
  ready = true;
  return instance;
}
