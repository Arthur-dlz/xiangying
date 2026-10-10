import path from "node:path";
import { expect, test, vi } from "vitest";

vi.mock("../../assets/icon.ico", () => ({ default: "assets/icon.ico" }));
vi.mock("../../assets/icons/linux/512x512.png", () => ({
  default: "assets/icons/linux/512x512.png",
}));

const { resolveWindowIcon } = await import("./desktop-icons");

test("uses the packaged Windows icon for desktop windows", () => {
  expect(resolveWindowIcon("/app/build", "win32")).toBe(
    path.resolve("/app/build", "assets/icon.ico"),
  );
});

test("uses the transparent Linux icon for desktop windows", () => {
  expect(resolveWindowIcon("/app/build", "linux")).toBe(
    path.resolve("/app/build", "assets/icons/linux/512x512.png"),
  );
});

test("lets macOS use the application bundle icon", () => {
  expect(resolveWindowIcon("/app/build", "darwin")).toBeUndefined();
});
