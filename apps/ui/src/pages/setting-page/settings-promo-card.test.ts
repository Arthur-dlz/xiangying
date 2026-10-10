/** @vitest-environment happy-dom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  manifest: {
    schemaVersion: 5 as const,
    enabled: true,
    campaignId: "test-campaign",
    cacheSeconds: 900,
    actionUrl: "https://example.com/promotion",
    platforms: ["electron" as const],
    content: {
      en: {
        imageUrl:
          "https://raw.githubusercontent.com/mediago-dev/mediago/master/images/browser_en.png",
        sidebarImageUrl:
          "https://raw.githubusercontent.com/mediago-dev/mediago/master/images/browser_sidebar_en.png",
        title: "<em>Capture media instantly</em>",
        buttonText: "Try it now",
      },
    },
  },
  open: vi.fn(),
}));

const storageValues = new Map<string, string>();
const preloadedImages: MockPreloadImage[] = [];
let sidebarMediaMatches = true;
let reduceMotion = false;
let autoCompletePreloads = true;

class MockPreloadImage extends EventTarget {
  decoding = "auto";
  referrerPolicy = "";
  private imageSource = "";

  decode = vi.fn(() => Promise.resolve());

  get src() {
    return this.imageSource;
  }

  set src(value: string) {
    this.imageSource = value;
    preloadedImages.push(this);
    if (autoCompletePreloads) {
      queueMicrotask(() => this.complete());
    }
  }

  complete() {
    this.dispatchEvent(new Event("load"));
  }

  fail() {
    this.dispatchEvent(new Event("error"));
  }
}

Object.defineProperty(globalThis, "Image", {
  configurable: true,
  value: MockPreloadImage,
});

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => storageValues.set(key, value),
  },
});
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches:
      query === "(prefers-reduced-motion: reduce)"
        ? reduceMotion
        : sidebarMediaMatches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }),
});

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

vi.mock("swr", () => ({
  default: () => ({ data: mocks.manifest }),
}));

vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ shell: { open: mocks.open } }),
}));

const { SettingsPromoCard } = await import("./settings-promo-card");
const { useSettingsPromoPlacementStore } =
  await import("@/store/settings-promo");
const { useShellStore } = await import("@/store/shell");

let root: Root | undefined;
let container: HTMLDivElement;

async function renderCard(placement: "settings" | "sidebar") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SettingsPromoCard, { placement }));
  });
}

beforeEach(() => {
  mocks.manifest.enabled = true;
  mocks.open.mockReset();
  storageValues.clear();
  sidebarMediaMatches = true;
  reduceMotion = false;
  autoCompletePreloads = true;
  preloadedImages.length = 0;
  useShellStore.setState({ sidebarCollapsed: false });
  useSettingsPromoPlacementStore.setState({
    campaignId: "",
    placement: "sidebar",
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (root) {
    act(() => root?.unmount());
    root = undefined;
  }
  container?.remove();
});

test("renders a full-card sidebar image without a conversion button", async () => {
  await renderCard("sidebar");
  const html = container.innerHTML;

  expect(html).toContain("settingsPromotion");
  expect(html).toContain("promo-card-fade-in");
  expect(html).toContain('loading="eager"');
  expect(html).toContain('decoding="async"');
  expect(html).toContain("&lt;em&gt;Capture media instantly&lt;/em&gt;");
  expect(container.querySelector("p")?.textContent).toBe(
    "<em>Capture media instantly</em>",
  );
  expect(container.querySelector("em")).toBeNull();
  expect(html).toContain("<img");
  expect(html).toContain("browser_sidebar_en.png");
  expect(html).toContain("aspect-[4/3]");
  expect(html).toContain("rounded-none");
  expect(html).toContain("border-0");
  expect(html).toContain("top-0");
  expect(html).toContain("min-h-12");
  expect(html).toContain("bg-linear-to-b");
  expect(html).toContain("from-sidebar");
  expect(html).toContain("via-sidebar/60");
  expect(html).toContain("text-muted-foreground");
  expect(html).toContain("dark:text-sidebar-foreground/90");
  expect(html.match(/dark:text-sidebar-foreground\/90/g)).toHaveLength(2);
  expect(html).not.toContain("mix-blend-difference");
  expect(html).not.toContain("dark:from-[");
  expect(html).not.toContain("bg-linear-to-t");
  expect(html).toContain("justify-between");
  expect(html).toContain("text-left");
  expect(html).not.toContain("Try it now");
  expect(html).not.toContain("<h2");
  expect(html).toContain('title="movePromotionToSettings"');
});

test("uses the wide image on the settings page", async () => {
  useSettingsPromoPlacementStore.setState({
    campaignId: "test-campaign",
    placement: "settings",
  });
  await renderCard("settings");

  expect(container.innerHTML).toContain("browser_en.png");
  expect(container.innerHTML).toContain("promo-card-fade-in");
  expect(container.innerHTML).not.toContain("browser_sidebar_en.png");
  expect(container.innerHTML).toContain("aspect-[16/9]");
  expect(container.innerHTML).toContain("bg-linear-to-t");
  expect(container.innerHTML).toContain("from-sidebar");
  expect(container.innerHTML).toContain("via-sidebar/80");
  expect(container.innerHTML).toContain("text-muted-foreground");
  expect(container.innerHTML).toContain("dark:text-foreground/90");
  expect(container.innerHTML.match(/dark:text-foreground\/90/g)).toHaveLength(
    2,
  );
  expect(container.innerHTML).not.toContain("mix-blend-difference");
  expect(container.innerHTML).toContain("Try it now");
  expect(container.innerHTML).not.toContain("dark:from-[");
});

test("preloads and decodes the image before mounting the fading card", async () => {
  autoCompletePreloads = false;
  useSettingsPromoPlacementStore.setState({
    campaignId: "test-campaign",
    placement: "settings",
  });
  await renderCard("settings");

  expect(preloadedImages).toHaveLength(1);
  expect(preloadedImages[0].src).toContain("browser_en.png");
  expect(container.innerHTML).toBe("");
  expect(container.querySelector(".promo-card-fade-in")).toBeNull();

  await act(async () => {
    preloadedImages[0].complete();
    await Promise.resolve();
  });

  expect(preloadedImages[0].decode).toHaveBeenCalledOnce();
  expect(container.querySelector("img")).not.toBeNull();
  expect(container.querySelector(".promo-card-fade-in")).not.toBeNull();
});

test("preloads the wide fallback when the sidebar image fails", async () => {
  autoCompletePreloads = false;
  await renderCard("sidebar");

  expect(preloadedImages).toHaveLength(1);
  expect(preloadedImages[0].src).toContain("browser_sidebar_en.png");

  await act(async () => {
    preloadedImages[0].fail();
    await Promise.resolve();
  });

  expect(preloadedImages).toHaveLength(2);
  expect(preloadedImages[1].src).toContain("browser_en.png");

  await act(async () => {
    preloadedImages[1].complete();
    await Promise.resolve();
  });

  expect(container.querySelector("img")?.src).toContain("browser_en.png");
  expect(container.querySelector(".promo-card-fade-in")).not.toBeNull();
});

test("does not reserve an empty card when the campaign is disabled", async () => {
  mocks.manifest.enabled = false;

  await renderCard("sidebar");

  expect(container.innerHTML).toBe("");
  expect(preloadedImages).toHaveLength(0);
});

test("opens the configured action from both the image and conversion button", async () => {
  useSettingsPromoPlacementStore.setState({
    campaignId: "test-campaign",
    placement: "settings",
  });
  await renderCard("settings");

  const promotion = container.querySelector<HTMLButtonElement>(
    'button[aria-label="<em>Capture media instantly</em>"]',
  );
  const conversionButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Try it now: <em>Capture media instantly</em>"]',
  );
  expect(promotion).not.toBeNull();
  expect(conversionButton).not.toBeNull();

  promotion?.click();
  conversionButton?.click();

  expect(mocks.open).toHaveBeenCalledTimes(2);
  expect(mocks.open).toHaveBeenNthCalledWith(
    1,
    "https://example.com/promotion",
  );
  expect(mocks.open).toHaveBeenNthCalledWith(
    2,
    "https://example.com/promotion",
  );
});

test("moves the promotion between the sidebar and settings", async () => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      createElement(
        "div",
        null,
        createElement(SettingsPromoCard, { placement: "sidebar" }),
        createElement(SettingsPromoCard, { placement: "settings" }),
      ),
    );
  });

  const moveToSettings = container.querySelector<HTMLButtonElement>(
    'button[title="movePromotionToSettings"]',
  );
  expect(moveToSettings).not.toBeNull();
  expect(
    container.querySelector('button[title="movePromotionToSidebar"]'),
  ).toBeNull();

  await act(async () => moveToSettings?.click());

  expect(container.innerHTML).toContain("promo-card-fade-out");
  expect(
    container.querySelector('button[title="movePromotionToSettings"]'),
  ).not.toBeNull();

  await act(async () => vi.advanceTimersByTime(180));

  expect(
    container.querySelector('button[title="movePromotionToSettings"]'),
  ).toBeNull();
  expect(
    container.querySelector('button[title="movePromotionToSidebar"]'),
  ).not.toBeNull();
  expect(storageValues.get("mediago:settings-promo-placement:v1")).toContain(
    '"placement":"settings"',
  );

  const moveToSidebar = container.querySelector<HTMLButtonElement>(
    'button[title="movePromotionToSidebar"]',
  );
  await act(async () => moveToSidebar?.click());

  expect(container.innerHTML).toContain("promo-card-fade-out");
  await act(async () => vi.advanceTimersByTime(180));

  expect(
    container.querySelector('button[title="movePromotionToSettings"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('button[title="movePromotionToSidebar"]'),
  ).toBeNull();
  expect(mocks.open).not.toHaveBeenCalled();
});

test("shows a new campaign in the sidebar by default", async () => {
  useSettingsPromoPlacementStore.setState({
    campaignId: "previous-campaign",
    placement: "settings",
  });

  await renderCard("sidebar");

  expect(container.innerHTML).toContain('title="movePromotionToSettings"');
});

test("falls back to settings when the sidebar is unavailable", async () => {
  sidebarMediaMatches = false;
  await renderCard("settings");

  expect(container.innerHTML).toContain("settingsPromotion");
  expect(container.innerHTML).not.toContain("movePromotionToSidebar");
});

test("moves immediately when reduced motion is enabled", async () => {
  reduceMotion = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      createElement(
        "div",
        null,
        createElement(SettingsPromoCard, { placement: "sidebar" }),
        createElement(SettingsPromoCard, { placement: "settings" }),
      ),
    );
  });

  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(
        'button[title="movePromotionToSettings"]',
      )
      ?.click();
  });

  expect(container.innerHTML).not.toContain("promo-card-fade-out");
  expect(
    container.querySelector('button[title="movePromotionToSidebar"]'),
  ).not.toBeNull();
});
