import { CUSTOM_INTEGRATION_DOMAINS_KEY, customDomainMatch, readCustomIntegrationDomains } from './customIntegrationDomainRules';
import type { CustomIntegrationDomain } from './customIntegrationDomainRules';

export const CUSTOM_SCRIPT_PREFIX = 'solidtime-custom-';
// Verified against both WXT production manifests; use the same packaged bundle
// as the static integrations, not eval/code strings or a second entrypoint.
export const CONTENT_BUNDLE = 'content-scripts/content.js';
type Script = { id: string; matches?: string[]; js?: string[]; persistAcrossSessions?: boolean; runAt?: string; allFrames?: boolean };
type Registration = { unregister(): Promise<void> };
export type RegistrationBrowser = {
  runtime: { getManifest(): { manifest_version: number } };
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
  permissions: { contains(permission: { origins: string[] }): Promise<boolean> };
  scripting?: {
    getRegisteredContentScripts(): Promise<Script[]>;
    registerContentScripts(scripts: Script[]): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
    executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
  contentScripts?: { register(script: { matches: string[]; js: { file: string }[]; runAt: 'document_idle'; allFrames: false }): Promise<Registration> };
  tabs: {
    query(query: { url: string[] }): Promise<{ id?: number; url?: string }[]>;
    executeScript?(tabId: number, details: { file: string; runAt: 'document_idle'; allFrames: false }): Promise<unknown>;
  };
};

export function createCustomIntegrationRegistration(api: RegistrationBrowser) {
  const firefoxRegistrations = new Map<string, Registration>();
  let injectedMappings = new Map<string, string>();
  let initialized = false;
  let queue = Promise.resolve();
  async function reconcileNow() {
    const values = await api.storage.local.get(CUSTOM_INTEGRATION_DOMAINS_KEY);
    const configured = readCustomIntegrationDomains(values[CUSTOM_INTEGRATION_DOMAINS_KEY]);
    const domains: CustomIntegrationDomain[] = [];
    for (const domain of configured) {
      if (await api.permissions.contains({ origins: [customDomainMatch(domain.hostname)] })) domains.push(domain);
    }
    const desired = new Map(domains.map(domain => [CUSTOM_SCRIPT_PREFIX + domain.hostname, customDomainMatch(domain.hostname)]));
    if (api.runtime.getManifest().manifest_version === 3) {
      const scripting = api.scripting;
      if (!scripting?.registerContentScripts) throw new Error('Dynamic content scripts require Chrome 96 or newer');
      const existing = (await scripting.getRegisteredContentScripts()).filter(script => script.id.startsWith(CUSTOM_SCRIPT_PREFIX));
      const valid = (script: Script) => desired.get(script.id) === script.matches?.[0] && script.matches?.length === 1 &&
        script.js?.length === 1 && script.js[0] === CONTENT_BUNDLE && script.persistAcrossSessions === true &&
        script.runAt === 'document_idle' && script.allFrames === false;
      const stale = existing.filter(script => !valid(script));
      if (stale.length) await scripting.unregisterContentScripts({ ids: stale.map(script => script.id) });
      const retained = new Set(existing.filter(valid).map(script => script.id));
      // MV3 workers restart routinely. Persistent registrations have already
      // initialized existing documents; adopting them must not reinject tabs.
      if (!initialized) injectedMappings = new Map(domains
        .filter(domain => retained.has(CUSTOM_SCRIPT_PREFIX + domain.hostname))
        .map(domain => [domain.hostname, domain.integration]));
      const missing = [...desired].filter(([id]) => !retained.has(id));
      if (missing.length) await scripting.registerContentScripts(missing.map(([id, match]) => ({
        id, matches: [match], js: [CONTENT_BUNDLE], persistAcrossSessions: true, runAt: 'document_idle', allFrames: false,
      })));
    } else {
      // Firefox MV2 has no persistent scripting API. Its persistent background
      // page owns the registration handles and restores them on every startup.
      if (!api.contentScripts?.register || !api.tabs.executeScript) throw new Error('Firefox MV2 contentScripts API is unavailable');
      for (const [id, registration] of firefoxRegistrations) {
        if (!desired.has(id)) { await registration.unregister(); firefoxRegistrations.delete(id); }
      }
      for (const [id, match] of desired) {
        if (!firefoxRegistrations.has(id)) firefoxRegistrations.set(id, await api.contentScripts.register({
          matches: [match], js: [{ file: '/' + CONTENT_BUNDLE }], runAt: 'document_idle', allFrames: false,
        }));
      }
    }
    // Registration affects future documents only. Best-effort injection enables
    // existing tabs too; a closed/restricted/navigated tab must not fail Save.
    // WXT invalidates the older copy on reinjection and content.ts cleans up.
    const changedDomains = domains.filter(domain => injectedMappings.get(domain.hostname) !== domain.integration);
    injectedMappings = new Map(domains.map(domain => [domain.hostname, domain.integration]));
    initialized = true;
    if (!changedDomains.length) return;
    let tabs: { id?: number; url?: string }[];
    try { tabs = await api.tabs.query({ url: changedDomains.map(domain => customDomainMatch(domain.hostname)) }); }
    catch { return; }
    await Promise.all(tabs.map(async tab => {
      if (tab.id === undefined || !tab.url) return;
      try {
        const url = new URL(tab.url);
        if (!['http:', 'https:'].includes(url.protocol) || !changedDomains.some(domain => domain.hostname === url.hostname)) return;
        if (api.runtime.getManifest().manifest_version === 3) {
          await api.scripting!.executeScript({ target: { tabId: tab.id }, files: [CONTENT_BUNDLE] });
        } else {
          await api.tabs.executeScript!(tab.id, { file: '/' + CONTENT_BUNDLE, runAt: 'document_idle', allFrames: false });
        }
      } catch { /* Tabs can disappear or become restricted between query/injection. */ }
    }));
  }
  return {
    reconcile(): Promise<void> {
      const result = queue.then(reconcileNow);
      queue = result.catch(() => {});
      return result;
    },
  };
}
