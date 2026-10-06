import { oauthRefreshErrorCode, refreshTokenFailureMessage } from "./oauthRefreshError";

type TokenPair = { access_token: string; refresh_token: string };
type RefreshRequest = { endpoint: string; clientId: string; refreshToken: string };
type TokenStorage = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
};
type RefreshResponse = { response: Response; body?: string; tokens?: TokenPair };

const marker = "oauth_refresh_in_progress";
const keys = ["access_token", "refresh_token", marker];

class SafeAuthError extends Error {}

function tokenPair(data: unknown): TokenPair | undefined {
  if (data === null || typeof data !== "object") return;
  const tokens = data as Record<string, unknown>;
  if (
    typeof tokens.access_token === "string" && tokens.access_token.length > 0 &&
    typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0
  ) {
    return { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
  }
}

/** One background instance owns all credential mutations. Never log inputs/errors. */
export function createRefreshTokenCoordinator(
  storage: TokenStorage,
  fetchToken: typeof fetch,
  timeoutMs = 15_000,
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Invalid token refresh timeout");
  }
  let tail: Promise<unknown> = Promise.resolve();
  const inFlight = new Map<string, Promise<TokenPair>>();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    // Queue login/logout as well: a late refresh cannot resurrect logged-out
    // credentials or overwrite a fresh authorization-code pair.
    const result = tail.then(operation).catch((error: unknown) => {
      if (error instanceof SafeAuthError) throw error;
      throw new SafeAuthError("Token storage operation failed");
    });
    tail = result.catch(() => {});
    return result;
  }

  async function requestTokens(request: RefreshRequest, refreshToken: string): Promise<RefreshResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new SafeAuthError("Token refresh request timed out"));
        controller.abort();
      }, timeoutMs);
    });

    try {
      // Race only fetching/body consumption, never credential mutations. Even
      // if a transport ignores abort, its late result cannot change storage.
      return await Promise.race([
        (async () => {
          const response = await fetchToken(request.endpoint + "/oauth/token", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: request.clientId,
              refresh_token: refreshToken,
            }),
          }).catch(() => {
            throw new SafeAuthError("Token refresh request failed");
          });
          if (!response.ok) {
            return { response, body: await response.text().catch(() => "") };
          }
          return { response, tokens: tokenPair(await response.json().catch(() => undefined)) };
        })(),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function refresh(request: RefreshRequest): Promise<TokenPair> {
    const pending = inFlight.get(request.refreshToken);
    if (pending) return pending;

    const result = serialize(async () => {
      const current = await storage.get(keys);
      const stored = tokenPair(current);
      if (!stored) throw new SafeAuthError("No refresh token available");
      if (stored.refresh_token !== request.refreshToken) return stored;
      if (current[marker]) {
        // A prior worker may have sent this one-use token but died before
        // persisting its rotated replacement. Never guess that replay is safe.
        throw new SafeAuthError("Token refresh outcome unknown; sign in again");
      }

      await storage.set({ [marker]: true });
      const { response, body = "", tokens } = await requestTokens(request, stored.refresh_token);
      if (!response.ok) {
        if (
          (response.status === 400 || response.status === 401) &&
          oauthRefreshErrorCode(body) === "invalid_grant"
        ) {
          const latest = await storage.get(keys);
          if (latest.refresh_token === stored.refresh_token) {
            await storage.set({ access_token: "", refresh_token: "", [marker]: false });
          } else {
            const newer = tokenPair(latest);
            if (newer) return newer;
          }
        }
        throw new SafeAuthError(refreshTokenFailureMessage(response.status, body));
      }
      if (!tokens) throw new SafeAuthError("Invalid token refresh response");
      // One storage mutation publishes both tokens and clears the marker.
      await storage.set({ ...tokens, [marker]: false });
      return tokens;
    }).finally(() => {
      inFlight.delete(request.refreshToken);
    });
    inFlight.set(request.refreshToken, result);
    return result;
  }

  function login(data: unknown): Promise<TokenPair> {
    return serialize(async () => {
      const tokens = tokenPair(data);
      if (!tokens) throw new SafeAuthError("Invalid OAuth token response");
      await storage.set({ ...tokens, [marker]: false });
      return tokens;
    });
  }

  function logout(): Promise<void> {
    return serialize(() => storage.set({ access_token: "", refresh_token: "", [marker]: false }));
  }

  return { refresh, login, logout };
}
