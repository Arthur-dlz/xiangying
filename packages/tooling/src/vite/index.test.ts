import { describe, expect, it } from "vitest";
import { createDependencyChunks, mediaGoBuildMetadataPlugin } from "./index.ts";

describe("mediaGoBuildMetadataPlugin", () => {
  it("defines only supplied MediaGo build metadata", () => {
    const plugin = mediaGoBuildMetadataPlugin({
      target: "electron",
      telemetryId: "",
      version: "3.5.0",
    });

    expect(plugin.name).toBe("mediago:build-metadata");
    expect(plugin.config).toBeTypeOf("function");
    if (typeof plugin.config !== "function") return;

    expect(plugin.config.call({} as never, {} as never, {} as never)).toEqual({
      define: {
        "import.meta.env.APP_TARGET": '"electron"',
        "import.meta.env.APP_TD_APPID": '""',
        "import.meta.env.APP_VERSION": '"3.5.0"',
      },
    });
  });

  it("preserves an explicitly supplied undefined define", () => {
    const plugin = mediaGoBuildMetadataPlugin({ target: undefined });
    if (typeof plugin.config !== "function") return;

    expect(plugin.config.call({} as never, {} as never, {} as never)).toEqual({
      define: { "import.meta.env.APP_TARGET": undefined },
    });
  });
});

describe("createDependencyChunks", () => {
  it("returns the first matching named dependency group", () => {
    const manualChunks = createDependencyChunks({
      videojs: ["video.js"],
      vendor: ["react-dom", "react/"],
    });

    expect(manualChunks("/node_modules/video.js/dist/video.js")).toBe(
      "videojs",
    );
    expect(manualChunks("/node_modules/react-dom/index.js")).toBe("vendor");
    expect(manualChunks("/src/main.tsx")).toBeUndefined();
  });
});
