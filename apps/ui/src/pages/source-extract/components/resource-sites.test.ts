import { describe, expect, it } from "vitest";
import { RESOURCE_SITES, filterResourceSites } from "./resource-sites";

describe("curated resource sites", () => {
  it("provides the ten requested sites without relying on remote icons", () => {
    expect(RESOURCE_SITES).toHaveLength(10);
    expect(RESOURCE_SITES.map(({ name }) => name)).toEqual([
      "1905电影网",
      "爱奇艺",
      "腾讯视频",
      "优酷",
      "芒果TV",
      "哔哩哔哩",
      "央视节目",
      "央视纪录",
      "央视少儿",
      "新片场",
    ]);
    expect(RESOURCE_SITES.every(({ mark }) => mark.length > 0)).toBe(true);
  });

  it("filters sites by category, including multi-category sites", () => {
    expect(filterResourceSites("全部")).toHaveLength(10);
    expect(filterResourceSites("纪录片").map(({ name }) => name)).toEqual([
      "哔哩哔哩",
      "央视纪录",
    ]);
    expect(filterResourceSites("少儿与动画").map(({ name }) => name)).toContain(
      "央视少儿",
    );
  });
});
