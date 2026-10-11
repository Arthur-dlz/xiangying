import i18n from "@/i18n";
import { useAppStore } from "@/store/app";
import axios, { type InternalAxiosRequestConfig } from "axios";

// Shared sign-in route used by every auth-redirect path below.
const SIGNIN_PATH = "/signin";

// Go Core axios instance
const http = axios.create({});

function shouldSkipAuthRedirect(config?: InternalAxiosRequestConfig) {
  return config?.suppressAuthRedirect === true;
}

// redirectToSignin clears any stale apiKey and navigates to sign-in exactly
// once. Guarding on the current path avoids a redirect loop when the sign-in
// request itself returns 401.
function redirectToSignin() {
  if (window.location.pathname.startsWith(SIGNIN_PATH)) return;
  useAppStore.getState().setAppStore({ apiKey: "" });
  window.location.pathname = SIGNIN_PATH;
}

// isPlainJsonObject reports whether value is a plain JSON object (as opposed to
// FormData/Blob/ArrayBuffer/string bodies), i.e. one that can safely carry an
// injected `auth` field that survives serialization.
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function applyLanguageHeader(config: InternalAxiosRequestConfig) {
  const language = document.documentElement.lang || navigator.language;
  if (language) {
    config.headers.set("Accept-Language", language);
  }
}

/**
 * Initialize http instance with Go Core base URL.
 * Called once from App.tsx after discovering the core URL.
 */
export function setupHttp(baseURL: string) {
  http.defaults.baseURL = baseURL;
}

// Request interceptor: auto-inject apiKey from Zustand store on every request
http.interceptors.request.use((config) => {
  applyLanguageHeader(config);
  const { apiKey } = useAppStore.getState();
  if (apiKey) {
    config.headers.set("X-API-Key", apiKey);
  }
  return config;
});

// Response interceptor: unwrap Go Core { success, code, data, message } format
http.interceptors.response.use(
  (response) => {
    const res = response.data;
    if (res && typeof res === "object" && "success" in res) {
      if (res.success) {
        return res.data;
      }
      if (res.code === 401 && !shouldSkipAuthRedirect(response.config)) {
        redirectToSignin();
      }
      return Promise.reject(new Error(res.message || i18n.t("unknownError")));
    }
    // Non-standard response (e.g. raw data), return as-is
    return res;
  },
  (error) => {
    const resp = error.response;
    if (resp && resp.status === 401 && !shouldSkipAuthRedirect(error.config)) {
      redirectToSignin();
    }
    // Go Core's error responses follow { success: false, message } too;
    // surface the translated server message instead of Axios's default
    // "Request failed with status code XXX".
    const serverMessage = resp?.data?.message;
    if (typeof serverMessage === "string" && serverMessage.length > 0) {
      return Promise.reject(new Error(serverMessage));
    }
    return Promise.reject(error);
  },
);

export { http };

// Docker/Server API axios instance (existing)
const api = axios.create({
  baseURL: import.meta.env.DEV ? "http://localhost:8899/api" : "/api",
});

api.interceptors.request.use(
  (config) => {
    applyLanguageHeader(config);
    let data = config.data;
    if (data === undefined || data === null) {
      data = {};
      config.data = data;
    }
    // Only inject `auth` into plain JSON bodies. For FormData/Blob/ArrayBuffer
    // or string bodies, setting `.auth` would not be serialized (auth silently
    // dropped) or could throw in strict mode.
    if (isPlainJsonObject(data) && !data.auth) {
      data.auth = useAppStore.getState().apiKey;
    }
    return Promise.resolve(config);
  },
  (error) => {
    return Promise.reject(error);
  },
);

api.interceptors.response.use(
  ({ data }) => {
    return Promise.resolve(data);
  },
  (error) => {
    return Promise.reject(error);
  },
);

export { api };
