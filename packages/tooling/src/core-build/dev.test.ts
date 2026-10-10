import { describe, expect, test } from "vitest";
import { config } from "./config";
import { createEmbeddedUiBuildPlans } from "./dev";

describe("createEmbeddedUiBuildPlans", () => {
  test("builds the main UI through the workspace dependency graph", () => {
    expect(createEmbeddedUiBuildPlans()).toEqual([
      {
        label: "main Web UI",
        command: ["build:web:raw"],
        commandDirectory: config.WORKSPACE_DIR,
        buildDirectory: config.MAIN_UI_BUILD_DIR,
        targetDirectory: config.MAIN_UI_ASSETS_DIR,
      },
      {
        label: "Player UI",
        command: ["build"],
        commandDirectory: config.PLAYER_UI_DIR,
        buildDirectory: config.PLAYER_UI_BUILD_DIR,
        targetDirectory: config.PLAYER_ASSETS_DIR,
      },
    ]);
  });
});
