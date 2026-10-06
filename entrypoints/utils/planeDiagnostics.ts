import { isAxiosError } from "axios";

/** Temporary status diagnostics: return fixed categories and validated HTTP numbers only. */
export function planeTimerDiagnostic(error: unknown): string {
  if (isAxiosError(error)) {
    const status: unknown = error.response?.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      const category = status === 401 || status === 403 ? "Authentication" :
        status >= 500 ? "Server error" : status >= 400 ? "Client error" : "Request failed";
      return `HTTP ${status} · ${category}`;
    }
  }

  // Match only known local failures, never include their messages in the result.
  const message = error instanceof Error ? error.message : undefined;
  if (message === "Unable to load instance settings" || message === "Unable to load API settings" ||
      message === "Instance settings unavailable; open the extension popup to migrate settings" ||
      message === "Invalid instance endpoint") return "Settings unavailable";
  if (message === "Open the Solidtime extension and sign in first." ||
      message === "No refresh token available" || message === "Failed to refresh token") return "Authentication";
  if (isAxiosError(error) && !error.response &&
      ["ERR_NETWORK", "ECONNABORTED", "ETIMEDOUT"].includes(error.code ?? "")) return "Network/CORS";
  return "Request failed";
}

/** Preserve local action guidance without echoing arbitrary API exception text. */
export function planeTimerActionError(error: unknown): string {
  const guidance = [
    "Open the Solidtime extension and sign in first.",
    "Safe tracking needs Web Locks support in this browser.",
    "Select an organization in the Solidtime extension first.",
    "This issue is no longer being tracked. Refresh and try again.",
    "A timer is already running. Stop it before starting this issue.",
  ];
  return guidance.find((text) => error instanceof Error && error.message === text) ??
    "Solidtime could not update the timer. Check the extension and retry.";
}
