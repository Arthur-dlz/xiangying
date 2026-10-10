import i18n from "@/i18n";
import { useAppStore } from "@/store/app";
import axios, { type InternalAxiosRequestConfig } from "axios";

// Go Core axios instance
const http = axios.create({});

function shouldSkipAuthRedirect(config?: InternalAxiosRequestConfig) {
  return config?.suppressAuthRedirect === true;
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
        window.location.pathname = "/signin";
      }
      return Promise.reject(new Error(res.message || i18n.t("unknownError")));
    }
    // Non-standard response (e.g. raw data), return as-is
    return res;
  },
  (error) => {
    const resp = error.response;
    if (
      resp &&
      resp.status === 401 &&
      !shouldSkipAuthRedirect(error.config) &&
      !window.location.pathname.startsWith("/signin")
    ) {
      useAppStore.getState().setAppStore({ apiKey: "" });
      window.location.pathname = "/signin";
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
    if (!config.data) {
      config.data = {};
    }
    if (!config.data.auth) {
      const appStore = useAppStore.getState();
      config.data.auth = appStore.apiKey;
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
