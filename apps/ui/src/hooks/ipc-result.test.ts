import { expect, test } from "vitest";
import { unwrapIpcResult } from "./ipc-result";

test("permission and file failures reach the user instead of returning successful null", () => {
  expect(() =>
    unwrapIpcResult({ code: -1, message: "拒绝不可信页面", data: null }),
  ).toThrow("拒绝不可信页面");
  expect(() =>
    unwrapIpcResult({ code: -1, message: "文件已被移动", data: null }),
  ).toThrow("文件已被移动");
});

test("successful and non-IPC results preserve their payloads", () => {
  const result = { items: [], totalBytes: 0 };
  expect(unwrapIpcResult({ code: 0, message: "success", data: result })).toBe(
    result,
  );
  expect(unwrapIpcResult(result)).toBe(result);
  expect(unwrapIpcResult(undefined)).toBeUndefined();
});
