import type {
  Conversion,
  ConversionPagination,
  ConversionResponse,
} from "@mediago/common";

const MAX_CONVERSION_PAGES = 10_000;

export type ConversionBulkAction = "start" | "stop" | "clearCompleted";

export async function getAllConversionSnapshot(
  getPage: (pagination: ConversionPagination) => Promise<ConversionResponse>,
  pageSize: number,
): Promise<Conversion[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error("Invalid conversion page size");
  }

  const firstPage = await getPage({ current: 1, pageSize });
  const total = firstPage.total;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Invalid conversion total");
  }

  const pageCount = Math.ceil(total / pageSize);
  if (pageCount > MAX_CONVERSION_PAGES) {
    throw new Error("Conversion queue exceeds the safe pagination limit");
  }
  const snapshot: Conversion[] = [];
  const seenIds = new Set<number>();
  const appendPage = (page: ConversionResponse, index: number) => {
    if (page.total !== total) {
      throw new Error("Conversion queue changed during pagination");
    }
    const expectedLength = Math.min(pageSize, total - index * pageSize);
    if (page.list.length !== expectedLength) {
      throw new Error("Conversion queue page was incomplete");
    }
    for (const item of page.list) {
      if (!Number.isSafeInteger(item.id) || seenIds.has(item.id)) {
        throw new Error(
          "Conversion queue contained an invalid or duplicate ID",
        );
      }
      seenIds.add(item.id);
      snapshot.push(item);
    }
  };

  appendPage(firstPage, 0);
  for (let current = 2; current <= pageCount; current += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Keep paginated reads bounded.
    const page = await getPage({ current, pageSize });
    appendPage(page, current - 1);
  }

  return snapshot;
}

export function getConversionActionItems(
  snapshot: Conversion[],
  action: ConversionBulkAction,
): Conversion[] {
  switch (action) {
    case "start":
      return snapshot.filter(
        (item) => item.status === "pending" || item.status === "failed",
      );
    case "stop":
      return snapshot.filter((item) => item.status === "converting");
    case "clearCompleted":
      return snapshot.filter((item) => item.status === "done");
  }
}

export async function runConversionBulkAction(
  getPage: (pagination: ConversionPagination) => Promise<ConversionResponse>,
  pageSize: number,
  bulkAction: ConversionBulkAction,
  action: (id: number) => Promise<void>,
  onStart?: () => void,
): Promise<number> {
  const snapshot = await getAllConversionSnapshot(getPage, pageSize);
  const tasks = getConversionActionItems(snapshot, bulkAction);
  if (tasks.length === 0) return 0;

  onStart?.();
  const results = await Promise.allSettled(
    tasks.map((item) => action(item.id)),
  );
  return results.filter((result) => result.status === "rejected").length;
}
