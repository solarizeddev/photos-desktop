/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect, vi } from "vitest";
import {
  ArrivingVideo,
  OpenVideos,
  downloadVideo,
  parseRange,
  releaseUnusedDownloader,
  videoFromBytes,
} from "./videoStream.ts";

const live = () => new AbortController().signal;

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of gen) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

const FILE = Buffer.from(Array.from({ length: 700_000 }, (_, i) => i % 251));

/**
 * The SDK's download queue and a downloader of `bytes`, modelled as the SDK has them: the
 * slot is taken when the downloader is made and given back only in the `finally` of a
 * download, which stops at the next block once its signal fires.
 */
function sdk(bytes: Buffer, block = 100_000) {
  const queue = { inUse: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const auto = { on: true };
  function downloader(signal: AbortSignal) {
    queue.inUse++;
    return {
      getClaimedSizeInBytes: () => bytes.length,
      downloadToStream(sink: WritableStream<Uint8Array>) {
        const completion = (async () => {
          const writer = sink.getWriter();
          try {
            for (let at = 0; at < bytes.length; at += block) {
              if (!auto.on) await gate;
              if (signal.aborted) throw new Error("aborted");
              await writer.write(bytes.subarray(at, at + block));
              await new Promise((r) => setTimeout(r, 1));
            }
            await writer.close();
          } finally {
            queue.inUse--;
          }
        })();
        return { completion: () => completion, isDownloadCompleteWithSignatureIssues: () => false };
      },
    };
  }
  return { queue, downloader, hold: () => (auto.on = false), go: () => release() };
}

describe("a Range header", () => {
  it("reads a start and an end, a start alone, and the last n bytes", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("keeps an end past the file to the file, and serves the first of several ranges", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-9, 20-29", 1000)).toEqual({ start: 0, end: 9 });
  });

  it("answers the whole file for none, or one it does not read", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("items=0-9", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("bytes=9-3", 1000)).toBeNull();
  });

  it("is unsatisfiable past the end", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });
});

describe("a video kept on this computer", () => {
  it("is sliced", async () => {
    const v = videoFromBytes(FILE, "video/mp4");
    expect((await collect(v.read(1000, 400_000, live()))).equals(FILE.subarray(1000, 400_001))).toBe(true);
  });
});

describe("a video still arriving", () => {
  it("answers what is here at once and waits for the rest", async () => {
    const v = new ArrivingVideo(10, "video/mp4");
    v.append(Buffer.from([0, 1, 2, 3]));
    const reading = collect(v.read(2, 7, live()));
    await new Promise((r) => setTimeout(r, 5));
    v.append(Buffer.from([4, 5, 6, 7, 8, 9]));
    expect([...(await reading)]).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("throws when the file ends short of a range, so the answer is cut", async () => {
    const v = new ArrivingVideo(10, "video/mp4");
    v.append(Buffer.from([0, 1, 2]));
    v.end(true);
    await expect(collect(v.read(0, 9, live()))).rejects.toThrow("shorter");
  });

  it("drops bytes past the stated size", async () => {
    const v = new ArrivingVideo(3, "video/mp4");
    v.append(Buffer.from([0, 1, 2, 3, 4]));
    expect(v.arrived()).toBe(3);
  });

  it("stops a read under way when it is closed, and serves nothing after", async () => {
    let closed = 0;
    const v = new ArrivingVideo(10, "video/mp4", () => closed++);
    v.append(Buffer.from([0, 1]));
    const reading = collect(v.read(0, 9, live()));
    await new Promise((r) => setTimeout(r, 5));
    v.close();
    await expect(reading).rejects.toThrow("stopped");
    await expect(collect(v.read(0, 1, live()))).rejects.toThrow();
    expect(closed).toBe(1);
  });

  it("ends a waiting read quietly when the player goes", async () => {
    const v = new ArrivingVideo(10, "video/mp4");
    const gone = new AbortController();
    const reading = collect(v.read(0, 9, gone.signal));
    gone.abort();
    expect((await reading).length).toBe(0);
  });
});

describe("downloading a video to play", () => {
  it("plays from the first bytes, and gives the download slot back when done", async () => {
    const s = sdk(FILE);
    const stop = new AbortController();
    const v = downloadVideo(s.downloader(stop.signal), FILE.length, "video/mp4", stop);
    expect(s.queue.inUse).toBe(1);
    expect((await collect(v.read(0, 99, live()))).equals(FILE.subarray(0, 100))).toBe(true);
    expect((await collect(v.read(600_000, FILE.length - 1, live()))).equals(FILE.subarray(600_000))).toBe(true);
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
  });

  it("gives the slot back when closed before the download is done", async () => {
    const s = sdk(FILE);
    s.hold();
    const stop = new AbortController();
    const v = downloadVideo(s.downloader(stop.signal), FILE.length, "video/mp4", stop);
    v.close();
    s.go();
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
  });

  it("gives back the slot of a downloader that is not used", async () => {
    const s = sdk(FILE);
    const stop = new AbortController();
    releaseUnusedDownloader(s.downloader(stop.signal), stop);
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
  });

  it("never holds more than one slot per video, however many videos are played one after another", async () => {
    const s = sdk(FILE);
    const open = new OpenVideos(async () => {
      const stop = new AbortController();
      return downloadVideo(s.downloader(stop.signal), FILE.length, "video/mp4", stop);
    });
    for (let i = 0; i < 12; i++) {
      const v = (await open.get(`v${i}`))!;
      await collect(v.read(0, 999, live()));
    }
    open.clear();
    await vi.waitFor(() => expect(s.queue.inUse).toBe(0));
  });
});

describe("the videos kept open", () => {
  it("opens a video once for all its ranges", async () => {
    let opens = 0;
    const open = new OpenVideos(async () => {
      opens++;
      return videoFromBytes(FILE, "video/mp4");
    });
    const [a, b] = await Promise.all([open.get("u"), open.get("u")]);
    expect(a).toBe(b);
    await open.get("u");
    expect(opens).toBe(1);
    open.clear();
  });

  it("closes the oldest past two, and every one at clear", async () => {
    const closed: string[] = [];
    const open = new OpenVideos(async (uid) => ({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed.push(uid) }));
    await open.get("a");
    await open.get("b");
    await open.get("c");
    await vi.waitFor(() => expect(closed).toEqual(["a"]));
    open.clear();
    await vi.waitFor(() => expect(closed.sort()).toEqual(["a", "b", "c"]));
  });

  it("closes a video left idle, but not one still being read", async () => {
    let now = 0;
    const closed: string[] = [];
    const open = new OpenVideos(
      async (uid) => ({ ...videoFromBytes(FILE, "video/mp4"), close: () => closed.push(uid) }),
      () => now,
      1000,
    );
    const playing = (await open.get("playing"))!;
    await open.get("left");
    now = 900;
    await collect(playing.read(0, 10, live()));
    now = 1500;
    open.closeIdle();
    await vi.waitFor(() => expect(closed).toEqual(["left"]));
    expect(open.size()).toBe(1);
    open.clear();
  });

  it("tries again for one that could not be opened", async () => {
    let opens = 0;
    const open = new OpenVideos(async () => {
      opens++;
      if (opens === 1) throw new Error("network");
      return videoFromBytes(FILE, "video/mp4");
    });
    expect(await open.get("u")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(await open.get("u")).not.toBeNull();
    open.clear();
  });
});
