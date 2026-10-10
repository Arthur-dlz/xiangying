import "axios";

declare module "axios" {
  interface AxiosRequestConfig {
    suppressAuthRedirect?: boolean;
  }

  interface InternalAxiosRequestConfig {
    suppressAuthRedirect?: boolean;
  }
}
