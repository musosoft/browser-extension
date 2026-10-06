import {
  isLinearIssuePage,
  getLinearIssueInfo,
  getIssueTitleFromDOM as getLinearTitleFromDOM,
  findPropertiesSidebar,
  waitForElement as waitForLinearElement,
  injectTimeTrackingSection,
  removeTimeTrackingSection,
} from "./utils/linear";

import {
  isJiraIssuePage,
  getJiraIssueInfo,
  getIssueTitleFromDOM as getJiraTitleFromDOM,
  findJiraActionsWrapper,
  waitForElement as waitForJiraElement,
  observeJiraActionsWrapper,
  injectJiraTimeTrackingButton,
  removeJiraTimeTrackingButton,
} from "./utils/jira";

import { initializePlaneTracking } from "./utils/plane";
import { CUSTOM_INTEGRATION_DOMAINS_KEY, createIntegrationRouter, readCustomIntegrationDomains } from './utils/customIntegrationDomainRules';

export default defineContentScript({
  matches: [
    "*://linear.app/*",
    "*://app.linear.app/*",
    "*://*.atlassian.net/*",
    "*://app.plane.so/*",
  ],
  async main(ctx) {
    const router = createIntegrationRouter(integration => {
      if (integration === 'linear') return initializeLinear();
      if (integration === 'jira') return initializeJira();
      return initializePlaneTracking();
    });
    let revision = 0;
    const changed = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (ctx.isInvalid || area !== 'local' || !changes[CUSTOM_INTEGRATION_DOMAINS_KEY]) return;
      revision++;
      router.update(window.location.hostname, readCustomIntegrationDomains(changes[CUSTOM_INTEGRATION_DOMAINS_KEY].newValue));
    };
    browser.storage.onChanged.addListener(changed);
    ctx.onInvalidated(() => {
      browser.storage.onChanged.removeListener(changed);
      router.stop();
    });
    const initialRevision = revision;
    try {
      const values = await browser.storage.local.get(CUSTOM_INTEGRATION_DOMAINS_KEY);
      if (ctx.isValid && revision === initialRevision) router.update(window.location.hostname, readCustomIntegrationDomains(values[CUSTOM_INTEGRATION_DOMAINS_KEY]));
    } catch {
      // Static defaults remain functional even if custom storage cannot be read.
      if (ctx.isValid && revision === initialRevision) router.update(window.location.hostname, []);
    }
  },
});

// Linear integration
function initializeLinear() {
  let active = true;
  // Function to inject time tracking if on a Linear issue page
  async function handlePageLoad() {
    if (!active) return;
    // Check if we're on an issue page
    if (!isLinearIssuePage()) {
      removeTimeTrackingSection();
      return;
    }

    // Don't inject if already exists
    if (document.getElementById("solidtime-time-tracking-section")) {
      return;
    }

    try {
      // Wait for the properties sidebar to load
      const propertiesSidebar = await waitForLinearElement(
        findPropertiesSidebar,
        5000,
      );

      if (!active || !propertiesSidebar) {
        return;
      }

      // Get issue information
      const issueInfo = getLinearIssueInfo();
      if (!issueInfo) {
        return;
      }

      // Get the issue title from DOM (more reliable than URL)
      const issueTitle =
        getLinearTitleFromDOM() || issueInfo.issueTitle || issueInfo.issueId;

      // Create issue description for time entry
      const issueDescription = `${issueInfo.issueId} ${issueTitle}`;

      // Inject the time tracking section
      await injectTimeTrackingSection(propertiesSidebar, issueDescription);
      if (!active) removeTimeTrackingSection();
    } catch (error) {
      console.error(
        "Solidtime: Failed to inject time tracking section:",
        error,
      );
    }
  }

  // Initial load
  handlePageLoad();

  // Watch for URL changes (Linear is an SPA)
  const stopUrlObserver = observeIntegrationUrlChanges(() => {
    handlePageLoad();
  });
  return () => { active = false; stopUrlObserver(); removeTimeTrackingSection(); };
}

// Jira integration
function initializeJira() {
  let active = true;
  // Keep track of the current observer
  let actionsWrapperObserver: MutationObserver | null = null;

  // Function to inject time tracking if on a Jira issue page
  async function handlePageLoad() {
    if (!active) return;
    // Disconnect previous observer if it exists
    if (actionsWrapperObserver) {
      actionsWrapperObserver.disconnect();
      actionsWrapperObserver = null;
    }

    // Check if we're on an issue page
    if (!isJiraIssuePage()) {
      removeJiraTimeTrackingButton();
      return;
    }

    // Don't inject if already exists
    if (document.getElementById("solidtime-jira-button-wrapper")) {
      return;
    }

    try {
      // Wait for the actions wrapper to load
      const actionsWrapper = await waitForJiraElement(
        findJiraActionsWrapper,
        5000,
      );

      if (!active || !actionsWrapper) {
        return;
      }

      // Get issue information
      const issueInfo = getJiraIssueInfo();
      if (!issueInfo) {
        return;
      }

      // Get the issue title from DOM (more reliable than just the issue key)
      const issueTitle = getJiraTitleFromDOM() || issueInfo.issueKey;

      // Create issue description for time entry
      const issueDescription = `${issueInfo.issueKey} ${issueTitle}`;

      // Inject the time tracking button
      await injectJiraTimeTrackingButton(actionsWrapper, issueDescription);
      if (!active) { removeJiraTimeTrackingButton(); return; }

      // Set up observer to watch for DOM changes that might remove the button
      // This observes the entire document body to catch when the actions wrapper itself gets replaced
      actionsWrapperObserver = observeJiraActionsWrapper(issueDescription);
    } catch (error) {
      console.error(
        "Solidtime: Failed to inject Jira time tracking button:",
        error,
      );
    }
  }

  // Initial load
  handlePageLoad();

  // Watch for URL changes (Jira is an SPA)
  const stopUrlObserver = observeIntegrationUrlChanges(() => { void handlePageLoad(); });
  return () => {
    active = false;
    stopUrlObserver();
    actionsWrapperObserver?.disconnect();
    removeJiraTimeTrackingButton();
  };
}

// Both observers and popstate listeners must stop when WXT invalidates a copy
// (e.g. an immediate injection racing with a registered navigation injection).
function observeIntegrationUrlChanges(callback: () => void): () => void {
  let lastUrl = window.location.href;
  const urlObserver = new MutationObserver(() => {
    if (lastUrl !== window.location.href) { lastUrl = window.location.href; callback(); }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });
  const popstate = callback;
  window.addEventListener('popstate', popstate);
  return () => {
    urlObserver.disconnect();
    window.removeEventListener('popstate', popstate);
  };
}
