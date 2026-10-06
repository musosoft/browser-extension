import { createApiClient } from "@solidtime/api";
import { accessToken, endpoint, refreshAccessToken, waitForSettings } from "./oauth";
import { backgroundApiAdapter, isExtensionApiContext } from "./apiTransport";

export const apiClient = () => {
  // Zodios requires a nonempty constructor base; no host is selected here.
  const client = createApiClient("/api", {
    validate: "none",
  });
  const backgroundTransport = !isExtensionApiContext();
  if (backgroundTransport) client.axios.defaults.adapter = backgroundApiAdapter;

  // Content scripts may create clients before shared settings have hydrated.
  // Resolve both host and auth header at dispatch, including retried requests.
  client.axios.interceptors.request.use(async (config) => {
    await waitForSettings();
    config.baseURL = endpoint.value.replace(/\/+$/, "") + "/api";
    config.headers.Authorization = `Bearer ${accessToken.value}`;
    return config;
  });

  // Add response interceptor to handle 401 errors and refresh token
  client.axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;

      // If 401 and we haven't already tried to refresh
      if (!backgroundTransport && originalRequest && error.response?.status === 401 && !originalRequest._retry) {
        originalRequest._retry = true;

        try {
          await refreshAccessToken();

          // Retry the original request with new token
          originalRequest.headers.Authorization = `Bearer ${accessToken.value}`;
          return client.axios(originalRequest);
        } catch (refreshError) {
          // Refresh failed, user needs to log in again
          return Promise.reject(refreshError);
        }
      }

      return Promise.reject(error);
    },
  );

  return client;
};
