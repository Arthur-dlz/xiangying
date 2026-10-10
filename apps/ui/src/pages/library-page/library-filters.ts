import {
  DownloadStatus,
  type DownloadTaskWithFile,
  type LibraryCategory,
  type LibraryItem,
} from "@mediago/common";

export interface LibraryFilterState {
  query: string;
  category: "all" | LibraryCategory;
  screened: "all" | "true" | "false";
}

export function filterLibraryItems(
  items: LibraryItem[],
  { query, category, screened }: LibraryFilterState,
): LibraryItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    const matchesText =
      !needle ||
      item.title.toLocaleLowerCase().includes(needle) ||
      item.tags.some((tag) => tag.toLocaleLowerCase().includes(needle));
    return (
      matchesText &&
      (category === "all" || item.category === category) &&
      (screened === "all" || String(item.screened) === screened)
    );
  });
}

export function completedLocalTaskPaths(
  tasks: DownloadTaskWithFile[],
): string[] {
  return [
    ...new Set(
      tasks
        .filter(
          (task) =>
            task.status === DownloadStatus.Success && task.exists !== false,
        )
        .map((task) => task.file?.trim())
        .filter((path): path is string => Boolean(path)),
    ),
  ];
}
