import { beforeEach, describe, expect, it } from "vitest";
import { useDownloadStore } from "./download";

describe("download progress store", () => {
  beforeEach(() => {
    useDownloadStore.setState({ count: 0, events: [], eventsMap: new Map() });
  });

  it("keeps a detected live flag sticky across later progress updates", () => {
    const store = useDownloadStore.getState();
    store.setEvents([
      {
        id: 7,
        percent: "10",
        speed: "1 MB/s",
        isLive: true,
        startedAt: "2026-08-27T07:20:00.000Z",
      },
    ]);
    store.setEvents([
      {
        id: 7,
        percent: "20",
        speed: "2 MB/s",
        isLive: false,
      },
    ]);

    expect(useDownloadStore.getState().eventsMap.get("7")).toMatchObject({
      percent: "0",
      speed: "2.00 MB/s",
      isLive: true,
      startedAt: "2026-08-27T07:20:00.000Z",
    });
  });

  it("normalizes downloader-specific speed formats", () => {
    useDownloadStore.getState().setEvents([
      {
        id: 8,
        percent: "50",
        speed: "1.55MBps",
        isLive: false,
      },
    ]);

    expect(useDownloadStore.getState().eventsMap.get("8")).toMatchObject({
      percent: "50",
      speed: "1.55 MB/s",
    });
  });
});
