/**
 * Browser persistence for the widget. It stores ONLY the opaque session token
 * the server issued — never messages or contact details (the server owns those).
 */

export interface TokenStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function sessionStorageKey(widgetKey: string): string {
  return `syncore:widget:${widgetKey}`;
}

function localStorageOrNull(): Storage | null {
  try {
    // The getter itself throws when storage is blocked (e.g. third-party iframes with strict privacy settings).
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * `window.localStorage` with an in-memory fallback. Never throws: when storage
 * is unavailable the token lives for the lifetime of the page, so a refresh
 * starts a new conversation instead of breaking the widget.
 */
export function browserTokenStorage(): TokenStorage {
  // Latest writes of this page; wins over localStorage, which may have rejected them (quota, blocked).
  const memory = new Map<string, string>();

  return {
    get(key) {
      const value = memory.get(key);
      if (value !== undefined) return value;
      try {
        return localStorageOrNull()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        localStorageOrNull()?.setItem(key, value);
      } catch {
        // Keep the in-memory copy.
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        localStorageOrNull()?.removeItem(key);
      } catch {
        // Nothing else to clean up.
      }
    },
  };
}
