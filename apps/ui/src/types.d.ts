declare interface Favorite {
  id: number;
  title: string;
  url: string;
  icon?: string | null;
  iconStatus: "unresolved" | "ready" | "missing" | "retryable";
}

declare interface UrlDetail {
  url: string;
  title: string;
}

interface ObjectConstructor {
  keys<T>(o: T): (keyof T)[];
}
