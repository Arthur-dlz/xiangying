import { expect, test } from "vitest";
import {
  formatDownloadSpeed,
  formatRecordingDuration,
  formatRecordingStartTime,
  normalizeDownloadPercent,
} from "./download-progress";

test("keeps Go Core's 0-100 percent scale", () => {
  expect(normalizeDownloadPercent("0.5")).toBe(0.5);
  expect(normalizeDownloadPercent("1")).toBe(1);
  expect(normalizeDownloadPercent(99.5)).toBe(99.5);
});

test("clamps and rejects invalid percent values", () => {
  expect(normalizeDownloadPercent(150)).toBe(100);
  expect(normalizeDownloadPercent(-1)).toBe(null);
  expect(normalizeDownloadPercent(undefined)).toBe(null);
});

test.each([
  ["1.55MBps", "1.55 MB/s"],
  ["1.5 MB/s", "1.50 MB/s"],
  ["2.50MiB/s", "2.62 MB/s"],
  ["512KiB", "524.29 KB/s"],
  ["850 B/s", "850 B/s"],
  ["0 B/s", "0 B/s"],
  ["", "0 B/s"],
  [undefined, "0 B/s"],
])("formats download speed %j as %s", (input, expected) => {
  expect(formatDownloadSpeed(input)).toBe(expected);
});

test("formats recording duration without wrapping after 24 hours", () => {
  expect(
    formatRecordingDuration(
      "2026-08-26T00:00:00.000Z",
      new Date("2026-08-27T01:02:03.000Z").getTime(),
    ),
  ).toBe("25:02:03");
  expect(formatRecordingDuration(undefined)).toBe("");
  expect(formatRecordingDuration("invalid")).toBe("");
});

test("formats the recording start time in the requested time zone", () => {
  expect(
    formatRecordingStartTime("2026-08-27T07:20:08.000Z", "zh-CN", "UTC"),
  ).toBe("07:20:08");
});
