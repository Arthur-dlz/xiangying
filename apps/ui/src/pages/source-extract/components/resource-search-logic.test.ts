import { describe, expect, it } from "vitest";
import type { ResourceSearchItem } from "@mediago/common";
import {
  appendUniqueSearchItems,
  createRequestSequence,
  displayResourceValue,
} from "./resource-search-logic";

const item = (id: string, providerId = "p1"): ResourceSearchItem => ({
  id,
  providerId,
  providerName: providerId,
  title: id,
  episodes: [],
});

describe("resource search logic", () => {
  it("appends later pages without duplicating provider results", () => {
    expect(
      appendUniqueSearchItems(
        [item("a")],
        [item("a"), item("a", "p2"), item("b")],
      ),
    ).toEqual([item("a"), item("a", "p2"), item("b")]);
  });

  it("invalidates responses from an earlier query", () => {
    const requests = createRequestSequence();
    const oldRequest = requests.next();
    const latestRequest = requests.next();
    expect(requests.isCurrent(oldRequest)).toBe(false);
    expect(requests.isCurrent(latestRequest)).toBe(true);
  });

  it("renders absent metadata as unknown", () => {
    expect(displayResourceValue(" ")).toBe("未知");
    expect(displayResourceValue("1080P")).toBe("1080P");
  });
});
