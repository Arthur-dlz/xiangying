export type LibraryCategory = "movie" | "documentary" | "children" | "other";
export type LibrarySafetyStatus =
  | "unscanned"
  | "clean"
  | "blocked"
  | "unavailable";
export interface LibrarySafety {
  status: LibrarySafetyStatus;
  checkedAt?: string;
  message?: string;
  fingerprint?: string;
}
export interface LibraryItem {
  id: string;
  title: string;
  path: string;
  bytes: number;
  category: LibraryCategory;
  tags: string[];
  screened: boolean;
  source: "import" | "download";
  addedAt: string;
  updatedAt: string;
  safety: LibrarySafety;
  missing: boolean;
}
export interface LibrarySnapshot {
  items: LibraryItem[];
  totalBytes: number;
}
export interface LibraryImportResult {
  added: number;
  skipped: number;
  rejected: { path: string; reason: string }[];
  items: LibraryItem[];
}
export type LibraryItemPatch = Partial<
  Pick<LibraryItem, "title" | "category" | "tags" | "screened">
>;
export interface LibraryExportResult {
  cancelled: boolean;
  destination?: string;
  results: { id: string; copied: boolean; path?: string; error?: string }[];
}
export interface LibraryApi {
  list(): Promise<LibrarySnapshot>;
  importFiles(
    paths: string[],
    source?: "import" | "download",
  ): Promise<LibraryImportResult>;
  update(id: string, patch: LibraryItemPatch): Promise<LibraryItem>;
  remove(id: string): Promise<void>;
  scan(id: string): Promise<LibraryItem>;
  play(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  exportFiles(ids: string[]): Promise<LibraryExportResult>;
}
