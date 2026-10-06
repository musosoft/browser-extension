/** Never expose server descriptions or raw bodies in refresh diagnostics. */
export function oauthRefreshErrorCode(body: string): string {
  let code = "server_rejected";

  try {
    const data: unknown = JSON.parse(body);
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      const error = (data as Record<string, unknown>).error;
      if (
        typeof error === "string" &&
        error.length > 0 &&
        error.length <= 64 &&
        !/[^A-Za-z0-9_.-]/.test(error)
      ) {
        code = error;
      }
    }
  } catch {
    // Empty, non-JSON, or malformed responses get the same safe fallback.
  }

  return code;
}

export function refreshTokenFailureMessage(status: number, body: string): string {
  return `Failed to refresh token (HTTP ${status}; OAuth error: ${oauthRefreshErrorCode(body)})`;
}
