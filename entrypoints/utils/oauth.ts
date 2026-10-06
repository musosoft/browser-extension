import { computed, ref } from "vue";
import { createInstanceSettings } from "./instanceSettings";

export const { endpoint, clientId, settingsReady, persistSettings, waitForSettings } =
  createInstanceSettings(browser);

// Use chrome.storage for tokens (survives popup closing)
export const accessToken = ref("");
export const refreshToken = ref("");
let tokenStorageRevision = 0;

// Load tokens from chrome.storage on init
async function loadTokens() {
  const revision = tokenStorageRevision;
  const result = await browser.storage.local.get([
    "access_token",
    "refresh_token",
  ]);
  // A newer token event takes precedence over the initial storage snapshot.
  if (revision !== tokenStorageRevision) return;
  accessToken.value = typeof result.access_token === "string" ? result.access_token : "";
  refreshToken.value = typeof result.refresh_token === "string" ? result.refresh_token : "";
}

// Watch for storage changes (from background script)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.access_token || changes.refresh_token) {
      tokenStorageRevision++;
    }
    if (changes.access_token) {
      accessToken.value = typeof changes.access_token.newValue === "string" ? changes.access_token.newValue : "";
    }
    if (changes.refresh_token) {
      refreshToken.value = typeof changes.refresh_token.newValue === "string" ? changes.refresh_token.newValue : "";
    }
  }
});

// Initialize
loadTokens();

// Use browser.identity.getRedirectURL() which works for both Firefox and Chrome
export const getRedirectUrl = () => browser.identity.getRedirectURL();

export const isLoggedIn = computed(() => !!accessToken.value);

let refreshPromise: Promise<void> | null = null;

export async function refreshAccessToken(): Promise<void> {
  if (refreshPromise) {
    return refreshPromise;
  }

  const currentRefreshToken = refreshToken.value;
  if (!currentRefreshToken) {
    throw new Error("No refresh token available");
  }

  const revision = tokenStorageRevision;
  refreshPromise = (async () => {
    try {
      await waitForSettings();
      const response = await browser.runtime.sendMessage({
        type: "REFRESH_TOKEN",
        payload: {
          endpoint: endpoint.value,
          clientId: clientId.value,
          refreshToken: currentRefreshToken,
        },
      });

      if (!response.success) {
        throw new Error(response.error || "Failed to refresh token");
      }

      // Background persisted the pair before replying. A newer storage event
      // (including login/logout) must win over a delayed message reply.
      if (revision === tokenStorageRevision) {
        accessToken.value = response.data.access_token;
        refreshToken.value = response.data.refresh_token;
      }
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function startOAuthFlow(): Promise<void> {
  // Includes hydration and any pending popup edits, before OAuth uses them.
  await waitForSettings();
  const revision = tokenStorageRevision;
  return new Promise((resolve, reject) => {
    browser.runtime.sendMessage(
      {
        type: "START_OAUTH_FLOW",
        payload: {
          endpoint: endpoint.value,
          clientId: clientId.value,
        },
      },
      (response) => {
        if (browser.runtime.lastError) {
          reject(new Error(browser.runtime.lastError.message));
          return;
        }

        if (!response.success) {
          reject(new Error(response.error || "OAuth failed"));
          return;
        }

        if (revision === tokenStorageRevision) {
          accessToken.value = response.data.access_token;
          refreshToken.value = response.data.refresh_token;
        }
        resolve();
      },
    );
  });
}

export async function logout() {
  const revision = tokenStorageRevision;
  const response = await browser.runtime.sendMessage({ type: "LOGOUT" });
  if (!response.success) throw new Error(response.error || "Logout failed");
  if (revision === tokenStorageRevision) {
    accessToken.value = "";
    refreshToken.value = "";
  }
}
