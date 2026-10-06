import { ref } from 'vue';
import { CUSTOM_DOMAINS_RECONCILE, CUSTOM_INTEGRATION_DOMAINS_KEY, customDomainMatch,
  readCustomIntegrationDomains, validateCustomIntegrationDomains } from './customIntegrationDomainRules';
import type { CustomIntegrationDomain } from './customIntegrationDomainRules';
export type { CustomIntegration, CustomIntegrationDomain } from './customIntegrationDomainRules';

export type CustomDomainsBrowser = {
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>>; set(values: Record<string, unknown>): Promise<void> };
    onChanged: { addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void };
  };
  permissions: { contains(permissions: { origins: string[] }): Promise<boolean>; request(permissions: { origins: string[] }): Promise<boolean> };
  runtime: { getManifest(): { manifest_version: number }; sendMessage(message: unknown): Promise<{ success: boolean; error?: string }> };
};

export function createCustomIntegrationDomains(api: CustomDomainsBrowser) {
  const customIntegrationDomains = ref<CustomIntegrationDomain[]>([]);
  let revision = 0;
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[CUSTOM_INTEGRATION_DOMAINS_KEY]) return;
    revision++;
    customIntegrationDomains.value = readCustomIntegrationDomains(changes[CUSTOM_INTEGRATION_DOMAINS_KEY].newValue);
  });
  const initialRevision = revision;
  const customIntegrationDomainsReady = api.storage.local.get(CUSTOM_INTEGRATION_DOMAINS_KEY).then(values => {
    if (revision === initialRevision) customIntegrationDomains.value = readCustomIntegrationDomains(values[CUSTOM_INTEGRATION_DOMAINS_KEY]);
  });
  void customIntegrationDomainsReady.catch(() => {});

  /** Call directly from the popup Save click, BEFORE any other awaited work. */
  async function saveCustomIntegrationDomains(input: CustomIntegrationDomain[]): Promise<void> {
    const domains = validateCustomIntegrationDomains(input);
    const origins = domains.map(domain => customDomainMatch(domain.hostname));
    // Chrome explicitly permits requests for required hosts withheld by the user:
    // https://developer.chrome.com/docs/extensions/reference/api/permissions#method-request
    // No optional_host_permissions declaration is needed for these required hosts.
    // Invoke request BEFORE
    // awaiting anything so the popup's user activation is retained. Firefox MV2
    // already grants the existing required <all_urls>; do not request undeclared
    // optional permissions or broaden its manifest.
    const permission = origins.length === 0 ? Promise.resolve(true) :
      api.runtime.getManifest().manifest_version === 3 ? api.permissions.request({ origins }) : api.permissions.contains({ origins });
    if (!await permission) throw new Error('Site access is unavailable; allow access to the configured sites in the browser extension settings and try again. Custom domains were not saved');
    await customIntegrationDomainsReady;
    const previous = await api.storage.local.get(CUSTOM_INTEGRATION_DOMAINS_KEY);
    await api.storage.local.set({ [CUSTOM_INTEGRATION_DOMAINS_KEY]: domains });
    try {
      const response = await api.runtime.sendMessage({ type: CUSTOM_DOMAINS_RECONCILE });
      if (!response?.success) throw new Error(response?.error ?? 'Custom domain registration failed');
    } catch (error) {
      // Storage events may already have reconciled this write. Restore both the
      // saved mappings and registrations when Save fails. Skip restoration if
      // another popup has already superseded this write (best effort, not CAS).
      const current = await api.storage.local.get(CUSTOM_INTEGRATION_DOMAINS_KEY);
      if (JSON.stringify(current[CUSTOM_INTEGRATION_DOMAINS_KEY]) !== JSON.stringify(domains)) throw error;
      try {
        await api.storage.local.set({ [CUSTOM_INTEGRATION_DOMAINS_KEY]: readCustomIntegrationDomains(previous[CUSTOM_INTEGRATION_DOMAINS_KEY]) });
        const restored = await api.runtime.sendMessage({ type: CUSTOM_DOMAINS_RECONCILE });
        if (!restored?.success) throw new Error('Registration restoration failed');
      } catch {
        throw new Error('Custom domain Save failed and restoration could not be completed; reopen settings to check the saved mappings');
      }
      throw error;
    }
    // The storage listener owns the reactive value, including concurrent writes.
  }
  return { customIntegrationDomains, customIntegrationDomainsReady, saveCustomIntegrationDomains };
}

// The factory is usable in Node tests without WXT's browser auto-import.
const api = typeof browser === 'undefined' ? undefined : browser;
const settings = api ? createCustomIntegrationDomains(api) : undefined;
export const customIntegrationDomains = settings?.customIntegrationDomains ?? ref<CustomIntegrationDomain[]>([]);
export const customIntegrationDomainsReady = settings?.customIntegrationDomainsReady ?? Promise.resolve();
export function saveCustomIntegrationDomains(domains: CustomIntegrationDomain[]): Promise<void> {
  if (!settings) return Promise.reject(new Error('Extension APIs are unavailable'));
  return settings.saveCustomIntegrationDomains(domains);
}
