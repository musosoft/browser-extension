import axios, { AxiosError, AxiosHeaders, type AxiosAdapter } from "axios";

export const API_REQUEST = "SOLIDTIME_API_REQUEST";
type Request = { path: string; method: string; data?: string; headers: Record<string, string>; timeout: number };
type Reply = { success: true; response: { status: number; statusText: string; data: string; headers: Record<string, string> } }
  | { success: false; error: { message: string; code?: string } };
type Storage = { get(keys: string[]): Promise<Record<string, unknown>> };
type Refresh = (request: { endpoint: string; clientId: string; refreshToken: string }) => Promise<{ access_token: string; refresh_token: string }>;

export function isExtensionApiContext(): boolean {
  if (typeof location === "undefined") return true; // Background worker.
  const extension = new URL(browser.runtime.getURL("/"));
  const page = new URL(location.href || location.origin);
  return extension.protocol === page.protocol && extension.host === page.host;
}

/** Axios transforms bodies before the adapter and responses afterwards. Only
 * JSON-compatible wire values cross runtime messaging (Chrome uses JSON).
 * Never pass a caller-selected host or bearer token to the background. */
export const backgroundApiAdapter: AxiosAdapter = async (config) => {
  const headers: Record<string, string> = {};
  for (const name of ["Accept", "Content-Type"]) {
    const value = config.headers.get(name);
    if (typeof value === "string") headers[name] = value;
  }
  if (config.data !== undefined && config.data !== null && typeof config.data !== "string") {
    throw new AxiosError("Unsupported background API body", "ERR_BAD_REQUEST", config);
  }
  const reply: Reply = await browser.runtime.sendMessage({
    type: API_REQUEST,
    payload: {
      path: axios.getUri({ ...config, baseURL: "" }),
      method: config.method || "get", data: config.data ?? undefined, headers,
      timeout: config.timeout || 30_000,
    } satisfies Request,
  });
  if (!reply || !reply.success) {
    throw new AxiosError(reply?.error.message || "Background API request failed", reply?.error.code || "ERR_NETWORK", config);
  }
  const response = { ...reply.response, config, headers: AxiosHeaders.from(reply.response.headers) };
  if (config.validateStatus && !config.validateStatus(response.status)) {
    throw new AxiosError(`Request failed with status code ${response.status}`,
      response.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST", config, undefined, response);
  }
  return response;
};

/** Owns dispatch and 401 recovery in the extension, not the website. Auth and
 * host are read together from shared storage; callers cannot turn this into an
 * arbitrary credential-bearing fetch proxy. */
export function createBackgroundApiTransport(storage: Storage, refresh: Refresh, sessionRevision = () => 0) {
  const keys = ["instance_endpoint", "instance_client_id", "access_token", "refresh_token"];
  const readSettings = () => storage.get(keys).catch(() => { throw new Error("Unable to load API settings"); });
  return async (input: unknown): Promise<Reply> => {
    const revision = sessionRevision();
    try {
      const request = input as Request;
      if (!request || typeof request.path !== "string" || !request.path.startsWith("/") ||
        request.path.startsWith("//") || !["get", "post", "put", "patch", "delete", "head", "options"].includes(request.method) ||
        (request.data !== undefined && typeof request.data !== "string") ||
        !Number.isFinite(request.timeout) || request.timeout < 0 || request.timeout > 120_000) {
        throw new Error("Invalid background API request");
      }
      const settings = await readSettings();
      if (typeof settings.instance_endpoint !== "string" || typeof settings.instance_client_id !== "string") {
        throw new Error("Instance settings unavailable; open the extension popup to migrate settings");
      }
      const endpoint = settings.instance_endpoint.replace(/\/+$/, "");
      const base = new URL(endpoint + "/api/");
      if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new Error("Invalid instance endpoint");
      }
      const url = new URL(endpoint + "/api" + request.path);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("Invalid API path");
      const headers: Record<string, string> = {};
      for (const name of ["Accept", "Content-Type"]) {
        if (typeof request.headers?.[name] === "string") headers[name] = request.headers[name];
      }
      const dispatch = (token: unknown) => axios.request<string>({
        url: url.href, method: request.method, data: request.data,
        headers: { ...headers, Authorization: `Bearer ${typeof token === "string" ? token : ""}` },
        adapter: "fetch", timeout: request.timeout || 30_000,
        responseType: "text", transformResponse: [(data) => data], validateStatus: () => true,
        // No implicit cookies from the website or extension context.
        withCredentials: false,
      });
      let response = await dispatch(settings.access_token);
      if (response.status === 401 && typeof settings.refresh_token === "string" && settings.refresh_token) {
        // Only an explicit authentication rejection is replayable. Never retry
        // timeouts, network failures, or other statuses (writes may have landed).
        const latest = await readSettings();
        if (revision === sessionRevision() && latest.instance_endpoint === settings.instance_endpoint &&
          latest.instance_client_id === settings.instance_client_id &&
          typeof latest.access_token === "string" && latest.access_token &&
          typeof latest.refresh_token === "string" && latest.refresh_token) {
          // A delayed 401 may arrive after another caller rotated the pair.
          // Reuse that pair; never refresh its replacement unnecessarily.
          const pair = keys.every((key) => latest[key] === settings[key])
            ? await refresh({ endpoint, clientId: settings.instance_client_id, refreshToken: settings.refresh_token })
            : { access_token: latest.access_token, refresh_token: latest.refresh_token };
          const current = await readSettings();
          if (revision === sessionRevision() && current.instance_endpoint === settings.instance_endpoint && current.instance_client_id === settings.instance_client_id &&
            current.access_token === pair.access_token && current.refresh_token === pair.refresh_token) {
            response = await dispatch(pair.access_token);
          }
        }
      }
      return { success: true, response: { status: response.status, statusText: response.statusText,
        data: response.data, headers: AxiosHeaders.from(response.headers as AxiosHeaders).toJSON(true) as Record<string, string> } };
    } catch (error) {
      // Axios/fetch errors can contain credentials/config. Never serialize them.
      return { success: false, error: { message: axios.isAxiosError(error) ? "Background API request failed" :
        error instanceof Error ? error.message : "Background API request failed",
        code: axios.isAxiosError(error) ? error.code : undefined } };
    }
  };
}
