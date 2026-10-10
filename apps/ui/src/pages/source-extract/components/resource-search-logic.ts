import type { ResourceSearchItem } from "@mediago/common";

export function appendUniqueSearchItems(
  current: ResourceSearchItem[],
  incoming: ResourceSearchItem[],
): ResourceSearchItem[] {
  const seen = new Set(current.map((item) => `${item.providerId}:${item.id}`));
  return [
    ...current,
    ...incoming.filter((item) => {
      const key = `${item.providerId}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

export function createRequestSequence() {
  let sequence = 0;
  return {
    next: () => ++sequence,
    isCurrent: (candidate: number) => candidate === sequence,
  };
}

export function displayResourceValue(value?: string | null): string {
  return value?.trim() || "未知";
}
