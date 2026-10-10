import { describe, expect, it } from "vitest";
import { getBrowserRefreshShortcut } from "./browser-refresh-shortcut";

const input = (
  values: Partial<Parameters<typeof getBrowserRefreshShortcut>[0]>,
) => ({
  alt: false,
  control: false,
  key: "",
  meta: false,
  shift: false,
  type: "keyDown" as const,
  ...values,
});

describe("getBrowserRefreshShortcut", () => {
  it("maps browser refresh shortcuts across platforms", () => {
    expect(getBrowserRefreshShortcut(input({ key: "r", control: true }))).toBe(
      "reload",
    );
    expect(getBrowserRefreshShortcut(input({ key: "R", meta: true }))).toBe(
      "reload",
    );
    expect(getBrowserRefreshShortcut(input({ key: "F5" }))).toBe("reload");
  });

  it("preserves force reload intent", () => {
    expect(
      getBrowserRefreshShortcut(input({ key: "r", meta: true, shift: true })),
    ).toBe("force-reload");
    expect(getBrowserRefreshShortcut(input({ key: "F5", shift: true }))).toBe(
      "force-reload",
    );
  });

  it("ignores unrelated, modified, and key-up events", () => {
    expect(getBrowserRefreshShortcut(input({ key: "r" }))).toBeNull();
    expect(
      getBrowserRefreshShortcut(input({ key: "r", meta: true, alt: true })),
    ).toBeNull();
    expect(
      getBrowserRefreshShortcut(input({ key: "r", meta: true, type: "keyUp" })),
    ).toBeNull();
  });
});
