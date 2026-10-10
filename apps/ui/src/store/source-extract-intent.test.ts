import { beforeEach, expect, test } from "vitest";
import { useSourceExtractIntentStore } from "./source-extract-intent";

beforeEach(() => useSourceExtractIntentStore.getState().clear());

test("stores a source extraction URL and consumes it once", () => {
  useSourceExtractIntentStore.getState().openURL(" https://example.com/watch ");
  expect(useSourceExtractIntentStore.getState().consume()).toBe(
    "https://example.com/watch",
  );
  expect(useSourceExtractIntentStore.getState().consume()).toBeUndefined();
});
