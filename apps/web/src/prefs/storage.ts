import type { KeyValueStorage } from "../i18n/i18n";

/** localStorage that degrades to memory when the browser blocks it (e.g. private mode). */
export function browserStorage(): KeyValueStorage {
  const memory = new Map<string, string>();
  return {
    getItem(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return memory.get(key) ?? null;
      }
    },
    setItem(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        memory.set(key, value);
      }
    },
  };
}
