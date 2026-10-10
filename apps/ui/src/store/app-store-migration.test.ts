import { describe, expect, it } from "vitest";
import { migrateAppStore } from "./app-store-migration";

describe("migrateAppStore", () => {
  it("removes the legacy MCP port without mutating the stored state", () => {
    const stored = {
      enableMcp: true,
      mcpPort: 39720,
      mcpToken: "secret",
    };

    expect(migrateAppStore(stored)).toStrictEqual({
      enableMcp: true,
      mcpToken: "secret",
    });
    expect(stored).toHaveProperty("mcpPort", 39720);
  });

  it.each([null, "stored", 1, ["state"]])(
    "leaves unsupported persisted state unchanged: %j",
    (stored) => {
      expect(migrateAppStore(stored)).toBe(stored);
    },
  );
});
