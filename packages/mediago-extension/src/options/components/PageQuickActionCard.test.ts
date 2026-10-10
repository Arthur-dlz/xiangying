// @vitest-environment happy-dom

import i18next, { type i18n } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { resources } from "../../i18n/resources";
import { PageQuickActionCard } from "./PageQuickActionCard";

let testI18n: i18n;
let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
  testI18n = i18next.createInstance();
  await testI18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources,
    interpolation: { escapeValue: false },
  });
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderCard(
  enabled: boolean,
  saving: boolean,
  onEnabledChange = vi.fn(),
) {
  await act(async () => {
    root.render(
      createElement(
        I18nextProvider,
        { i18n: testI18n },
        createElement(PageQuickActionCard, {
          enabled,
          saving,
          onEnabledChange,
        }),
      ),
    );
  });
  return onEnabledChange;
}

describe("PageQuickActionCard", () => {
  test("renders the enabled preference and dispatches the switch callback", async () => {
    const onEnabledChange = await renderCard(true, false);
    const card = container.querySelector<HTMLElement>(
      '[data-card="page-quick-action"]',
    );
    const label = container.querySelector<HTMLLabelElement>(
      'label[for="page-quick-action-enabled"]',
    );
    const control = container.querySelector<HTMLButtonElement>(
      "#page-quick-action-enabled",
    );

    expect(card?.textContent).toContain("Page shortcut");
    expect(card?.textContent).toContain(
      "Show “Add to MediaGo” in the top-right corner of supported pages.",
    );
    expect(label?.className).toContain("cursor-pointer");
    expect(control?.getAttribute("aria-checked")).toBe("true");

    await act(async () => control?.click());
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  test("announces saving and blocks interaction with a not-allowed cursor", async () => {
    const onEnabledChange = await renderCard(true, true);
    const card = container.querySelector<HTMLElement>(
      '[data-card="page-quick-action"]',
    );
    const label = container.querySelector<HTMLLabelElement>(
      'label[for="page-quick-action-enabled"]',
    );
    const control = container.querySelector<HTMLButtonElement>(
      "#page-quick-action-enabled",
    );

    expect(card?.getAttribute("aria-busy")).toBe("true");
    expect(card?.querySelector('[aria-label="Saving"]')).not.toBeNull();
    expect(label?.className).toContain("cursor-not-allowed");
    expect(label?.className).not.toContain("cursor-pointer");
    expect(control?.disabled).toBe(true);

    await act(async () => control?.click());
    expect(onEnabledChange).not.toHaveBeenCalled();
  });
});
