import { type ClassValue, clsx } from "clsx";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/it";
import "dayjs/locale/zh-cn";
import { twMerge } from "tailwind-merge";
import { isUrl } from "./url";
import { DownloadType, inferDownloadType } from "@mediago/common";

export { isWeb } from "../environment";

dayjs.extend(relativeTime);

export { http, setupHttp } from "./http";
export { tdApp } from "./tdapp";

export const generateUrl = (url: string) => {
  let result = url;
  if (!/^https?:\/\//.test(url)) {
    result = `https://${url}`;
  }
  if (!isUrl(result)) {
    result = `https://www.baidu.com/s?word=${url}`;
  }
  return result;
};

export function moment() {
  return dayjs().format("YYYY-MM-DDTHH:mm:ssZ");
}

export function fromatDateTime(
  d: string | number | Date | undefined,
  tmpStr: string = "YYYY/MM/DD HH:mm:ss",
) {
  if (!d) return "";

  return dayjs(d).format(tmpStr);
}

export function formatRelativeTime(
  d: string | number | Date | undefined,
  language: string,
) {
  if (!d) return "";

  const value = dayjs(d);
  if (!value.isValid()) return "";

  const locale = language.startsWith("zh")
    ? "zh-cn"
    : language.startsWith("it")
      ? "it"
      : "en";
  return value.locale(locale).fromNow();
}

export function getFileName(url: string) {
  const urlObject = new URL(url);
  const name = urlObject.pathname.split("/").pop() || "";
  return decodeURIComponent(name);
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isDownloadType(value: string | null): value is DownloadType {
  if (!value) return false;

  return Object.values(DownloadType).includes(value as DownloadType);
}

export const urlDownloadType = (url: string): DownloadType => {
  return inferDownloadType(url);
};

export const convertPlainObject = (obj: unknown) => {
  return JSON.parse(JSON.stringify(obj));
};
