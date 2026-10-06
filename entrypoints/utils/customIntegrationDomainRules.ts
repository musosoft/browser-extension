export type CustomIntegration = 'plane' | 'jira';
export type CustomIntegrationDomain = { integration: CustomIntegration; hostname: string };
export const CUSTOM_INTEGRATION_DOMAINS_KEY = 'custom_integration_domains_v1';
export const CUSTOM_DOMAINS_RECONCILE = 'CUSTOM_DOMAINS_RECONCILE';

export function defaultIntegration(hostname: string): CustomIntegration | 'linear' | undefined {
  if (hostname === 'linear.app' || hostname === 'app.linear.app') return 'linear';
  if (hostname === 'atlassian.net' || hostname.endsWith('.atlassian.net')) return 'jira';
  if (hostname === 'app.plane.so') return 'plane';
}

/** Hostnames only: ASCII DNS labels, no URLs, ports, IPs, or wildcard rules. */
export function validateCustomIntegrationDomains(input: unknown): CustomIntegrationDomain[] {
  if (!Array.isArray(input)) throw new Error('Custom domains must be a list');
  const result = new Map<string, CustomIntegrationDomain>();
  for (const item of input) {
    if (!item || (item.integration !== 'plane' && item.integration !== 'jira') || typeof item.hostname !== 'string') {
      throw new Error('Choose Plane or Jira and enter a hostname');
    }
    const hostname: string = item.hostname.trim().toLowerCase();
    const labels = hostname.split('.');
    if (hostname.length > 253 || labels.length < 2 || labels.some(label =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/^[a-z]/.test(labels.at(-1)!) ||
      hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new Error('Enter a DNS hostname only (no URL, path, port, wildcard, or IP address)');
    }
    // URL parsing also catches alternate numeric IP representations and invalid IDNs.
    if (new URL(`https://${hostname}`).hostname !== hostname) throw new Error('Invalid hostname');
    if (defaultIntegration(hostname)) throw new Error('This hostname already has a built-in integration');
    const previous = result.get(hostname);
    if (previous && previous.integration !== item.integration) throw new Error('A hostname can only use one integration');
    result.set(hostname, { integration: item.integration, hostname });
  }
  return [...result.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

/** Invalid persisted data is fail-closed; never derive match patterns from raw storage. */
export function readCustomIntegrationDomains(value: unknown): CustomIntegrationDomain[] {
  try { return validateCustomIntegrationDomains(value ?? []); } catch { return []; }
}

export function integrationForHostname(hostname: string, domains: CustomIntegrationDomain[]) {
  return defaultIntegration(hostname) ?? domains.find(domain => domain.hostname === hostname)?.integration;
}

export function customDomainMatch(hostname: string) { return `*://${hostname}/*`; }

/** One active integration per document, including mapping edits and repeated reconciliation. */
export function createIntegrationRouter(start: (integration: CustomIntegration | 'linear') => () => void) {
  let current: ReturnType<typeof integrationForHostname>;
  let cleanup: (() => void) | undefined;
  return {
    update(hostname: string, domains: CustomIntegrationDomain[]) {
      const next = integrationForHostname(hostname, domains);
      if (next === current) return;
      cleanup?.();
      cleanup = undefined;
      current = next;
      if (next) cleanup = start(next);
    },
    stop() { cleanup?.(); cleanup = undefined; current = undefined; },
  };
}
