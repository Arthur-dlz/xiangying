export interface ResourceProvider {
  id: string;
  name: string;
  apiUrl: string;
  enabled: boolean;
}
export interface ResourceEpisode {
  name: string;
  url: string;
  kind: "direct" | "m3u8" | "page";
}
export interface ResourceSearchItem {
  id: string;
  providerId: string;
  providerName: string;
  title: string;
  year?: string;
  language?: string;
  quality?: string;
  typeName?: string;
  episodes: ResourceEpisode[];
}
export interface ResourceSearchResult {
  keyword: string;
  page: number;
  items: ResourceSearchItem[];
  errors: { providerId: string; providerName: string; message: string }[];
  hasMore: boolean;
}
export interface ResourceSearchApi {
  listProviders(): Promise<ResourceProvider[]>;
  saveProviders(providers: ResourceProvider[]): Promise<ResourceProvider[]>;
  search(keyword: string, page?: number): Promise<ResourceSearchResult>;
  cancel(): Promise<void>;
}
