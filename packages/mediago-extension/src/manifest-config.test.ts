import { describe, expect, test } from "vitest";

import manifest from "../manifest.config";

const expectedPageMatches = [
  "*://bilibili.com/*",
  "*://www.bilibili.com/*",
  "*://youtube.com/*",
  "*://www.youtube.com/*",
  "*://m.youtube.com/*",
  "*://music.youtube.com/*",
  "*://youtu.be/*",
  "*://x.com/*",
  "*://www.x.com/*",
  "*://twitter.com/*",
  "*://www.twitter.com/*",
  "*://mobile.twitter.com/*",
  "*://tiktok.com/*",
  "*://www.tiktok.com/*",
  "*://m.tiktok.com/*",
  "*://vm.tiktok.com/*",
  "*://vt.tiktok.com/*",
  "*://tiktokv.com/*",
  "*://www.tiktokv.com/*",
  "*://douyin.com/*",
  "*://www.douyin.com/*",
  "*://v.douyin.com/*",
  "*://xiaohongshu.com/*",
  "*://www.xiaohongshu.com/*",
  "*://xhslink.com/*",
  "*://www.xhslink.com/*",
];

const basename = (entry: string | undefined) => entry?.split("/").at(-1);

describe("page quick action manifest wiring", () => {
  test("requires Chrome 127 for programmatic action popup support", () => {
    expect(manifest.minimum_chrome_version).toBe("127");
  });

  test("injects the content entry only into narrow supported-site hosts", () => {
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts?.[0]).toMatchObject({
      js: ["src/content/page-action-entry.ts"],
      run_at: "document_idle",
      all_frames: false,
      matches: expectedPageMatches,
    });
    expect(manifest.content_scripts?.[0]?.matches).not.toContain("<all_urls>");
  });

  test("uses a unique basename for background and content entry modules", () => {
    const workerEntry = manifest.background?.service_worker;
    const contentEntry = manifest.content_scripts?.[0]?.js?.[0];

    expect(workerEntry).toBeTypeOf("string");
    expect(contentEntry).toBeTypeOf("string");
    expect(basename(contentEntry)).not.toBe(basename(workerEntry));
  });

  test("exposes only the button icon to the same narrow hosts", () => {
    expect(manifest.web_accessible_resources).toEqual([
      {
        resources: ["public/icons/mediago-16.png"],
        matches: expectedPageMatches,
      },
    ]);
  });

  test("can forward signed-in Xiaohongshu cookies in HTTP mode", () => {
    expect(manifest.permissions).toContain("cookies");
    expect(manifest.host_permissions).toContain("<all_urls>");
  });
});
