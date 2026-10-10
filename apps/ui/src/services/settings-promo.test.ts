import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  isSettingsPromoEligible,
  loadSettingsPromoManifest,
  parseSettingsPromoManifest,
  selectSettingsPromoContent,
} from "./settings-promo";

const sourceUrl =
  "https://raw.githubusercontent.com/mediago-dev/mediago/master/remote-config/settings-promo.json";
const validManifest = {
  schemaVersion: 5,
  enabled: true,
  campaignId: "extension-promo",
  cacheSeconds: 900,
  actionUrl: "https://downloader.caorushizi.cn/extension.html",
  platforms: ["electron", "web"],
  content: {
    en: {
      imageUrl:
        "https://raw.githubusercontent.com/mediago-dev/mediago/master/images/browser_en.png",
      sidebarImageUrl:
        "https://raw.githubusercontent.com/mediago-dev/mediago/master/images/browser_sidebar_en.png",
      title: "Send browser media to MediaGo in one click",
      buttonText: "Try it now",
    },
    zh: {
      imageUrl:
        "https://raw.githubusercontent.com/mediago-dev/mediago/master/images/browser.png",
      sidebarImageUrl:
        "https://raw.githubusercontent.com/mediago-dev/mediago/master/images/browser_sidebar.png",
      title: "一键将浏览器资源发送到 MediaGo",
      buttonText: "立即体验",
    },
  },
} as const;

describe("settings promotion manifest", () => {
  test("accepts the checked-in remote configuration", () => {
    const checkedInManifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../../remote-config/settings-promo.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;

    expect(
      parseSettingsPromoManifest(checkedInManifest, sourceUrl),
    ).not.toBeNull();
  });

  test("accepts localized HTTPS images and normalizes defaults", () => {
    const manifest = parseSettingsPromoManifest(validManifest, sourceUrl);

    expect(manifest).not.toBeNull();
    expect(manifest?.campaignId).toBe("extension-promo");
    expect(manifest?.content.zh?.title).toBe("一键将浏览器资源发送到 MediaGo");
    expect(manifest?.content.zh?.sidebarImageUrl).toContain(
      "browser_sidebar.png",
    );
  });

  test("falls back to the wide image for legacy configurations", () => {
    const manifest = parseSettingsPromoManifest(
      {
        ...validManifest,
        content: {
          en: {
            imageUrl: validManifest.content.en.imageUrl,
            title: validManifest.content.en.title,
            buttonText: validManifest.content.en.buttonText,
          },
        },
      },
      sourceUrl,
    );

    expect(manifest?.content.en?.sidebarImageUrl).toBe(
      manifest?.content.en?.imageUrl,
    );
  });

  test("rejects insecure actions and cross-origin tracking images", () => {
    expect(
      parseSettingsPromoManifest(
        { ...validManifest, actionUrl: "http://example.com" },
        sourceUrl,
      ),
    ).toBeNull();
    expect(
      parseSettingsPromoManifest(
        {
          ...validManifest,
          content: {
            ...validManifest.content,
            en: {
              ...validManifest.content.en,
              sidebarImageUrl: "https://tracker.example/sidebar.png",
            },
          },
        },
        sourceUrl,
      ),
    ).toBeNull();
    expect(
      parseSettingsPromoManifest(
        {
          ...validManifest,
          content: {
            ...validManifest.content,
            en: {
              imageUrl: "https://tracker.example/pixel.gif",
              title: "Tracked promotion",
              buttonText: "Open",
            },
          },
        },
        sourceUrl,
      ),
    ).toBeNull();
  });

  test("filters by enabled state, schedule, version and platform", () => {
    const manifest = parseSettingsPromoManifest(
      {
        ...validManifest,
        minVersion: "1.2.0",
        maxVersion: "2.0.0",
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: "2027-01-01T00:00:00Z",
        platforms: ["electron"],
      },
      sourceUrl,
    );
    if (!manifest) throw new Error("Expected a valid fixture");

    expect(
      isSettingsPromoEligible(manifest, {
        appVersion: "1.5.0",
        now: Date.parse("2026-08-26T00:00:00Z"),
        platform: "electron",
      }),
    ).toBe(true);
    expect(
      isSettingsPromoEligible(manifest, {
        appVersion: "1.1.9",
        now: Date.parse("2026-08-26T00:00:00Z"),
        platform: "electron",
      }),
    ).toBe(false);
    expect(
      isSettingsPromoEligible(manifest, {
        appVersion: "1.5.0",
        now: Date.parse("2026-08-26T00:00:00Z"),
        platform: "web",
      }),
    ).toBe(false);
  });

  test("selects the current language and falls back to English", () => {
    const manifest = parseSettingsPromoManifest(validManifest, sourceUrl);
    if (!manifest) throw new Error("Expected a valid fixture");

    expect(selectSettingsPromoContent(manifest, "zh-CN")?.title).toBe(
      "一键将浏览器资源发送到 MediaGo",
    );
    expect(selectSettingsPromoContent(manifest, "fr-FR")?.title).toBe(
      "Send browser media to MediaGo in one click",
    );
  });

  test("uses a versioned cache and avoids a duplicate request while fresh", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(validManifest), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const first = await loadSettingsPromoManifest(sourceUrl, {
      fetcher,
      now: () => 1_000,
      storage,
    });
    const second = await loadSettingsPromoManifest(sourceUrl, {
      fetcher,
      now: () => 2_000,
      storage,
    });

    expect(first?.campaignId).toBe("extension-promo");
    expect(second?.campaignId).toBe("extension-promo");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
