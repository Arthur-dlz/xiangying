import { expect, test, vi } from "vitest";
import type { Conversion } from "@mediago/common";
import {
  getAllConversionSnapshot,
  getConversionActionItems,
  runConversionBulkAction,
} from "./conversion-queue-actions";

const makeConversion = (id: number, status: string): Conversion => ({
  id,
  name: `task-${id}`,
  path: `C:/media/${id}.mp4`,
  status,
  outputPath: "",
  outputFormat: "mp4",
  quality: "medium",
  progress: 0,
});

test("collects a fixed two-page queue snapshot with unique IDs", async () => {
  const items = [
    makeConversion(1, "pending"),
    makeConversion(2, "failed"),
    makeConversion(3, "converting"),
    makeConversion(4, "done"),
    ...Array.from({ length: 10 }, (_, index) =>
      makeConversion(index + 5, "pending"),
    ),
  ];
  const getPage = vi.fn(
    async ({ current, pageSize }: { current: number; pageSize: number }) => ({
      total: 14,
      list: items.slice((current - 1) * pageSize, current * pageSize),
    }),
  );

  const snapshot = await getAllConversionSnapshot(getPage, 10);

  expect(getPage.mock.calls.map(([pagination]) => pagination.current)).toEqual([
    1, 2,
  ]);
  expect(snapshot.map(({ id }) => id)).toEqual(
    Array.from({ length: 14 }, (_, index) => index + 1),
  );
  expect(
    getConversionActionItems(snapshot, "start").map(({ id }) => id),
  ).toEqual([1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  expect(
    getConversionActionItems(snapshot, "stop").map(({ id }) => id),
  ).toEqual([3]);
  expect(
    getConversionActionItems(snapshot, "clearCompleted").map(({ id }) => id),
  ).toEqual([4]);
});

test("does not run any action when a later page fetch fails", async () => {
  const getPage = vi.fn(async ({ current }: { current: number }) => {
    if (current === 2) throw new Error("page unavailable");
    return {
      total: 14,
      list: Array.from({ length: 10 }, (_, index) =>
        makeConversion(index + 1, "pending"),
      ),
    };
  });
  const action = vi.fn(async () => {});

  await expect(
    runConversionBulkAction(getPage, 10, "start", action),
  ).rejects.toThrow("page unavailable");
  expect(getPage.mock.calls.map(([pagination]) => pagination.current)).toEqual([
    1, 2,
  ]);
  expect(action).not.toHaveBeenCalled();
});

test("does not run an action for an empty queue", async () => {
  const getPage = vi.fn(async () => ({ total: 0, list: [] }));
  const action = vi.fn(async () => {});

  await expect(
    runConversionBulkAction(getPage, 10, "start", action),
  ).resolves.toBe(0);
  expect(getPage).toHaveBeenCalledTimes(1);
  expect(action).not.toHaveBeenCalled();
});

test("rejects inconsistent pagination instead of returning a partial or looping snapshot", async () => {
  const getPage = vi.fn(async ({ current }: { current: number }) => ({
    total: 14,
    list:
      current === 1
        ? Array.from({ length: 10 }, (_, index) =>
            makeConversion(index + 1, "pending"),
          )
        : Array.from({ length: 4 }, (_, index) =>
            makeConversion(index + 1, "pending"),
          ),
  }));

  await expect(getAllConversionSnapshot(getPage, 10)).rejects.toThrow(
    /duplicate/i,
  );
  expect(getPage).toHaveBeenCalledTimes(2);
});
