import { ref, watch } from "vue";

const defaults = {
  instance_endpoint: "https://app.solidtime.io",
  instance_client_id: "019b27e8-a52a-71d8-8d67-071cff97f315",
};
type Key = keyof typeof defaults;
const keys = Object.keys(defaults) as Key[];
type SettingsBrowser = {
  runtime: { getURL?: (path: "/popup.html") => string };
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
    onChanged: {
      addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void;
    };
  };
};
type SettingsContext = { origin?: string; readLegacy?: (key: string) => string | null };

function validString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function legacyString(value: string | null, fallback: string): string {
  if (!validString(value)) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return validString(parsed) ? parsed : fallback;
  } catch {
    // VueUse versions also stored primitive strings without JSON encoding.
    return /^[\s]*["{\[]/.test(value) ? fallback : value;
  }
}

/** Shared settings only; credential ownership remains with background. */
export function createInstanceSettings(browser: SettingsBrowser, context: SettingsContext = {
  origin: typeof location === "undefined" ? undefined : location.origin,
  readLegacy: (key) => localStorage.getItem(key),
}) {
  let extensionPage = false;
  try {
    const url = new URL(browser.runtime.getURL!("/popup.html"));
    // Some URL implementations report null for extension schemes.
    const origin = url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
    extensionPage = !!url.host && context.origin === origin;
  } catch {
    // Unknown context is never allowed to read or migrate origin localStorage.
  }

  const values = {
    instance_endpoint: ref(defaults.instance_endpoint),
    instance_client_id: ref(defaults.instance_client_id),
  };
  if (extensionPage) {
    for (const key of keys) {
      try {
        values[key].value = legacyString(context.readLegacy?.(key) ?? null, defaults[key]);
      } catch {
        // Disabled/unavailable extension localStorage is equivalent to absent legacy data.
      }
    }
  }

  const revisions = { instance_endpoint: 0, instance_client_id: 0 };
  const dirty = new Set<Key>();
  const known = new Set<Key>();
  let applying = false;
  let writes: Promise<void> = Promise.resolve();
  function apply(key: Key, value: string) {
    applying = true;
    try { values[key].value = value; } finally { applying = false; }
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of keys) {
      if (!changes[key]) continue;
      revisions[key]++;
      const value = changes[key].newValue;
      if (validString(value)) known.add(key);
      else known.delete(key);
      // A delayed event for an earlier write must not erase a newer popup edit.
      if (!dirty.has(key)) apply(key, validString(value) ? value : defaults[key]);
    }
  });

  const initialRevisions = { ...revisions };
  const settingsReady = (async () => {
    try {
      const shared = await browser.storage.local.get(keys);
      const migration: Record<string, string> = {};
      for (const key of keys) {
        if (revisions[key] !== initialRevisions[key] || dirty.has(key)) continue;
        const value = shared[key];
        if (validString(value)) {
          known.add(key);
          apply(key, value);
        } else if (extensionPage) {
          migration[key] = values[key].value;
        }
      }
      if (Object.keys(migration).length) {
        await browser.storage.local.set(migration);
        for (const key of keys) if (key in migration) known.add(key);
      }
    } catch {
      throw new Error("Unable to load instance settings");
    }
  })();
  // Importing an unused API must not create an unhandled rejection. Callers
  // still receive the original failure through the readiness gate.
  void settingsReady.catch(() => {});

  function persistSettings(): Promise<void> {
    const result = writes.then(async () => {
      await settingsReady;
      while (extensionPage && dirty.size) {
        const pending = [...dirty];
        const snapshot = Object.fromEntries(pending.map((key) => [key, values[key].value]));
        if (pending.some((key) => !validString(snapshot[key]))) throw new Error("Invalid instance settings");
        try {
          await browser.storage.local.set(snapshot);
        } catch {
          throw new Error("Unable to save instance settings");
        }
        for (const key of pending) {
          known.add(key);
          if (values[key].value === snapshot[key]) dirty.delete(key);
        }
      }
    });
    writes = result.catch(() => {});
    return result;
  }

  for (const key of keys) {
    watch(values[key], () => {
      if (applying || !extensionPage) return;
      dirty.add(key);
      void persistSettings().catch(() => {});
    }, { flush: "sync" });
  }

  async function waitForSettings(): Promise<void> {
    await persistSettings();
    if (keys.some((key) => !known.has(key))) {
      throw new Error("Instance settings unavailable; open the extension popup to migrate settings");
    }
  }

  return { endpoint: values.instance_endpoint, clientId: values.instance_client_id,
    settingsReady, persistSettings, waitForSettings };
}
