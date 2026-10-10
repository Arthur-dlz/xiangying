import { DownloadType } from "@mediago/common";
import i18next, { type i18n } from "i18next";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { resources } from "../i18n/resources";
import type {
  DetectedSource,
  ExtensionSettings,
  ServerStatus,
} from "../shared/types";
import { PopupView, type PopupViewProps } from "./popup-view";

const popupViewSource = readFileSync(
  new URL("./popup-view.tsx", import.meta.url),
  "utf8",
);
const statusBadgeSource = readFileSync(
  new URL("./components/StatusBadge.tsx", import.meta.url),
  "utf8",
);
const stylesheet = readFileSync(
  new URL("../styles/globals.css", import.meta.url),
  "utf8",
);

const settings: ExtensionSettings = {
  mode: "desktop-http",
  serverUrl: "",
  apiKey: "",
  downloadNow: false,
  language: "en",
  pageQuickActionEnabled: true,
};

const connected: ServerStatus = { ok: true, message: "Connected" };

const source: DetectedSource = {
  id: "source-1",
  url: "https://cdn.example.com/master.m3u8",
  documentURL: "https://example.com/watch",
  name: "Launch film",
  type: DownloadType.m3u8,
  detectedAt: 1,
  mediaInfo: {
    status: "ready",
    playlistType: "master",
    maxQuality: "1080p",
    variants: [],
  },
};

const actions = {
  onRetry: vi.fn(),
  onClear: vi.fn(),
  onImportAll: vi.fn(),
  onImport: vi.fn(),
  onOpenSettings: vi.fn(),
  onReloadPage: vi.fn(),
};

let testI18n: i18n;

beforeAll(async () => {
  testI18n = i18next.createInstance();
  await testI18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources,
    interpolation: { escapeValue: false },
  });
});

function renderPopup(overrides: Partial<PopupViewProps> = {}): string {
  const props: PopupViewProps = {
    tab: {
      id: 12,
      title: "A useful page",
      url: "https://example.com/watch",
    },
    sources: [],
    settings,
    serverStatus: connected,
    loading: false,
    loadError: null,
    importing: false,
    ...actions,
    ...overrides,
  };

  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: testI18n },
      createElement(PopupView, props),
    ),
  );
}

describe("PopupView states", () => {
  it("announces loading and renders a busy skeleton", () => {
    const html = renderPopup({ loading: true });

    expect(html).toContain('data-popup-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Scanning this page");
  });

  it("offers retry when popup data fails to load", () => {
    const html = renderPopup({ loadError: "Could not read extension data" });

    expect(html).toContain('data-popup-state="load-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load resources");
    expect(html).toContain("Could not read extension data");
    expect(html).toContain('data-action="retry"');
    expect(html).toContain("Try again");
  });

  it("shows a stable unavailable badge when initial loading fails", () => {
    const html = renderPopup({
      loadError: "Could not read extension data",
      settings: null,
      serverStatus: null,
    });

    expect(html).toContain('data-status="unavailable"');
    expect(html).toContain("Status unavailable");
    expect(html).not.toContain("Detecting");
  });

  it("routes an unconfigured Docker mode to settings", () => {
    const html = renderPopup({
      settings: { ...settings, mode: "docker-http", serverUrl: "" },
      serverStatus: { ok: false, message: "Missing server" },
    });

    expect(html).toContain('data-popup-state="needs-setup"');
    expect(html).toContain("Finish connection setup");
    expect(html).toContain('data-action="open-settings"');
    expect(html).toContain("Open connection settings");
  });

  it("routes a failed configured connection to settings", () => {
    const html = renderPopup({
      settings: {
        ...settings,
        mode: "docker-http",
        serverUrl: "https://mediago.example.com",
      },
      serverStatus: { ok: false, message: "Timed out" },
    });

    expect(html).toContain('data-popup-state="connection-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("MediaGo is offline");
    expect(html).toContain("Timed out");
    expect(html).toContain('data-action="open-settings"');
  });

  it("keeps the radar empty state and offers a page reload", () => {
    const html = renderPopup();

    expect(html).toContain('data-popup-state="empty"');
    expect(html).toContain("No downloadable resources detected");
    expect(html).toContain('data-empty-illustration="radar"');
    expect(html).toContain('data-action="reload-page"');
    expect(html).toContain("Reload current page");
  });

  it("renders detected resources as a semantic list with compact actions", () => {
    const html = renderPopup({ sources: [source] });

    expect(html).toContain('data-popup-state="ready"');
    expect(html).toContain("1 resource detected");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("Launch film");
    expect(html).toContain("HLS");
    expect(html).toContain("1080p");
    expect(html).toContain('data-action="import-source"');
    expect(html).toContain("Import all (1)");
    expect(html).toContain('aria-label="Clear detected resources"');
  });

  it("disables import actions and announces progress while importing", () => {
    const html = renderPopup({ sources: [source], importing: true });

    expect(html).toContain('data-popup-state="ready"');
    expect(html).toContain('data-importing="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Importing resources");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Popup English copy", () => {
  it("does not expose em dashes in popup-rendered namespaces", () => {
    const english = resources.en.translation;
    const popupCopy = {
      popup: english.popup,
      status: english.status,
      empty: english.empty,
      source: english.source,
      errors: english.errors,
    };

    expect(JSON.stringify(popupCopy)).not.toContain("—");
  });
});

describe("Popup brand header contrast", () => {
  it("keeps small header copy and the inverted status surface at WCAG AA", () => {
    expect(popupViewSource).not.toContain("text-white/90");
    expect(popupViewSource).not.toContain("blur-2xl");
    expect(popupViewSource).toMatch(
      /<p className="[^"]*\btext-white\b[^"]*">\s*\{t\("popup\.workspaceLabel"\)\}/,
    );
    expect(statusBadgeSource).toContain("bg-black/35");
    expect(statusBadgeSource).not.toContain("bg-white/12");

    const white = "#ffffff";
    const actionColors = [
      cssHexVariable(cssRule(":root"), "action"),
      cssHexVariable(cssRule(".dark"), "action"),
    ];

    for (const action of actionColors) {
      expect(contrastRatio(action, white)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(compositeOverBlack(action, 0.35), white),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(
    new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!match?.[1]) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

function cssHexVariable(rule: string, name: string): string {
  const value = rule.match(
    new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"),
  )?.[1];
  if (!value) throw new Error(`Missing hexadecimal --${name}`);
  return value;
}

function compositeOverBlack(hex: string, foregroundOpacity: number): string {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) =>
      Math.round(Number.parseInt(channel, 16) * (1 - foregroundOpacity)),
    );
  if (!channels) throw new Error(`Invalid color ${hex}`);
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  if (!channels) throw new Error(`Invalid color ${hex}`);
  const [red, green, blue] = channels;
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
