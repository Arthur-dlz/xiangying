export type PageItem = number | "ellipsis-start" | "ellipsis-end";

export function getPageItems(current: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (current <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis-end", totalPages];
  }

  if (current >= totalPages - 3) {
    return [
      1,
      "ellipsis-start",
      totalPages - 4,
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ];
  }

  return [
    1,
    "ellipsis-start",
    current - 1,
    current,
    current + 1,
    "ellipsis-end",
    totalPages,
  ];
}

export function getPaginationState(
  page: number,
  pageSize: number,
  total: number,
) {
  const hasItems = total > 0;
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const safeCurrent = Math.min(Math.max(page, 1), totalPages);

  return { hasItems, safePageSize, totalPages, safeCurrent };
}

export function shouldCorrectPage(
  page: number,
  safeCurrent: number,
  isLoading: boolean,
) {
  return !isLoading && page !== safeCurrent;
}
